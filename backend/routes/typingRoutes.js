const express = require('express');
const generateRoomId = require('../utils/generateRoomId');
const typingTexts = require('../data/typingTexts');
const { createTypingRoom, getTypingRoom, TYPING_TIME_LIMIT_SECONDS } = require('../store/typingRooms');

const router = express.Router();

function getRandomText() {
  if (!typingTexts.length) {
    return 'Typing is better with friends. Add more sample texts to keep things fresh!';
  }
  const index = Math.floor(Math.random() * typingTexts.length);
  return typingTexts[index];
}

router.post('/create-room', (req, res) => {
  const roomId = generateRoomId();
  const text = getRandomText();
  createTypingRoom({ roomId, text });
  res.status(201).json({ roomId, text, timeLimitSeconds: TYPING_TIME_LIMIT_SECONDS });
});

router.get('/:roomId', (req, res) => {
  const roomId = (req.params.roomId || '').trim().toUpperCase();
  const room = getTypingRoom(roomId);
  if (!room) {
    return res.status(404).json({ message: 'Typing room not found' });
  }
  return res.json({ roomId: room.roomId, text: room.text, createdAt: room.createdAt, timeLimitSeconds: TYPING_TIME_LIMIT_SECONDS });
});

module.exports = router;
