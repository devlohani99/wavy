const TYPING_TIME_LIMIT_SECONDS = 60;
const TOTAL_ROUNDS = 5;
const typingRooms = new Map();

function createTypingRoom({ roomId, rounds }) {
  const preparedRounds = Array.isArray(rounds) && rounds.length ? rounds.slice(0, TOTAL_ROUNDS) : [];
  if (!preparedRounds.length) {
    preparedRounds.push('Typing sprint default prompt.');
  }
  const room = {
    roomId,
    createdAt: new Date(),
    rounds: preparedRounds,
    currentRoundIndex: 0,
    text: preparedRounds[0],
    users: new Map(),
    voiceParticipants: new Map(),
    isGameOver: false,
    isTransitioning: false,
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
  TOTAL_ROUNDS,
};
