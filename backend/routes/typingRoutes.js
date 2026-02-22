const express = require('express');
const generateRoomId = require('../utils/generateRoomId');
const typingTexts = require('../data/typingTexts');
const typingRounds = require('../data/typingRounds');
const { createTypingRoom, getTypingRoom, TYPING_TIME_LIMIT_SECONDS, TOTAL_ROUNDS } = require('../store/typingRooms');

const router = express.Router();

function buildRounds() {
  const pool = typingRounds.length ? typingRounds.slice() : typingTexts.slice();
  if (!pool.length) {
    pool.push('Typing is better with friends. Add more sample texts to keep things fresh!');
  }
  while (pool.length < TOTAL_ROUNDS) {
    const fallback = typingTexts[Math.floor(Math.random() * typingTexts.length)] || pool[pool.length - 1];
    pool.push(fallback);
  }
  return pool.slice(0, TOTAL_ROUNDS);
}

router.post('/create-room', (req, res) => {
  const roomId = generateRoomId();
  const rounds = buildRounds();
  const room = createTypingRoom({ roomId, rounds });
  res.status(201).json({
    roomId,
    text: room.text,
    timeLimitSeconds: TYPING_TIME_LIMIT_SECONDS,
    roundNumber: 1,
    totalRounds: room.rounds.length,
  });
});

router.get('/:roomId', (req, res) => {
  const roomId = (req.params.roomId || '').trim().toUpperCase();
  const room = getTypingRoom(roomId);
  if (!room) {
    return res.status(404).json({ message: 'Typing room not found' });
  }
  return res.json({
    roomId: room.roomId,
    text: room.text,
    createdAt: room.createdAt,
    timeLimitSeconds: TYPING_TIME_LIMIT_SECONDS,
    roundNumber: (room.currentRoundIndex || 0) + 1,
    totalRounds: room.rounds?.length || TOTAL_ROUNDS,
  });
});

module.exports = router;
