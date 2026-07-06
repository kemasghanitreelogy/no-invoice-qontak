// Normalisasi nama + deteksi kasus khusus dari data riil Jubelio:
// - nama ter-masking marketplace ("S***n L***n") harus dideteksi SEBELUM
//   simbol dibuang, kalau tidak berubah jadi "s n l n" dan memicu false positive
// - noise prefix ("| Komang Budiasa")
// - alamat yang nyasar ke field nama ("JIn Prof HB JASSIN NO.293")

const HONORIFICS = new Set([
  // sapaan
  'pak', 'bu', 'bpk', 'ibu', 'bapak', 'sdr', 'sdri', 'kak', 'mas', 'mbak', 'bang',
  'tuan', 'nyonya', 'nona', 'ny', 'tn', 'adik',
  // keagamaan / adat
  'h', 'hj', 'haji', 'hajjah', 'ust', 'ustad', 'ustadz', 'ustadzah', 'kh',
  // akademik / profesi
  'dr', 'drg', 'drs', 'dra', 'ir', 'prof',
  'se', 'sh', 'spd', 'skm', 'skom', 'ssi', 'stp', 'sag', 'amd',
  'mm', 'mt', 'msi', 'mpd', 'mkes', 'mba', 'msc', 'phd',
]);

function stripDiacritics(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function rawTokens(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean);
}

// Nama ter-masking marketplace: ada token dengan '*' di antara huruf.
function isMaskedName(s) {
  return rawTokens(s).some((t) => t.includes('*') && /[a-z0-9]/i.test(t));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "S***n L***n" -> [{pattern:/^s.+n$/}, {pattern:/^l.+n$/}]
// Token tanpa '*' dikembalikan sebagai literal.
function maskedSkeletons(s) {
  return rawTokens(s)
    .map((t) => stripDiacritics(t).toLowerCase())
    .map((t) => {
      if (!t.includes('*')) {
        const literal = t.replace(/[^a-z0-9]/g, '');
        return literal ? { literal } : null;
      }
      const parts = t.split(/\*+/).map((p) => p.replace(/[^a-z0-9]/g, ''));
      const visible = parts.join('');
      if (!visible) return null;
      return {
        pattern: new RegExp('^' + parts.map(escapeRe).join('.+') + '$'),
        minLen: visible.length + 1,
      };
    })
    .filter(Boolean);
}

const ADDRESS_WORDS = /\b(jl|jln|jalan|jin|gg|gang|no|rt|rw|blok|blk|komplek|kompleks|perum|perumahan|kel|kec|kab|desa|dusun)\b/;

// Field nama yang isinya alamat, mis. "JIn Prof HB JASSIN NO.293".
function looksLikeAddress(s) {
  const norm = stripDiacritics(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return /\d/.test(norm) && ADDRESS_WORDS.test(norm);
}

function normalizeName(s) {
  const base = stripDiacritics(s)
    .toLowerCase()
    // Titik dirapatkan (bukan jadi spasi) supaya gelar "S.E." -> "se" dan
    // tetap terdeteksi sebagai honorifik, bukan pecah jadi inisial "s" "e".
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  const tokens = base.split(' ');
  const kept = tokens.filter((t) => !HONORIFICS.has(t));
  // Jangan sampai nama jadi kosong hanya karena semua token dianggap honorifik.
  return (kept.length ? kept : tokens).join(' ');
}

module.exports = { normalizeName, isMaskedName, maskedSkeletons, looksLikeAddress, HONORIFICS };
