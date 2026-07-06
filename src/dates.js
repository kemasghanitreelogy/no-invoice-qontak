// Util tanggal untuk input pencarian & pembandingan payment_date.
// Jubelio menyimpan timestamp UTC; pengguna berpikir dalam WIB — semua
// pembandingan kalender dilakukan setelah konversi +7 jam.
//
// parseDateInput menerima "segala format" ala manusia:
//   2026-04-17 · 17/04/2026 · 17-4-26 · 17.04.2026 · 17/4 · "17"
//   1 januari 2026 · 01 Jan 26 · 17 agustus · tgl 17 april · kemarin/hari ini
// + toleransi typo nama bulan ("jnauari", "agsutus", "pebruari") via Damerau.
// Tanpa tahun -> tahun berjalan (WIB); kalau hasilnya di masa depan, mundur
// setahun/sebulan — tanggal bayar tidak mungkin di masa depan.

const { damerauLevenshtein } = require('./matching/score');

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const MONTHS = [
  ['januari', 'jan', 'january'],
  ['februari', 'feb', 'pebruari', 'peb', 'february'],
  ['maret', 'mar', 'march', 'mrt'],
  ['april', 'apr'],
  ['mei', 'may'],
  ['juni', 'jun', 'june'],
  ['juli', 'jul', 'july'],
  ['agustus', 'agu', 'ags', 'agst', 'aug', 'august'],
  ['september', 'sep', 'sept'],
  ['oktober', 'okt', 'october', 'oct'],
  ['november', 'nov', 'nopember', 'nop'],
  ['desember', 'des', 'december', 'dec'],
];
const MONTH_ALIAS = new Map();
MONTHS.forEach((aliases, i) => aliases.forEach((a) => MONTH_ALIAS.set(a, i + 1)));

