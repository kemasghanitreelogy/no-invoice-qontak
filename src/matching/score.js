// Scoring kemiripan nama. Kebijakan inti (design doc §3.4):
// - Damerau-Levenshtein (transposisi = 1 edit) + Jaro-Winkler, ambil terbaik
// - guard edit-distance absolut per panjang token: rasio persentase saja
//   menipu untuk nama pendek (Budi vs Rudi = rasio 0.75 tapi orang berbeda)
// - token pendek (<=4) dengan 1 edit TIDAK PERNAH melewati tier `probable`
// - sinonim/fonetik = 0.95 dan mengunci skor akhir di bawah tier `exact`

const { phoneticKey } = require('./phonetic');
const { sameSynonymGroup } = require('./synonyms');

function damerauLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr.push(v);
    }
    prev2 = prev;
    prev = curr;
  }
  return prev[n];
}

function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aM = new Array(la).fill(false);
  const bM = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(lb - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bM[j] && a[i] === b[j]) {
        aM[i] = bM[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
}

function jaroWinkler(a, b) {
  const j = jaro(a, b);
  if (j <= 0.7) return j;
  let l = 0;
  while (l < 4 && l < a.length && l < b.length && a[l] === b[l]) l++;
  return j + l * 0.1 * (1 - j);
}

// Ambang edit absolut per panjang token (design doc §3.4).
function maxEditFor(len) {
  if (len <= 4) return 1;
  if (len <= 7) return 2;
  return 3;
}

// Skor sepasang token. Return { score, capProbable?, viaSynonym?, viaPhonetic? }.
function pairScore(qt, tt) {
  if (!qt || !tt) return { score: 0 };
  if (qt === tt) return { score: 1 };

  // Inisial: "m" match "muhammad" — skor tetap 0.85, dan ditandai per sisi:
  // inisial di sisi QUERY (user mengetik "M Rizky") = bukti sah berbobot kecil;
  // inisial di sisi TARGET ("Dyah Ratna S") = bukti lemah, bobot didiskon di
  // nameScore supaya token query panjang tidak "menunggangi" satu huruf.
  if (qt.length === 1 || tt.length === 1) {
    if (qt[0] !== tt[0]) return { score: 0 };
    return { score: 0.85, viaInitial: qt.length === 1 ? 'query' : 'target' };
  }

  if (sameSynonymGroup(qt, tt)) return { score: 0.95, viaSynonym: true };
  if (phoneticKey(qt) === phoneticKey(tt)) return { score: 0.95, viaPhonetic: true };

  // Prefix >=3 huruf: ketikan parsial ("suker" vs "sukereni").
  if (qt.length >= 3 && tt.length >= 3 && (tt.startsWith(qt) || qt.startsWith(tt))) {
    return { score: 0.93 };
  }

  const maxLen = Math.max(qt.length, tt.length);
  const dist = damerauLevenshtein(qt, tt);
  if (dist > maxEditFor(maxLen)) return { score: 0 };

  const ratio = 1 - dist / maxLen;
  // Jaro-Winkler biasanya lebih murah hati untuk typo di tengah/akhir nama;
  // di-cap 0.96 supaya typo tidak pernah menyamai match eksak.
  const score = Math.max(ratio, Math.min(jaroWinkler(qt, tt), 0.96));
  // Kasus Budi vs Rudi: 1 edit di token 4 huruf = maksimal tier `probable`.
  const capProbable = maxLen <= 4 && dist === 1;
  return { score, capProbable };
}

// ~100 token nama Indonesia tersering: match di token ini bukti lemah.
const COMMON_TOKENS = new Set([
  'sari', 'dewi', 'putri', 'ayu', 'siti', 'nur', 'nurul', 'indah', 'fitri', 'lestari',
  'wati', 'yanti', 'yani', 'rina', 'rini', 'ika', 'ita', 'ani', 'ina', 'dian', 'dina',
  'maya', 'mega', 'ratna', 'ria', 'sinta', 'shinta', 'tika', 'vina', 'wulan', 'yuli',
  'yulia', 'intan', 'citra', 'pertiwi', 'anggraini', 'safitri', 'rahayu', 'utami',
  'handayani', 'suryani', 'marlina', 'susanti', 'yulianti', 'herlina', 'novita',
  'oktavia', 'permata', 'kartika', 'aisyah', 'fatimah', 'khadijah', 'zahra', 'laila',
  'ahmad', 'muhammad', 'andi', 'anton', 'arif', 'bambang', 'bayu', 'dedi', 'deni',
  'dodi', 'eko', 'fajar', 'hadi', 'hendra', 'irfan', 'joko', 'rudi', 'slamet', 'tono',
  'wahyu', 'yanto', 'adi', 'ade', 'asep', 'ujang', 'agus', 'budi', 'eka', 'dwi', 'tri',
  'cahya', 'surya', 'putra', 'pratama', 'saputra', 'kurniawan', 'hidayat', 'santoso',
  'susanto', 'wijaya', 'gunawan', 'setiawan', 'nugroho', 'rahman', 'ramadhan', 'hakim',
  'maulana', 'ibrahim', 'ismail', 'hasan', 'husein', 'ali', 'umar', 'usman', 'yusuf',
]);

// Penanda urutan lahir Bali / partikel nasab: hampir tanpa daya pembeda.
const PARTICLE_TOKENS = new Set([
  'ni', 'i', 'putu', 'made', 'kadek', 'komang', 'ketut', 'wayan', 'nyoman', 'gede',
  'luh', 'gusti', 'ida', 'bagus', 'desak', 'dewa', 'ngurah', 'anak', 'agung', 'sang',
  'cok', 'oka', 'bin', 'binti', 'al', 'el', 'abu', 'ibnu', 'van', 'de',
]);

function baseWeight(token) {
  if (PARTICLE_TOKENS.has(token)) return 0.3;
  if (COMMON_TOKENS.has(token)) return 0.5;
  return 1.0;
}

function tokenWeight(token) {
  return baseWeight(token) * token.length;
}

// Skor dua nama ternormalisasi. Return:
// { score, capProbable, lowInfo } — capProbable => confidence maks `probable`.
function nameScore(queryNorm, targetNorm) {
  if (!queryNorm || !targetNorm) return { score: 0, capProbable: false };

  const qTokens = queryNorm.split(' ');
  // Query yang seluruhnya token umum/partikel & pendek ("sari", "komang"):
  // informasi terlalu tipis untuk yakin — kunci di tier `probable`, BAHKAN
  // untuk match identik (satu "Sari" di query bisa berarti banyak pelanggan).
  const infoWeight = qTokens.reduce((sum, t) => sum + baseWeight(t) * t.length, 0);
  const lowInfo = infoWeight < 4;

  if (queryNorm === targetNorm) return { score: 1, capProbable: lowInfo, lowInfo };

  const tTokens = targetNorm.split(' ');

  let acc = 0;
  let wSum = 0;
  let anyRiskyShort = false;
  let anyIndirect = false; // sinonim / fonetik dipakai
  let anyInitial = false;
  let allInitial = true; // semua match hanya lewat inisial = bukan bukti
  for (const qt of qTokens) {
    let best = { score: 0 };
    for (const tt of tTokens) {
      const s = pairScore(qt, tt);
      if (s.score > best.score) best = s;
    }
    // Inisial di sisi target: numerator dibatasi 1 huruf bukti, denominator
    // tetap setengah bobot asli — token query panjang yang cuma kena inisial
    // ikut menekan skor, tapi tidak memusnahkan kandidat abreviasi yang sah.
    // (Temuan eval: "rcowkymge" vs inisial "R" sempat 0.85 × bobot penuh.)
    const w = tokenWeight(qt);
    if (best.viaInitial === 'target') {
      acc += best.score * Math.min(w, 1);
      wSum += Math.max(w * 0.5, 1);
    } else {
      acc += best.score * w;
      wSum += w;
    }
    if (best.capProbable) anyRiskyShort = true;
    if (best.viaSynonym || best.viaPhonetic) anyIndirect = true;
    if (best.viaInitial) anyInitial = true;
    if (best.score > 0 && !best.viaInitial) allInitial = false;
  }
  let tokenScore = wSum ? acc / wSum : 0;
  if (allInitial) tokenScore = Math.min(tokenScore, 0.5); // di bawah tier weak

  // Pembanding string penuh (menangkap salah pisah token: "komangrahayu").
  const fullDist = damerauLevenshtein(queryNorm, targetNorm);
  const fullLen = Math.max(queryNorm.length, targetNorm.length);
  const fullOk = fullDist <= Math.max(2, Math.floor(fullLen / 5));
  const fullScore = fullOk ? 1 - fullDist / fullLen : 0;

  let score = Math.max(tokenScore, fullScore);

  // Token-set sama tapi urutan beda ("Rahayu Komang") -> 0.98, bukan 1.0.
  if (score > 0.98) score = 0.98;
  // Sinonim/fonetik/inisial tidak pernah menghasilkan tier `exact`.
  if (anyIndirect || anyInitial) score = Math.min(score, 0.96);

  // capProbable hanya relevan jika keputusan memang datang dari token berisiko.
  const capProbable = (anyRiskyShort && tokenScore >= fullScore) || lowInfo;
  return { score, capProbable, lowInfo };
}

module.exports = {
  damerauLevenshtein,
  jaroWinkler,
  pairScore,
  nameScore,
  tokenWeight,
  baseWeight,
  maxEditFor,
  COMMON_TOKENS,
  PARTICLE_TOKENS,
};
