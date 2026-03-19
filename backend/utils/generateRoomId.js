const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 8;

module.exports = function generateRoomId() {
  let result = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
    const index = Math.floor(Math.random() * ALPHABET.length);
    result += ALPHABET[index];
  }
  return result;
};
