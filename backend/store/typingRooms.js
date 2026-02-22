const TYPING_TIME_LIMIT_SECONDS = 60;
const typingRooms = new Map();

function createTypingRoom({ roomId, text }) {
  const room = {
    roomId,
    text,
    createdAt: new Date(),
    users: new Map(),
    voiceParticipants: new Map(),
  };
  typingRooms.set(roomId, room);
  return room;
}

function getTypingRoom(roomId) {
  return typingRooms.get(roomId);
}

function deleteTypingRoom(roomId) {
  typingRooms.delete(roomId);
}

module.exports = {
  typingRooms,
  createTypingRoom,
  getTypingRoom,
  deleteTypingRoom,
  TYPING_TIME_LIMIT_SECONDS,
};
