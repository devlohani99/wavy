import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

const SHAPE_TOOLS = new Set(['rectangle', 'square', 'circle', 'triangle']);
const ARROW_TOOLS = new Set(['arrow-up', 'arrow-down', 'arrow-left', 'arrow-right']);

const drawStroke = (ctx, { x, y, prevX, prevY, color, lineWidth, tool }) => {
  if (!ctx) {
    return;
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineWidth;
  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
  }
  ctx.beginPath();
  ctx.moveTo(prevX ?? x, prevY ?? y);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.restore();
};

const drawShape = (ctx, payload) => {
  if (!ctx) {
    return;
  }
  const { startX, startY, endX, endY, color, lineWidth, shape } = payload;
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  const width = Math.abs(endX - startX);
  const height = Math.abs(endY - startY);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';

  if (shape === 'rectangle') {
    ctx.strokeRect(x, y, width, height);
  } else if (shape === 'square') {
    const size = Math.min(width, height);
    ctx.strokeRect(x, y, size, size);
  } else if (shape === 'circle') {
    const centerX = (startX + endX) / 2;
    const centerY = (startY + endY) / 2;
    const radius = Math.sqrt(width * width + height * height) / 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape === 'triangle') {
    const leftX = Math.min(startX, endX);
    const rightX = Math.max(startX, endX);
    const baseY = Math.max(startY, endY);
    const apexY = Math.min(startY, endY);
    const apexX = (leftX + rightX) / 2;
    ctx.beginPath();
    ctx.moveTo(leftX, baseY);
    ctx.lineTo(rightX, baseY);
    ctx.lineTo(apexX, apexY);
    ctx.closePath();
    ctx.stroke();
  }

  ctx.restore();
};

const drawArrow = (ctx, payload) => {
  if (!ctx) {
    return;
  }
  const { startX, startY, endX, endY, color, lineWidth, direction } = payload;
  let fromX = startX;
  let fromY = startY;
  let toX = endX;
  let toY = endY;

  if (direction === 'arrow-up') {
    fromX = startX;
    toX = startX;
    fromY = Math.max(startY, endY);
    toY = Math.min(startY, endY);
  } else if (direction === 'arrow-down') {
    fromX = startX;
    toX = startX;
    fromY = Math.min(startY, endY);
    toY = Math.max(startY, endY);
  } else if (direction === 'arrow-left') {
    fromY = startY;
    toY = startY;
    fromX = Math.max(startX, endX);
    toX = Math.min(startX, endX);
  } else if (direction === 'arrow-right') {
    fromY = startY;
    toY = startY;
    fromX = Math.min(startX, endX);
    toX = Math.max(startX, endX);
  }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  const headLength = 12 + lineWidth * 1.5;
  const angle = Math.atan2(toY - fromY, toX - fromX);
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLength * Math.cos(angle - Math.PI / 6),
    toY - headLength * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    toX - headLength * Math.cos(angle + Math.PI / 6),
    toY - headLength * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
};

