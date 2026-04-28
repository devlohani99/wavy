require('dotenv').config({ override: true });
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'dummy_key' });

const Room = require('./models/Room');
const roomRoutes = require('./routes/roomRoutes');
const typingRoutes = require('./routes/typingRoutes');
const { getTypingRoom, deleteTypingRoom, TYPING_TIME_LIMIT_SECONDS } = require('./store/typingRooms');
const computeScore = require('./utils/computeScore');

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

function buildLeaderboard(room) {
  if (!room) {
    return [];
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
  return leaderboard;
}

function emitTypingRoomState(roomId) {
  const room = getTypingRoom(roomId);
  if (!room) {
    return;
  }
  const leaderboard = buildLeaderboard(room);
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
    startedAt: existingUser?.startedAt || now,
    expiresAt: existingUser?.expiresAt || now + TYPING_TIME_LIMIT_MS,
    isTimeUp: Boolean(existingUser?.isTimeUp),
  });

  typingSocketRoomMap.set(socket.id, roomId);
  socket.join(`typing:${roomId}`);
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

  const now = Date.now();
  const timeRemaining = user.expiresAt - now;
  const LATENCY_BUFFER_MS = 2000;

  if (timeRemaining < -LATENCY_BUFFER_MS) {
    if (!user.isTimeUp) {
      user.isTimeUp = true;
      socket.emit('typing-timeup', { roomId, username: user.username });
      socket.to(`typing:${roomId}`).emit('user-timeup', { roomId, username: user.username });
      emitTypingRoomState(roomId);
    }
    return;
  }

  const rawValue = typeof payload.value === 'string' ? payload.value : '';
  const safeValue = rawValue.slice(0, (room.text?.length || 0) + 200);
  const previousLength = user.lastInputLength || 0;
  const expiredThisUpdate = timeRemaining <= 0;
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

  const { score: currentScore, correctChars, typedLength } = computeScore(room.text, safeValue);
  user.score = currentScore;
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

async function handleAddAiOpponent(socket, payload = {}) {
  console.log('handleAddAiOpponent called', payload);
  const roomId = normalizeRoomId(payload.roomId);
  if (!roomId) {
    console.log('No roomId');
    return;
  }
  const room = getTypingRoom(roomId);
  if (!room) {
    console.log('Room not found', roomId);
    return;
  }

  try {
    console.log('Calling Groq...');
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: 'Generate a JSON object with two fields: "username" (a funny one-word name for an AI bot, max 10 chars, strictly no emojis) and "wpm" (a number between 30 and 120 representing Words Per Minute). Only output the JSON object.',
        },
      ],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
    });

    const aiData = JSON.parse(chatCompletion.choices[0].message.content);
    const username = (aiData.username || 'Bot').slice(0, 10);
    const wpm = aiData.wpm || 60;
    
    const aiId = `ai-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = Date.now();
    
    room.users.set(aiId, {
      socketId: aiId,
      username: username + ' [AI]',
      score: 0,
      typedLength: 0,
      correctChars: 0,
      lastInputLength: 0,
      lastInputValue: '',
      lastUpdateAt: now,
      isCompleted: false,
      completionTime: null,
      flags: [],
      isFlagged: false,
      startedAt: now,
      expiresAt: now + TYPING_TIME_LIMIT_MS,
      isTimeUp: false,
      isAi: true,
      wpm: wpm
    });

    emitTypingRoomState(roomId);
    
    const charsPerSecond = (wpm * 5) / 60;
    const intervalMs = 1000;
    
    const aiInterval = setInterval(() => {
      const currentRoom = getTypingRoom(roomId);
      if (!currentRoom) {
        clearInterval(aiInterval);
        return;
      }
      const aiUser = currentRoom.users.get(aiId);
      if (!aiUser || aiUser.isCompleted || aiUser.isTimeUp) {
        clearInterval(aiInterval);
        return;
      }
      
      const timeNow = Date.now();
      if (aiUser.expiresAt <= timeNow) {
        aiUser.isTimeUp = true;
        emitTypingRoomState(roomId);
        clearInterval(aiInterval);
        return;
      }
      
      const elapsedSeconds = (timeNow - aiUser.startedAt) / 1000;
      const targetLength = Math.floor(elapsedSeconds * charsPerSecond);
      const textToType = currentRoom.text || '';
      
      const nextLength = Math.min(targetLength, textToType.length);
      const typedValue = textToType.slice(0, nextLength);
      
      const { score, correctChars, typedLength } = computeScore(textToType, typedValue);
      aiUser.score = score;
      aiUser.correctChars = correctChars;
      aiUser.typedLength = typedLength;
      aiUser.lastInputLength = typedLength;
      aiUser.lastInputValue = typedValue;
      aiUser.lastUpdateAt = timeNow;
      
      if (typedLength >= textToType.length && textToType.length > 0) {
        aiUser.isCompleted = true;
        aiUser.completionTime = timeNow;
        io.to(`typing:${roomId}`).emit('user-finished', {
          roomId,
          username: aiUser.username,
          completionTime: timeNow,
        });
        clearInterval(aiInterval);
      }
      
      emitTypingRoomState(roomId);
    }, intervalMs);

  } catch (error) {
    console.error('Failed to add AI opponent', error);
  }
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
  socket.on('add-ai-opponent', (payload = {}) => handleAddAiOpponent(socket, payload));
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
