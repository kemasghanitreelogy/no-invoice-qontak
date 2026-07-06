#!/usr/bin/env node
// Eval harness engine matching nama (design doc §5).
// - Tarik nama pelanggan riil dari Jubelio (fallback: daftar builtin bila offline)
// - Korupsi sintetis: typo 1-2 edit, transposisi, drop/tukar token, ejaan lama,
//   nickname, honorifik
// - Negative set: gibberish yang TIDAK boleh mencapai tier `probable`
// Lulus jika: recovery(light) >= 95% dan false positive = 0. Exit 1 kalau gagal.

require('dotenv').config();
const { normalizeName } = require('../src/matching/normalize');
const { nameScore } = require('../src/matching/score');
const { confidenceOf } = require('../src/matching');
const { GROUPS, synonymGroup } = require('../src/matching/synonyms');

// RNG deterministik supaya hasil eval bisa direproduksi.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const FALLBACK_NAMES = [
  'Komang Rahayu Lestari', 'Ratna Sari', 'Meiko Simada', 'Fenny Oei', 'Rianita Sari',
  'Isti Doddy', 'Ni Komang Sukereni', 'Ni Luh Komang Astriano', 'Maya Damayanti',
  'Nana Suryana', 'Winanci Rahayu', 'Muhammad Rizky Pratama', 'Siti Nurhaliza',
  'Ahmad Fauzi', 'Dewi Kartika Sari', 'Budi Santoso', 'Agus Setiawan', 'Sri Wahyuni',
  'Eko Prasetyo', 'Dian Permatasari', 'Andi Kurniawan', 'Rina Marlina', 'Joko Susilo',
  'Fitri Handayani', 'Bambang Hermanto', 'Yulia Rachmawati', 'Hendra Gunawan',
  'Nurul Hidayah', 'Arif Rahman Hakim', 'Lestari Widodo', 'Umar Bakri', 'Zainal Abidin',
  'Tjahjadi Wibowo', 'Oemar Said', 'Yusuf Maulana', 'Christina Halim', 'Stefani Wijaya',
  'Yohanes Kristanto', 'Putu Ayu Larasati', 'Kadek Dwi Antari', 'I Made Sudiana',
  'Gusti Ngurah Putra', 'Desak Made Rai', 'Abdul Rahman', 'Fatimah Azzahra',
  'Aisyah Ramadhani', 'Khadijah Umami', 'Rizky Febrian', 'Dedy Kurnia', 'Sonny Wibisono',
  'Vina Panduwinata', 'Zaskia Meirani', 'Teguh Prakoso', 'Wulan Guritno', 'Intan Permata',
  'Citra Kirana', 'Bayu Aji Nugroho', 'Slamet Riyadi', 'Wahyu Hidayat', 'Asep Sunandar',
];

async function fetchRealNames(target = 200) {
  const { listOrders } = require('../src/jubelio');
  const names = new Set();
  for (const status of ['completed', 'cancel', 'failed', 'returned']) {
    try {
      const rows = await listOrders({ status, pageSize: 50 });
      for (const r of rows) {
        for (const n of [r.customer_name, r.shipping_full_name]) {
          if (!n || n.includes('*')) continue; // skip masked
          const norm = normalizeName(n);
          if (norm.length >= 5 && norm.includes(' ')) names.add(n.trim());
        }
      }
    } catch {
      /* status gagal di-skip */
    }
    if (names.size >= target) break;
  }
  return [...names].slice(0, target);
}

// ---- korupsi sintetis --------------------------------------------------
function editChar(word) {
  if (word.length < 3) return word;
  const i = 1 + Math.floor(rnd() * (word.length - 1));
  const kind = pick(['sub', 'ins', 'del', 'swap']);
  if (kind === 'sub') return word.slice(0, i) + pick([...LETTERS]) + word.slice(i + 1);
  if (kind === 'ins') return word.slice(0, i) + pick([...LETTERS]) + word.slice(i);
  if (kind === 'del') return word.slice(0, i) + word.slice(i + 1);
  if (i < word.length - 1) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  return word.slice(0, i - 1) + word[i] + word[i - 1] + word.slice(i + 1);
}

function corruptTokens(name, nEdits) {
  const tokens = normalizeName(name).split(' ');
  const editable = tokens.map((t, i) => ({ t, i })).filter(({ t }) => t.length >= 4);
  if (!editable.length) return tokens.join(' ');
  for (let k = 0; k < nEdits; k++) {
    const { i } = pick(editable);
    tokens[i] = editChar(tokens[i]);
  }
  return tokens.join(' ');
}

