const express = require('express');
const Room = require('../models/Room');
const generateRoomId = require('../utils/generateRoomId');

const router = express.Router();

async function createUniqueRoomId(attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = generateRoomId();
    const existingRoom = await Room.findOne({ roomId: candidate });
    if (!existingRoom) {
      return candidate;
    }
  }
  throw new Error('Unable to generate a unique room ID');
}

router.post('/create', async (req, res) => {
  try {
    const roomId = await createUniqueRoomId();
    await Room.create({ roomId, isActive: true, users: [] });
    res.status(201).json({ roomId });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create room', error: error.message });
  }
});

router.get('/:roomId', async (req, res) => {
  try {
    const roomId = (req.params.roomId || '').trim().toUpperCase();
    if (!roomId) {
      return res.status(400).json({ message: 'Room ID is required' });
    }

    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    res.json({
      roomId: room.roomId,
      createdAt: room.createdAt,
      users: room.users,
      isActive: room.isActive,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch room', error: error.message });
  }
});

module.exports = router;
