import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import Canvas from '../components/Canvas.jsx';
import apiClient from '../lib/apiClient.js';

const TOOL_GROUPS = [
  {
    label: 'Sketch',
    items: [
      { id: 'pencil', label: 'Pencil' },
      { id: 'eraser', label: 'Eraser' },
    ],
  },
  {
    label: 'Shapes',
    items: [
      { id: 'rectangle', label: 'Rectangle' },
      { id: 'square', label: 'Square' },
      { id: 'circle', label: 'Circle' },
      { id: 'triangle', label: 'Triangle' },
    ],
  },
  {
    label: 'Arrows',
    items: [
      { id: 'arrow-up', label: 'Arrow Up' },
      { id: 'arrow-down', label: 'Arrow Down' },
      { id: 'arrow-left', label: 'Arrow Left' },
      { id: 'arrow-right', label: 'Arrow Right' },
    ],
  },
];

const COLOR_PRESETS = ['#38bdf8', '#f87171', '#facc15', '#a855f7', '#22c55e', '#f97316'];

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

const Room = () => {
  const { roomId: roomParam } = useParams();
  const roomId = (roomParam || '').trim().toUpperCase();
  const navigate = useNavigate();

  const [status, setStatus] = useState('loading');
  const [roomInfo, setRoomInfo] = useState(null);
  const [userCount, setUserCount] = useState(0);
  const [error, setError] = useState('');
  const [selectedTool, setSelectedTool] = useState('pencil');
  const [color, setColor] = useState('#38bdf8');
  const [brushSize, setBrushSize] = useState(4);
  const [isMuted, setIsMuted] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [socketState, setSocketState] = useState('connecting');
  const [copyFeedback, setCopyFeedback] = useState('');

  const socketRef = useRef(null);
  const canvasRef = useRef(null);
  const peersRef = useRef(new Map());
  const audioElementsRef = useRef(new Map());
  const audioContainerRef = useRef(null);
  const localStreamRef = useRef(null);
  const streamPromiseRef = useRef(null);

  const isRoomIdValid = useMemo(() => /^[A-Z0-9]{8}$/.test(roomId), [roomId]);

  const detachRemoteStream = useCallback((peerId) => {
    const audioEl = audioElementsRef.current.get(peerId);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
      audioElementsRef.current.delete(peerId);
    }
  }, []);

  const attachRemoteStream = useCallback(
    (peerId, stream) => {
      if (!audioContainerRef.current) {
        return;
      }
      let audioEl = audioElementsRef.current.get(peerId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.dataset.peer = peerId;
        audioContainerRef.current.appendChild(audioEl);
        audioElementsRef.current.set(peerId, audioEl);
      }
      audioEl.srcObject = stream;
      const playPromise = audioEl.play();
      if (playPromise?.catch) {
        playPromise.catch((err) => {
          console.warn('Remote audio playback blocked', err);
        });
      }
    },
    [],
  );

  const destroyPeerConnection = useCallback(
    (peerId) => {
      const peerEntry = peersRef.current.get(peerId);
      if (peerEntry) {
        try {
          peerEntry.pc.close();
        } catch (err) {
          console.warn('Unable to close peer connection', err);
        }
        peersRef.current.delete(peerId);
      }
      detachRemoteStream(peerId);
    },
    [detachRemoteStream],
  );

  const createPeerConnection = useCallback(
    (peerId) => {
      const existingPeer = peersRef.current.get(peerId);
      if (existingPeer) {
        return existingPeer.pc;
      }

      const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const localStream = localStreamRef.current;
      if (localStream) {
        localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
      }

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit('ice-candidate', { targetId: peerId, candidate: event.candidate });
        }
      };

      peerConnection.ontrack = ({ streams }) => {
        const [remoteStream] = streams;
        if (remoteStream) {
          attachRemoteStream(peerId, remoteStream);
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
          destroyPeerConnection(peerId);
        }
      };

      peersRef.current.set(peerId, { pc: peerConnection });
      return peerConnection;
    },
    [attachRemoteStream, destroyPeerConnection],
  );

  const cleanupMedia = useCallback(() => {
    peersRef.current.forEach(({ pc }) => {
      try {
        pc.close();
      } catch (err) {
        console.warn('Peer cleanup failed', err);
      }
    });
    peersRef.current.clear();
    audioElementsRef.current.forEach((audioEl) => {
      audioEl.srcObject = null;
      audioEl.remove();
    });
    audioElementsRef.current.clear();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    streamPromiseRef.current = null;
  }, []);

  const ensureLocalStream = useCallback(async () => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }
    if (!navigator?.mediaDevices?.getUserMedia) {
      setVoiceError('This browser does not support microphone access.');
      throw new Error('MediaDevices unavailable');
    }
    if (!streamPromiseRef.current) {
      streamPromiseRef.current = navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          localStreamRef.current = stream;
          setVoiceError('');
          const [track] = stream.getAudioTracks();
          if (track) {
            track.enabled = true;
            setIsMuted(false);
          }
          return stream;
        })
        .catch((err) => {
          const friendlyMessage = err?.name === 'NotAllowedError'
            ? 'Microphone permission denied. Voice chat will be muted.'
            : 'Unable to access microphone.';
          setVoiceError(friendlyMessage);
          throw err;
        });
    }
    return streamPromiseRef.current;
  }, []);

  useEffect(() => {
    if (!roomId) {
      setStatus('error');
      setError('Missing room ID.');
      return;
    }
    if (!isRoomIdValid) {
      setStatus('error');
      setError('Room IDs are 8 uppercase characters.');
      return;
    }
    let isMounted = true;
    setStatus('loading');
    setError('');

    apiClient
      .get(`/api/rooms/${roomId}`)
      .then(({ data }) => {
        if (!isMounted) {
          return;
        }
        setRoomInfo(data);
        setUserCount(data?.users?.length ?? 0);
        setStatus('ready');
      })
      .catch((err) => {
        if (!isMounted) {
          return;
        }
        setError(err.message || 'Room not found.');
        setStatus('error');
      });

    return () => {
      isMounted = false;
    };
  }, [roomId, isRoomIdValid]);

  useEffect(() => {
    if (status !== 'ready') {
      return undefined;
    }

    const backendUrl = import.meta.env.VITE_BACKEND_URL || window.location.origin;
    const socket = io(backendUrl, {
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: true,
    });

    socketRef.current = socket;

    const joinRoom = () => socket.emit('join-room', { roomId });

    socket.on('connect', () => {
      setSocketState('connected');
      joinRoom();
      ensureLocalStream().catch(() => {});
    });

    socket.on('disconnect', () => {
      setSocketState('disconnected');
    });

    socket.io.on('reconnect_attempt', () => setSocketState('reconnecting'));
    socket.io.on('reconnect', () => {
      setSocketState('connected');
      joinRoom();
    });

    socket.on('room-error', ({ message }) => {
      setError(message || 'Failed to join room.');
    });

    socket.on('user-count-update', ({ count }) => {
      setUserCount(count);
    });

    socket.on('user-left', ({ socketId }) => {
      destroyPeerConnection(socketId);
    });

    socket.on('existing-users', async ({ users = [] }) => {
      if (!users.length) {
        return;
      }
      try {
        await ensureLocalStream();
      } catch (err) {
        console.warn('Mic access is required for full experience', err);
        return;
      }
      for (const targetId of users) {
        try {
          const peerConnection = createPeerConnection(targetId);
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          socket.emit('offer', { targetId, offer });
        } catch (err) {
          console.error('Failed to create offer', err);
        }
      }
    });

    const handleOffer = async ({ fromId, offer }) => {
      try {
        await ensureLocalStream();
        const peerConnection = createPeerConnection(fromId);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { targetId: fromId, answer });
      } catch (err) {
        console.error('Error handling offer', err);
      }
    };

    const handleAnswer = async ({ fromId, answer }) => {
      const peerEntry = peersRef.current.get(fromId);
      if (!peerEntry) {
        return;
      }
      try {
        await peerEntry.pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('Error applying remote answer', err);
      }
    };

    const handleIceCandidate = ({ fromId, candidate }) => {
      const peerEntry = peersRef.current.get(fromId);
      if (!peerEntry || !candidate) {
        return;
      }
      peerEntry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
        console.warn('Failed to add ICE candidate', err);
      });
    };

    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);

    return () => {
      socket.off('offer', handleOffer);
      socket.off('answer', handleAnswer);
      socket.off('ice-candidate', handleIceCandidate);
      socket.disconnect();
      socketRef.current = null;
      setSocketState('disconnected');
      cleanupMedia();
    };
  }, [status, roomId, ensureLocalStream, createPeerConnection, destroyPeerConnection, cleanupMedia]);

  const handleLeaveRoom = useCallback(
    (shouldNavigate = true) => {
      socketRef.current?.emit('leave-room');
      socketRef.current?.disconnect();
      socketRef.current = null;
      cleanupMedia();
      if (shouldNavigate) {
        navigate('/');
      }
    },
    [cleanupMedia, navigate],
  );

  useEffect(
    () => () => {
      handleLeaveRoom(false);
    },
    [handleLeaveRoom],
  );

  const handleClearCanvas = () => {
    canvasRef.current?.clearCanvas();
    socketRef.current?.emit('clear-canvas', { roomId });
  };

  const handleCopyLink = async () => {
    try {
      const shareUrl = `${window.location.origin}/room/${roomId}`;
      await navigator.clipboard.writeText(shareUrl);
      setCopyFeedback('Link copied to clipboard');
      setTimeout(() => setCopyFeedback(''), 2000);
    } catch (err) {
      setCopyFeedback('Unable to copy link');
    }
  };

  const handleMuteToggle = async () => {
    try {
      const stream = await ensureLocalStream();
      const [track] = stream.getAudioTracks();
      if (track) {
        track.enabled = !track.enabled;
        setIsMuted(!track.enabled);
      }
    } catch (err) {
      console.warn('Cannot toggle mute without microphone access', err);
    }
  };

  const socketIndicatorClasses = useMemo(() => {
    if (socketState === 'connected') {
      return 'bg-emerald-400 shadow-emerald-500/40';
    }
    if (socketState === 'reconnecting') {
      return 'bg-amber-400 shadow-amber-500/40';
    }
    return 'bg-rose-400 shadow-rose-500/40';
  }, [socketState]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-100">
        <div className="h-16 w-16 animate-spin rounded-full border-4 border-white/10 border-t-sky-500" />
        <p className="text-slate-400">Preparing your room...</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-slate-950 text-center text-slate-100 px-6">
        <div>
          <p className="text-3xl font-semibold">Unable to open this room.</p>
          <p className="mt-3 text-slate-400">{error || 'Please verify the link and try again.'}</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-full border border-white/20 px-6 py-3 text-base font-medium text-white hover:bg-white/10"
        >
          Back to home
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-950 text-slate-100 flex flex-col overflow-hidden">
      <header className="border-b border-white/10 px-4 py-4 md:px-8 flex flex-wrap items-center gap-4 justify-between shrink-0">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Room</p>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-2xl font-semibold tracking-widest">{roomId}</span>
            <button
              type="button"
              onClick={handleCopyLink}
              className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.3em] text-slate-200 hover:bg-white/10"
            >
              Copy link
            </button>
          </div>
          {copyFeedback && <p className="mt-1 text-xs text-slate-400">{copyFeedback}</p>}
        </div>
        <div className="flex flex-col items-end gap-2 text-right">
          <div className="flex items-center gap-2 text-sm text-slate-300">
            <span className={`h-2.5 w-2.5 rounded-full ${socketIndicatorClasses} shadow-md`} />
            <span className="uppercase tracking-[0.3em] text-xs">{socketState}</span>
          </div>
          <p className="text-lg font-medium">Users online: {userCount}</p>
          {roomInfo?.createdAt && (
            <p className="text-xs text-slate-500">Room opened {new Date(roomInfo.createdAt).toLocaleString()}</p>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <aside className="w-full lg:w-72 border-b border-white/10 bg-white/5 p-5 backdrop-blur-xl lg:border-b-0 lg:border-r shrink-0 overflow-y-auto">
          <div className="space-y-6">
            {TOOL_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">{group.label}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {group.items.map((tool) => (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => setSelectedTool(tool.id)}
                      className={`rounded-2xl border px-3 py-2 text-sm font-medium transition ${
                        selectedTool === tool.id
                          ? 'border-sky-400 bg-sky-500/20 text-white'
                          : 'border-white/10 text-slate-300 hover:border-white/30'
                      }`}
                    >
                      {tool.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Colors</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setColor(preset)}
                    className={`h-9 w-9 rounded-full border-2 transition ${
                      color === preset ? 'border-white' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: preset }}
                    aria-label={`Select color ${preset}`}
                  />
                ))}
                <label className="relative inline-flex h-9 w-9 cursor-pointer overflow-hidden rounded-full border border-white/10">
                  <span className="sr-only">Pick custom color</span>
                  <input
                    type="color"
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                  <span className="absolute inset-0 rounded-full border border-white/20" style={{ backgroundColor: color }} />
                </label>
              </div>
            </div>

            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Brush size</p>
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={24}
                  value={brushSize}
                  onChange={(event) => setBrushSize(Number(event.target.value))}
                  className="flex-1 accent-sky-400"
                />
                <span className="text-sm text-slate-300 w-10 text-center">{brushSize}px</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleClearCanvas}
              className="w-full rounded-2xl border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Clear Canvas
            </button>

            <div className="rounded-2xl border border-white/10 p-4">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Voice</p>
              <div className="mt-3 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={handleMuteToggle}
                  className={`rounded-2xl px-4 py-2 text-sm font-semibold transition ${
                    isMuted ? 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30' : 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
                  }`}
                >
                  {isMuted ? 'Unmute' : 'Mute'}
                </button>
                {voiceError && <p className="text-xs text-rose-300">{voiceError}</p>}
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleLeaveRoom(true)}
              className="w-full rounded-2xl border border-rose-400/50 px-4 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/10"
            >
              Leave Room
            </button>
          </div>
        </aside>

        <section className="flex-1 p-4 md:p-8 overflow-hidden">
          <div className="flex h-full flex-col rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_10px_80px_rgba(15,23,42,0.55)] overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4 text-sm text-slate-400">
              <p>Live Canvas</p>
              <p>
                Tool: <span className="font-semibold text-white">{selectedTool}</span>
              </p>
            </div>
            <div className="flex-1 p-4 overflow-hidden">
              <Canvas
                ref={canvasRef}
                socket={socketRef.current}
                roomId={roomId}
                selectedTool={selectedTool}
                color={color}
                brushSize={brushSize}
              />
            </div>
          </div>
        </section>
      </main>

      <div ref={audioContainerRef} className="hidden" aria-hidden="true" />
    </div>
  );
};

export default Room;