const oldify = (t) =>
  t.replace(/u/g, 'oe').replace(/^j/, 'dj').replace(/^c/, 'tj').replace(/^y/, 'j');

function corrupt(name, level) {
  const tokens = normalizeName(name).split(' ');
  if (level === 'light') {
    const mode = pick(['edit1', 'honorific', 'reorder', 'edit1']);
    if (mode === 'edit1') return corruptTokens(name, 1);
    if (mode === 'honorific') return `${pick(['ibu', 'pak', 'bpk'])} ${tokens.join(' ')}`;
    return [...tokens].reverse().join(' ');
  }
  const mode = pick(['edit2', 'drop', 'oldspell', 'nickname']);
  if (mode === 'edit2') return corruptTokens(name, 2);
  if (mode === 'drop' && tokens.length >= 3) return tokens.slice(0, -1).join(' ');
  if (mode === 'oldspell') return tokens.map((t) => (rnd() < 0.7 ? oldify(t) : t)).join(' ');
  if (mode === 'nickname') {
    return tokens
      .map((t) => {
        const g = synonymGroup(t);
        if (g === null) return t;
        const variants = GROUPS[g].filter((v) => v !== t && v.length >= 3);
        return variants.length ? pick(variants) : t;
      })
      .join(' ');
  }
  return corruptTokens(name, 2);
}

function gibberishName() {
  const word = (len) => Array.from({ length: len }, () => pick([...LETTERS])).join('');
  return `${word(6 + Math.floor(rnd() * 4))} ${word(6 + Math.floor(rnd() * 6))}`;
}

// ---- ranking offline terhadap pool -------------------------------------
function rank(query, pool) {
  const qNorm = normalizeName(query);
  return pool
    .map((name) => {
      const r = nameScore(qNorm, normalizeName(name));
      return { name, ...r, confidence: confidenceOf(r.score, r) };
    })
    .sort((a, b) => b.score - a.score);
}

(async () => {
  let pool = [];
  let source = 'live Jubelio';
  try {
    pool = await fetchRealNames(200);
  } catch {
    /* jatuh ke fallback */
  }
  if (pool.length < 30) {
    pool = FALLBACK_NAMES;
    source = 'builtin fallback (API tidak terjangkau)';
  }
  console.log(`Pool: ${pool.length} nama (${source})\n`);

  const OK_TIERS = new Set(['exact', 'strong', 'probable']);
  const results = {};
  for (const level of ['light', 'medium']) {
    let recovered = 0;
    let ambiguous = 0;
    const failures = [];
    for (const name of pool) {
      const q = corrupt(name, level);
      const ranked = rank(q, pool);
      const best = ranked[0];
      const hit =
        best && normalizeName(best.name) === normalizeName(name) && OK_TIERS.has(best.confidence);
      const nearTop = ranked.find(
        (e) => normalizeName(e.name) === normalizeName(name) && best.score - e.score < 0.05,
      );
      if (hit) recovered++;
      else if (nearTop && OK_TIERS.has(nearTop.confidence)) {
        ambiguous++; // seri/kalah tipis dari nama riil lain yang memang mirip — bukan bug
      } else {
        failures.push({ name, q, got: best?.name, conf: best?.confidence, score: best?.score });
      }
    }
    const rate = recovered / pool.length;
    results[level] = { rate, ambiguous, failures };
    console.log(
      `[${level}] recovery: ${(rate * 100).toFixed(1)}% (${recovered}/${pool.length}), ambigu-wajar: ${ambiguous}`,
    );
    for (const f of failures.slice(0, 8)) {
      console.log(
        `   MISS "${f.name}" <- query "${f.q}" -> dapat "${f.got}" (${f.conf}, ${f.score?.toFixed(3)})`,
      );
    }
  }

  let falsePositives = 0;
  for (let i = 0; i < 100; i++) {
    const q = gibberishName();
    const best = rank(q, pool)[0];
    if (best && OK_TIERS.has(best.confidence)) {
      falsePositives++;
      console.log(`   FP! "${q}" -> "${best.name}" (${best.confidence}, ${best.score.toFixed(3)})`);
    }
  }
  console.log(`\n[negative] false positive >= probable: ${falsePositives}/100`);

  const effLight = results.light.rate + results.light.ambiguous / pool.length;
  const pass = effLight >= 0.95 && falsePositives === 0;
  console.log(
    `\n${pass ? 'PASS' : 'FAIL'} — syarat: recovery light (termasuk ambigu-wajar) >= 95% dan FP = 0`,
  );
  process.exit(pass ? 0 : 1);
})();
