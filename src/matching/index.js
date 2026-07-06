// Orkestrasi matching: candidate queries, skor per baris order, dan decision
// policy (tier confidence + ambiguity margin). Lihat docs/design-name-matching.md.

const { normalizeName, isMaskedName, maskedSkeletons, looksLikeAddress } = require('./normalize');
const { pairScore, nameScore } = require('./score');
const { queryVariants } = require('./synonyms');

// Ambang tier — titik awal dari design doc; dikalibrasi via scripts/eval-names.js.
const TIER = {
  EXACT: 0.97,
  STRONG: 0.88,
  PROBABLE: 0.72,
  WEAK: 0.55,
  MARGIN: 0.05, // selisih top1-top2 di bawah ini + orang berbeda = ambigu
  MASKED_SCORE: 0.75, // skor tetap untuk match nama ter-masking, tidak pernah lebih
  ADDRESS_PENALTY: 0.85, // field nama berisi alamat -> bukti diragukan
};

function confidenceOf(score, { capProbable = false, masked = false } = {}) {
  if (masked) return score > 0 ? 'masked_possible' : 'none';
  if (!capProbable && score >= TIER.EXACT) return 'exact';
  if (!capProbable && score >= TIER.STRONG) return 'strong';
  if (score >= TIER.PROBABLE) return 'probable';
  if (score >= TIER.WEAK) return 'weak';
  return 'none';
}

// Query substring untuk Jubelio: nama penuh, token (terpanjang dulu), varian
// sinonim, lalu slice 4-huruf (posisi 0 & 1) untuk typo di ujung/awal token.
function buildNameQueries(name, { max = 10 } = {}) {
  const norm = normalizeName(name);
  const queries = [];
  const push = (s) => {
    if (s && s.length >= 3 && !queries.includes(s)) queries.push(s);
  };
  push(norm);
  const tokens = norm
    .split(' ')
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);
  tokens.forEach(push);
  for (const t of tokens) queryVariants(t).forEach(push);
  for (const t of tokens) {
    if (t.length >= 5) {
      push(t.slice(0, 4));
      push(t.slice(1, 5));
    }
  }
  return queries.slice(0, max);
}

// Match query vs nama ter-masking ("S***n L***n"): tiap token query harus cocok
// dengan satu skeleton yang belum terpakai. Skor tetap 0.75 (cap), tidak pernah
// dianggap kuat — baris masked hanya kandidat yang butuh konfirmasi manusia.
function maskedMatch(queryNorm, rawTarget) {
  const skeletons = maskedSkeletons(rawTarget);
  if (!skeletons.length) return { score: 0, masked: true };
  const qTokens = queryNorm.split(' ').filter((t) => t.length >= 2);
  if (!qTokens.length) return { score: 0, masked: true };
  const used = new Set();
  let matched = 0;
  for (const qt of qTokens) {
    let hit = -1;
    for (let i = 0; i < skeletons.length; i++) {
      if (used.has(i)) continue;
      const sk = skeletons[i];
      const ok = sk.literal
        ? pairScore(qt, sk.literal).score >= 0.9
        : qt.length >= sk.minLen && sk.pattern.test(qt);
      if (ok) {
        hit = i;
        break;
      }
    }
    if (hit === -1) return { score: 0, masked: true };
    used.add(hit);
    matched++;
  }
  return matched ? { score: TIER.MASKED_SCORE, masked: true, capProbable: true } : { score: 0, masked: true };
}

// Skor satu baris order terhadap query: ambil terbaik dari customer_name vs
// shipping_full_name, catat basisnya. queryNorm dihitung sekali oleh pemanggil.
function matchRow(queryNorm, row) {
  const bases = [
    { basis: 'customer', raw: row?.customer_name },
    { basis: 'shipping', raw: row?.shipping_full_name },
  ];
  let best = { score: 0, basis: null, matched_name: null };
  for (const { basis, raw } of bases) {
    if (!raw || typeof raw !== 'string') continue;
    let r;
    if (isMaskedName(raw)) {
      r = maskedMatch(queryNorm, raw);
    } else {
      r = nameScore(queryNorm, normalizeName(raw));
      if (r.score > 0 && looksLikeAddress(raw)) {
        r.score *= TIER.ADDRESS_PENALTY;
        r.capProbable = true; // nama berisi alamat: jangan pernah yakin penuh
      }
    }
    if (r.score > best.score) best = { ...r, basis, matched_name: raw.trim() };
  }
  best.confidence = confidenceOf(best.score, best);
  return best;
}

// Decision policy atas kandidat terkumpul.
// entries: [{ row, match }] — match hasil matchRow.
// targetDate ("YYYY-MM-DD", opsional): tiebreak — skor sama, order yang
// transaction_date-nya dekat tanggal itu menang. Verifikasi payment_date
// sesungguhnya terjadi di layer server setelah detail di-fetch (payment_date
// tidak tersedia di row list Jubelio).
function decideMatches(entries, { limit = 5, targetDate = null } = {}) {
  const { wibDateOf, diffDays } = require('../dates');
  const dateGap = (e) => {
    const d = diffDays(wibDateOf(e.row.transaction_date), targetDate);
    return d === null ? Number.MAX_SAFE_INTEGER : Math.abs(d);
  };
  const ranked = [...entries].sort(
    (a, b) =>
      b.match.score - a.match.score ||
      (targetDate ? dateGap(a) - dateGap(b) : 0) ||
      new Date(b.row.transaction_date || 0) - new Date(a.row.transaction_date || 0),
  );

  // Grup per orang: nama ternormalisasi sama = orang yang sama (multi-order
  // dari 1 orang BUKAN ambiguitas).
  const personKey = (e) =>
    e.match.masked ? `masked:${e.match.matched_name}` : normalizeName(e.match.matched_name || '');
  const groups = new Map();
  for (const e of ranked) {
    const key = personKey(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const groupTops = [...groups.values()].map((g) => g[0]);
  const atLeastProbable = (e) => ['exact', 'strong', 'probable', 'masked_possible'].includes(e.match.confidence);
  const contenders = groupTops.filter(atLeastProbable);
  const is_ambiguous =
    contenders.length >= 2 &&
    contenders[0].match.score - contenders[1].match.score < TIER.MARGIN;

  const primary = ranked.filter(atLeastProbable).slice(0, limit);
  const primarySet = new Set(primary);
  const alternatives = ranked.filter((e) => !primarySet.has(e)).slice(0, 10);

  return { primary, alternatives, is_ambiguous, total_found: ranked.length };
}

module.exports = {
  TIER,
  confidenceOf,
  buildNameQueries,
  matchRow,
  maskedMatch,
  decideMatches,
  normalizeName,
};
