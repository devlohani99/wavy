require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const Room = require('./models/Room');
const roomRoutes = require('./routes/roomRoutes');
const typingRoutes = require('./routes/typingRoutes');
const { getTypingRoom, deleteTypingRoom, TYPING_TIME_LIMIT_SECONDS } = require('./store/typingRooms');

mongoose.set('strictQuery', true);

const app = express();
const server = http.createServer(app);

const { PORT = 5000, MONGO_URI = 'mongodb://localhost:27017/wavy', CLIENT_URL = 'http://localhost:5173' } = process.env;
const allowedOrigins = CLIENT_URL.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isAllowedOrigin = (origin) => !origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin);

const expressCorsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.use(cors(expressCorsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use('/api/rooms', roomRoutes);
app.use('/api/typing', typingRoutes);

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const socketRoomMap = new Map();
const typingSocketRoomMap = new Map();

const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 15;
const USERNAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;
const TYPING_TIME_LIMIT_MS = TYPING_TIME_LIMIT_SECONDS * 1000;

const normalizeRoomId = (roomId) => (roomId || '').trim().toUpperCase();

function sanitizeUsername(rawUsername) {
  const trimmed = (rawUsername || '').trim();
  if (trimmed.length < MIN_USERNAME_LENGTH || trimmed.length > MAX_USERNAME_LENGTH) {
    return null;
  }
  if (!USERNAME_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function computeScore(referenceText, inputValue) {
  const target = referenceText || '';
  const typed = typeof inputValue === 'string' ? inputValue : '';
  let score = 0;
  let correctChars = 0;
  for (let i = 0; i < typed.length; i += 1) {
    const expected = target[i];
    const actual = typed[i];
    if (typeof expected === 'undefined') {
      score -= 1;
      continue;
    }
    if (actual === expected) {
      score += 1;
      correctChars += 1;
    } else {
      score -= 1;
    }
  }
  return { score, correctChars, typedLength: typed.length };
}

function flagUser(user, reason) {
  if (!user) {
    return;
  }
  if (!user.flags) {
    user.flags = [];
  }
  if (!user.flags.includes(reason)) {
    user.flags.push(reason);
  }
  user.isFlagged = true;
}

function emitTypingRoomState(roomId) {
  const room = getTypingRoom(roomId);
  if (!room) {
    return;
  }
  const leaderboard = Array.from(room.users.values())
    .map((user) => ({
      socketId: user.socketId,
      username: user.username,
      score: user.score || 0,
      isCompleted: Boolean(user.isCompleted),
      completionTime: user.completionTime || null,
      flags: user.flags || [],
      isFlagged: Boolean(user.isFlagged),
      isTimeUp: Boolean(user.isTimeUp),
      startedAt: user.startedAt || null,
      expiresAt: user.expiresAt || null,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.completionTime && b.completionTime) {
        return a.completionTime - b.completionTime;
      }
      if (a.completionTime) {
        return -1;
      }
      if (b.completionTime) {
        return 1;
      }
      return a.username.localeCompare(b.username);
    });

  io.to(`typing:${roomId}`).emit('typing-users-update', { roomId, count: room.users.size });
  io.to(`typing:${roomId}`).emit('leaderboard-update', { roomId, leaderboard });
}

async function removeSocketFromRoom(socketId) {
  const roomId = socketRoomMap.get(socketId);
  if (!roomId) {
    return null;
  }
  socketRoomMap.delete(socketId);

  const updatedRoom = await Room.findOneAndUpdate(
    { roomId },
    { $pull: { users: socketId } },
    { returnDocument: 'after' }
  );

  if (!updatedRoom) {
    return { roomId, remainingUsers: 0, deleted: true };
  }

  if (!updatedRoom.users.length) {
    await Room.deleteOne({ _id: updatedRoom._id });
    return { roomId, remainingUsers: 0, deleted: true };
  }

  return { roomId, remainingUsers: updatedRoom.users.length, deleted: false };
}

function forwardRoomEvent(socket, eventName) {
  return (payload = {}) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) {
      return;
    }
    socket.to(roomId).emit(eventName, { ...payload, socketId: socket.id });
  };
}

async function handleJoinRoom(socket, rawRoomId) {
  try {
    const roomId = normalizeRoomId(rawRoomId);
    if (!roomId) {
      socket.emit('room-error', { message: 'Room ID is required' });
      return;
    }

    const currentRoomId = socketRoomMap.get(socket.id);
    if (currentRoomId && currentRoomId !== roomId) {
      await handleLeaveRoom(socket);
    }

    const updatedRoom = await Room.findOneAndUpdate(
      { roomId },
      { $addToSet: { users: socket.id }, $set: { isActive: true } },
      { returnDocument: 'after' }
    );

    if (!updatedRoom) {
      socket.emit('room-error', { message: 'Room not found' });
      return;
    }

    const existingUsers = updatedRoom.users.filter((id) => id !== socket.id);

    socketRoomMap.set(socket.id, roomId);
    socket.join(roomId);
    socket.emit('existing-users', { roomId, users: existingUsers });
    socket.to(roomId).emit('user-joined', { roomId, socketId: socket.id });
    io.to(roomId).emit('user-count-update', { roomId, count: updatedRoom.users.length });
  } catch (error) {
    console.error('Failed to join room', error);
    socket.emit('room-error', { message: 'Failed to join room' });
  }
}

async function handleLeaveRoom(socket) {
  const roomId = socketRoomMap.get(socket.id);
  if (!roomId) {
    return;
  }
  socket.leave(roomId);
  const removal = await removeSocketFromRoom(socket.id);
  if (!removal) {
    return;
  }
  socket.to(roomId).emit('user-left', { roomId, socketId: socket.id });
  io.to(roomId).emit('user-count-update', { roomId, count: removal.remainingUsers });
}

function handleJoinTypingRoom(socket, payload = {}) {
  const roomId = normalizeRoomId(payload.roomId);
  if (!roomId) {
    socket.emit('typing-room-error', { message: 'Room ID is required' });
    return;
  }

  const room = getTypingRoom(roomId);
  if (!room) {
    socket.emit('typing-room-error', { message: 'Typing room not found' });
    return;
  }

  const username = sanitizeUsername(payload.username);
  if (!username) {
    socket.emit('typing-room-error', {
      message: `Provide a valid name (${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters, letters/numbers/space/-/_)`,
    });
    return;
  }

  const existingUser = room.users.get(socket.id);
  const now = Date.now();
  room.users.set(socket.id, {
    socketId: socket.id,
    username,
    score: existingUser?.score || 0,
    typedLength: existingUser?.typedLength || 0,
    correctChars: existingUser?.correctChars || 0,
    lastInputLength: existingUser?.lastInputLength || 0,
    lastInputValue: existingUser?.lastInputValue || '',
    lastUpdateAt: now,
    isCompleted: Boolean(existingUser?.isCompleted),
    completionTime: existingUser?.completionTime || null,
    flags: existingUser?.flags || [],
    isFlagged: Boolean(existingUser?.isFlagged),
    startedAt: existingUser?.startedAt || null,
    expiresAt: existingUser?.expiresAt || null,
    isTimeUp: Boolean(existingUser?.isTimeUp),
  });

  typingSocketRoomMap.set(socket.id, roomId);
  socket.join(`typing:${roomId}`);
  socket.emit('typing-room-ready', { roomId, text: room.text, timeLimitSeconds: TYPING_TIME_LIMIT_SECONDS });
  emitTypingRoomState(roomId);
}

function handleTypingUpdate(socket, payload = {}) {
  const roomId = typingSocketRoomMap.get(socket.id);
  if (!roomId) {
    return;
  }
  const room = getTypingRoom(roomId);
  if (!room) {
    typingSocketRoomMap.delete(socket.id);
    return;
  }
  const user = room.users.get(socket.id);
  if (!user) {
    return;
  }
  if (user.isCompleted || user.isTimeUp) {
    return;
  }

  const rawValue = typeof payload.value === 'string' ? payload.value : '';
  const safeValue = rawValue.slice(0, (room.text?.length || 0) + 200);
  const previousLength = user.lastInputLength || 0;
  const now = Date.now();
  if (!user.startedAt) {
    user.startedAt = now;
    user.expiresAt = now + TYPING_TIME_LIMIT_MS;
  }
  const timeRemaining = user.expiresAt ? user.expiresAt - now : TYPING_TIME_LIMIT_MS;
  const expiredThisUpdate = typeof timeRemaining === 'number' && timeRemaining <= 0;
  const lengthDelta = safeValue.length - previousLength;
  const timeDelta = typeof user.lastUpdateAt === 'number' ? now - user.lastUpdateAt : null;

  if ((payload.isPaste && lengthDelta >= 10) || (!payload.isPaste && lengthDelta >= 10 && (timeDelta === null || timeDelta < 400))) {
    flagUser(user, 'paste-detected');
  }

  if (timeDelta && timeDelta > 0) {
    const charsPerSecond = Math.abs(lengthDelta) / (timeDelta / 1000);
    if (charsPerSecond > 15) {
      flagUser(user, 'speed-warning');
    }
  }

  if (typeof payload.delta === 'number' && payload.delta >= 10) {
    flagUser(user, 'paste-detected');
  }

  const { score, correctChars, typedLength } = computeScore(room.text, safeValue);
  user.score = score;
  user.correctChars = correctChars;
  user.typedLength = typedLength;
  user.lastInputLength = typedLength;
  user.lastInputValue = safeValue;
  user.lastUpdateAt = now;

  if (!user.isCompleted && typedLength >= (room.text?.length || 0) && (room.text?.length || 0) > 0) {
    user.isCompleted = true;
    user.completionTime = now;
    io.to(`typing:${roomId}`).emit('user-finished', {
      roomId,
      username: user.username,
      completionTime: now,
    });
  }

  if (expiredThisUpdate && !user.isTimeUp) {
    user.isTimeUp = true;
    socket.emit('typing-timeup', { roomId, username: user.username });
    socket.to(`typing:${roomId}`).emit('user-timeup', { roomId, username: user.username });
  }

  emitTypingRoomState(roomId);
}

function resolveTypingContext(socket, roomIdOverride) {
  const roomId = roomIdOverride || typingSocketRoomMap.get(socket.id);
  if (!roomId) {
    return null;
  }
  const room = getTypingRoom(roomId);
  if (!room) {
    return null;
  }
  return { roomId, room };
}

function handleJoinTypingVoice(socket) {
  const context = resolveTypingContext(socket);
  if (!context) {
    socket.emit('voice-error', { message: 'Join the typing room before enabling voice chat.' });
    return;
  }
  const { roomId, room } = context;
  const user = room.users.get(socket.id);
  if (!user) {
    socket.emit('voice-error', { message: 'Join the typing room before enabling voice chat.' });
    return;
  }

  const existingParticipants = room.voiceParticipants || new Map();
  room.voiceParticipants = existingParticipants;
  const wasAlreadyPresent = existingParticipants.has(socket.id);
  existingParticipants.set(socket.id, {
    socketId: socket.id,
    username: user.username,
    joinedAt: Date.now(),
  });

  const peers = Array.from(existingParticipants.values()).filter((participant) => participant.socketId !== socket.id);
  socket.emit('voice-participants', { roomId, participants: peers });
  if (!wasAlreadyPresent) {
    socket.to(`typing:${roomId}`).emit('voice-user-joined', { socketId: socket.id, username: user.username });
  }
}

function handleLeaveTypingVoice(socket, { roomIdOverride, silent = false } = {}) {
  const context = resolveTypingContext(socket, roomIdOverride);
  if (!context) {
    return;
  }
  const { roomId, room } = context;
  if (!room.voiceParticipants?.has(socket.id)) {
    return;
  }
  room.voiceParticipants.delete(socket.id);
  if (silent) {
    io.to(`typing:${roomId}`).emit('voice-user-left', { socketId: socket.id });
  } else {
    socket.to(`typing:${roomId}`).emit('voice-user-left', { socketId: socket.id });
  }
}

function forwardTypingVoiceSignal(socket, eventName, payload = {}) {
  const { targetId } = payload;
  if (!targetId) {
    return;
  }
  const sourceRoomId = typingSocketRoomMap.get(socket.id);
  if (!sourceRoomId || typingSocketRoomMap.get(targetId) !== sourceRoomId) {
    return;
  }
  io.to(targetId).emit(eventName, {
    fromId: socket.id,
    offer: payload.offer,
    answer: payload.answer,
    candidate: payload.candidate,
  });
}

function handleLeaveTypingRoom(socket) {
  const roomId = typingSocketRoomMap.get(socket.id);
  if (!roomId) {
    return;
  }
  handleLeaveTypingVoice(socket, { roomIdOverride: roomId, silent: false });
  typingSocketRoomMap.delete(socket.id);
  socket.leave(`typing:${roomId}`);
  const room = getTypingRoom(roomId);
  if (!room) {
    return;
  }
  room.users.delete(socket.id);
  if (!room.users.size) {
    deleteTypingRoom(roomId);
    return;
  }
  emitTypingRoomState(roomId);
}

io.on('connection', (socket) => {
  socket.on('join-room', async (payload = {}) => handleJoinRoom(socket, payload.roomId));
  socket.on('leave-room', async () => handleLeaveRoom(socket));

  socket.on('draw', forwardRoomEvent(socket, 'draw'));
  socket.on('shape-draw', forwardRoomEvent(socket, 'shape-draw'));
  socket.on('arrow-draw', forwardRoomEvent(socket, 'arrow-draw'));
  socket.on('clear-canvas', () => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) {
      return;
    }
    socket.to(roomId).emit('clear-canvas', { roomId, socketId: socket.id });
  });

  socket.on('offer', ({ targetId, offer } = {}) => {
    if (!targetId || !offer) {
      return;
    }
    io.to(targetId).emit('offer', { fromId: socket.id, offer });
  });

  socket.on('answer', ({ targetId, answer } = {}) => {
    if (!targetId || !answer) {
      return;
    }
    io.to(targetId).emit('answer', { fromId: socket.id, answer });
  });

  socket.on('ice-candidate', ({ targetId, candidate } = {}) => {
    if (!targetId || !candidate) {
      return;
    }
    io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  socket.on('join-typing-room', (payload = {}) => handleJoinTypingRoom(socket, payload));
  socket.on('typing-update', (payload = {}) => handleTypingUpdate(socket, payload));
  socket.on('leave-typing-room', () => handleLeaveTypingRoom(socket));
  socket.on('join-voice', () => handleJoinTypingVoice(socket));
  socket.on('leave-voice', () => handleLeaveTypingVoice(socket));
  socket.on('typing-voice-offer', (payload = {}) => forwardTypingVoiceSignal(socket, 'typing-voice-offer', payload));
  socket.on('typing-voice-answer', (payload = {}) => forwardTypingVoiceSignal(socket, 'typing-voice-answer', payload));
  socket.on('typing-voice-ice', (payload = {}) => forwardTypingVoiceSignal(socket, 'typing-voice-ice', payload));

  socket.on('disconnect', async () => {
    await handleLeaveRoom(socket);
    handleLeaveTypingRoom(socket);
  });
});

async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
}

start();
