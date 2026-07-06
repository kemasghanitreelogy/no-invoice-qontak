// Shim kompatibilitas — implementasi pindah ke src/matching/ (engine v2).
// nameSimilarity dipertahankan untuk pemakai lama: skor 0..1 tanpa metadata.

const { normalizeName } = require('./matching/normalize');
const { damerauLevenshtein, nameScore } = require('./matching/score');
const { buildNameQueries } = require('./matching');

function nameSimilarity(query, target) {
  return nameScore(normalizeName(query), normalizeName(target)).score;
}

module.exports = {
  normalizeName,
  levenshtein: damerauLevenshtein,
  nameSimilarity,
  buildNameQueries,
};
