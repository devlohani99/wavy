function computeScore(referenceText, inputValue) {
  const target = typeof referenceText === 'string' ? referenceText : '';
  const typed = typeof inputValue === 'string' ? inputValue : '';
  const targetWords = target.split(/\s+/).filter(Boolean);
  const typedWords = typed.split(/\s+/);
  let score = 0;
  let correctChars = 0;

  for (let i = 0; i < targetWords.length; i += 1) {
    const expectedWord = targetWords[i];
    const typedWord = typedWords[i] || '';
    if (!typedWord) {
      continue;
    }
    const minLength = Math.min(expectedWord.length, typedWord.length);
    for (let j = 0; j < minLength; j += 1) {
      if (typedWord[j] === expectedWord[j]) {
        score += 1;
        correctChars += 1;
      } else {
        score -= 1;
      }
    }
    if (typedWord.length > expectedWord.length) {
      score -= typedWord.length - expectedWord.length;
    }
  }

  return { score, correctChars, typedLength: typed.length };
}

module.exports = computeScore;