const Canvas = forwardRef(({ socket, roomId, selectedTool, color, brushSize }, ref) => {
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const isDrawingRef = useRef(false);
  const startPointRef = useRef({ x: 0, y: 0 });
  const lastPointRef = useRef({ x: 0, y: 0 });

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  useImperativeHandle(ref, () => ({
    clearCanvas,
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const context = canvas.getContext('2d');
    ctxRef.current = context;

    const setCanvasSize = () => {
      const parent = canvas.parentElement;
      const { width, height } = parent?.getBoundingClientRect() || canvas.getBoundingClientRect();
      if (!width || !height) {
        return;
      }
      let snapshot = null;
      if (canvas.width && canvas.height) {
        try {
          snapshot = context.getImageData(0, 0, canvas.width, canvas.height);
        } catch (err) {
          console.warn('Unable to snapshot canvas before resize', err);
        }
      }
      canvas.width = width;
      canvas.height = height;
      if (snapshot) {
        context.putImageData(snapshot, 0, 0);
      }
    };

    setCanvasSize();
    let resizeObserver;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(setCanvasSize);
      resizeObserver.observe(canvas.parentElement || canvas);
    } else {
      window.addEventListener('resize', setCanvasSize);
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener('resize', setCanvasSize);
      }
    };
  }, []);

  const getRelativePoint = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const clientX = event.touches?.[0]?.clientX ?? event.clientX;
    const clientY = event.touches?.[0]?.clientY ?? event.clientY;
    if (clientX == null || clientY == null) {
      return null;
    }
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const emitStroke = (payload) => {
    if (!socket || !roomId) {
      return;
    }
    socket.emit('draw', { roomId, ...payload });
  };

  const emitShape = (payload) => {
    if (!socket || !roomId) {
      return;
    }
    socket.emit('shape-draw', { roomId, ...payload });
  };

  const emitArrow = (payload) => {
    if (!socket || !roomId) {
      return;
    }
    socket.emit('arrow-draw', { roomId, ...payload });
  };

  const handlePointerDown = (event) => {
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    const point = getRelativePoint(event);
    if (!point) {
      return;
    }
    isDrawingRef.current = true;
    startPointRef.current = point;
    lastPointRef.current = point;
  };

  const handlePointerMove = (event) => {
    if (!isDrawingRef.current) {
      return;
    }
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    if (!ctxRef.current) {
      return;
    }
    const point = getRelativePoint(event);
    if (!point) {
      return;
    }

    if (selectedTool === 'pencil' || selectedTool === 'eraser') {
      const strokePayload = {
        x: point.x,
        y: point.y,
        prevX: lastPointRef.current.x,
        prevY: lastPointRef.current.y,
        color,
        lineWidth: brushSize,
        tool: selectedTool,
      };
      drawStroke(ctxRef.current, strokePayload);
      emitStroke(strokePayload);
      lastPointRef.current = point;
    }
  };

  const handlePointerUp = (event) => {
    if (!isDrawingRef.current) {
      return;
    }
    if (event?.pointerType === 'touch') {
      event.preventDefault();
    }
    isDrawingRef.current = false;
    if (!ctxRef.current) {
      return;
    }
    const point = getRelativePoint(event) || lastPointRef.current;
    if (!point) {
      return;
    }

    if (SHAPE_TOOLS.has(selectedTool)) {
      const shapePayload = {
        startX: startPointRef.current.x,
        startY: startPointRef.current.y,
        endX: point.x,
        endY: point.y,
        color,
        lineWidth: brushSize,
        shape: selectedTool,
      };
      drawShape(ctxRef.current, shapePayload);
      emitShape(shapePayload);
    } else if (ARROW_TOOLS.has(selectedTool)) {
      const arrowPayload = {
        startX: startPointRef.current.x,
        startY: startPointRef.current.y,
        endX: point.x,
        endY: point.y,
        color,
        lineWidth: brushSize,
        direction: selectedTool,
      };
      drawArrow(ctxRef.current, arrowPayload);
      emitArrow(arrowPayload);
    }
  };

  useEffect(() => {
    if (!socket) {
      return undefined;
    }
    const handleRemoteDraw = (payload) => drawStroke(ctxRef.current, payload);
    const handleRemoteShape = (payload) => drawShape(ctxRef.current, payload);
    const handleRemoteArrow = (payload) => drawArrow(ctxRef.current, payload);
    const handleRemoteClear = () => clearCanvas();

    socket.on('draw', handleRemoteDraw);
    socket.on('shape-draw', handleRemoteShape);
    socket.on('arrow-draw', handleRemoteArrow);
    socket.on('clear-canvas', handleRemoteClear);

    return () => {
      socket.off('draw', handleRemoteDraw);
      socket.off('shape-draw', handleRemoteShape);
      socket.off('arrow-draw', handleRemoteArrow);
      socket.off('clear-canvas', handleRemoteClear);
    };
  }, [socket]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full rounded-2xl bg-slate-950/40 border border-white/10 touch-none cursor-crosshair"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
});

Canvas.displayName = 'Canvas';

export default Canvas;