// Token -> nomor bulan. Urutan: alias persis, prefix unik, lalu fuzzy unik.
function resolveMonth(token) {
  if (!token || /\d/.test(token)) return null;
  if (MONTH_ALIAS.has(token)) return MONTH_ALIAS.get(token);
  if (token.length >= 3) {
    const pref = new Set(
      MONTHS.map((aliases, i) => (aliases[0].startsWith(token) ? i + 1 : null)).filter(Boolean),
    );
    if (pref.size === 1) return [...pref][0];
    if (pref.size > 1) return null; // "ju" ambigu juni/juli — tapi len<3 sudah ditolak
  }
  if (token.length < 3) return null;
  // Fuzzy: bandingkan ke SEMUA alias, ambang per panjang; harus unik satu bulan.
  const maxDist = token.length <= 4 ? 1 : 2;
  let bestDist = Infinity;
  const bestMonths = new Set();
  for (const [alias, m] of MONTH_ALIAS) {
    const d = damerauLevenshtein(token, alias);
    if (d > maxDist || d > bestDist) continue;
    if (d < bestDist) {
      bestDist = d;
      bestMonths.clear();
    }
    bestMonths.add(m);
  }
  return bestMonths.size === 1 ? [...bestMonths][0] : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmt(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? fmt(y, m, d) : null;
}

function expandYear(y) {
  if (y >= 1000) return y;
  return y + 2000; // "26" -> 2026
}

// "Hari ini" versi WIB sebagai {y, m, d}.
function todayWib(now) {
  const t = new Date(now.getTime() + WIB_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function isFuture(y, m, d, today) {
  return fmt(y, m, d) > fmt(today.y, today.m, today.d);
}

// Kata relatif, dengan toleransi typo kecil.
const RELATIVE = [
  { words: ['hari ini', 'hariini', 'today', 'sekarang', 'skrg'], delta: 0 },
  { words: ['kemarin', 'kemaren', 'kmrn', 'yesterday'], delta: -1 },
  { words: ['kemarin lusa', 'lusa kemarin', 'kemaren lusa'], delta: -2 },
];
function parseRelative(s, today) {
  for (const { words, delta } of RELATIVE) {
    for (const w of words) {
      if (s === w || (s.length >= 4 && w.length >= 4 && damerauLevenshtein(s, w) <= 1)) {
        const dt = new Date(Date.UTC(today.y, today.m - 1, today.d + delta));
        return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
      }
    }
  }
  return null;
}

// Tanpa tahun: pakai tahun berjalan; kalau jatuh di masa depan, mundur setahun.
function resolveNoYear(m, d, today) {
  let y = today.y;
  if (validYmd(y, m, d) && isFuture(y, m, d, today)) y -= 1;
  return validYmd(y, m, d);
}

function parseDateInput(raw, now = new Date()) {
  if (raw == null) return null;
  const today = todayWib(now);
  let s = String(raw)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(tanggal|tgl|pada|tempo hari|sekitar|kira kira|kira-kira)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  const rel = parseRelative(s, today);
  if (rel) return rel;

  // ISO / Y-M-D duluan (unambiguous).
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[t\s].*)?$/);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));

  // D-M-Y numerik (gaya Indonesia). Kalau posisi bulan > 12 tapi posisi hari
  // <= 12, anggap format Amerika M/D/Y dan tukar.
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let d = Number(m[1]);
    let mo = Number(m[2]);
    const y = expandYear(Number(m[3]));
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return validYmd(y, mo, d);
  }

  // D-M tanpa tahun.
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    let d = Number(m[1]);
    let mo = Number(m[2]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return resolveNoYear(mo, d, today);
  }

  // Hanya angka hari ("17"): bulan berjalan; masa depan -> bulan lalu.
  m = s.match(/^(\d{1,2})$/);
  if (m) {
    const d = Number(m[1]);
    let { y, m: mo } = today;
    if (validYmd(y, mo, d) && isFuture(y, mo, d, today)) {
      mo -= 1;
      if (mo === 0) {
        mo = 12;
        y -= 1;
      }
    }
    return validYmd(y, mo, d);
  }

  // Format kata: cari token bulan (dengan fuzzy), hari, dan tahun di sekitarnya.
  // Mendukung "1 januari 2026", "januari 1 2026", "1 jan 26", "1 januari".
  const tokens = s.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  let month = null;
  let monthIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const r = resolveMonth(tokens[i]);
    if (r) {
      month = r;
      monthIdx = i;
      break;
    }
  }
  if (!month) return null;

  const nums = tokens
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => i !== monthIdx && /^\d{1,4}$/.test(t))
    .map(({ t, i }) => ({ v: Number(t), i }));
  let year = null;
  let day = null;
  for (const { v } of nums) {
    if (v >= 1000) year = v;
  }
  // Hari: angka 1-31 terdekat dari token bulan (prioritas sebelum bulan).
  const dayCands = nums.filter(({ v }) => v >= 1 && v <= 31 && v !== year);
  if (dayCands.length) {
    dayCands.sort(
      (a, b) =>
        Math.abs(a.i - monthIdx) - Math.abs(b.i - monthIdx) || (a.i < monthIdx ? -1 : 1),
    );
    day = dayCands[0].v;
  }
  if (day == null) return null;
  if (year == null) {
    // Tahun 2 digit sisa ("1 jan 26"): angka 24-99 selain hari yang terpakai.
    const extra = nums.find(({ v, i }) => v >= 24 && v <= 99 && i !== dayCands[0].i);
    if (extra) year = expandYear(extra.v);
  }
  if (year != null) return validYmd(year, month, day);
  return resolveNoYear(month, day, today);
}

// Timestamp ISO (UTC) -> tanggal kalender WIB "YYYY-MM-DD", null jika invalid.
function wibDateOf(isoString) {
  if (!isoString) return null;
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

// Selisih hari antar dua "YYYY-MM-DD" (b - a); null jika salah satunya kosong.
function diffDays(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
}

module.exports = { parseDateInput, resolveMonth, wibDateOf, diffDays };
