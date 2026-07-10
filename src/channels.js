// Normalisasi parameter `channel` pada pencarian by-name: sinonim + toleran
// typo (algoritma yang sama dengan name-matching: Damerau-Levenshtein).
// Kanon mengikuti channel_name Jubelio milik toko ini (hasil enumerasi
// 2026-07-10): SHOPIFY, SHOPEE, TOKOPEDIA, TIKTOK ("Shop | Tokopedia",
// prefix TT-), INTERNAL. Arti prefix INTERNAL (konfirmasi user 2026-07-10):
// WS = Wholesale, DP = Direct Phone — dua-duanya order lewat WhatsApp/chat
// (kanal yang dilayani API ini), jadi pelanggan yang bilang "order lewat
// WA/chat/telepon/wholesale" maksudnya channel internal. Pelanggan Shopify
// lazim menyebut "lewat web / web resmi".
const { damerauLevenshtein } = require('./matching/score');

const CHANNELS = [
  { canonical: 'shopify', synonyms: ['shopify', 'shopi', 'sopify', 'web', 'website', 'webstore', 'web store', 'web resmi', 'website resmi', 'treelogy.com', 'toko online'] },
  { canonical: 'shopee', synonyms: ['shopee', 'shope', 'sopi', 'shopee id', 'sp'] },
  { canonical: 'tokopedia', synonyms: ['tokopedia', 'tokped', 'toped', 'tp'] },
  { canonical: 'tiktok', synonyms: ['tiktok', 'tik tok', 'tiktok shop', 'tiktokshop', 'tt'] },
  {
    canonical: 'internal',
    synonyms: [
      'internal', 'manual', 'offline',
      'whatsapp', 'wa', 'chat', // order via chat WA (WS/DP dua-duanya lewat sini)
      'ws', 'wholesale', 'grosir', // WS = Wholesale
      'dp', 'direct phone', 'telepon', 'telpon', 'telp', // DP = Direct Phone
      'cs',
    ],
  },
];

const norm = (v) => String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');

// Ambang edit distance mengikuti panjang input — kata pendek ("tt", "wa")
// harus exact supaya tidak saling nyasar (tp vs tt cuma 1 edit).
const maxEditFor = (len) => (len <= 3 ? 0 : len <= 5 ? 1 : 2);

// Kembalikan { canonical, matched } atau null bila tidak dikenali.
function resolveChannel(input) {
  const q = norm(input);
  if (!q) return null;
  let best = null;
  for (const { canonical, synonyms } of CHANNELS) {
    for (const syn of synonyms) {
      const dist = damerauLevenshtein(q, syn);
      if (dist <= maxEditFor(q.length) && (!best || dist < best.dist)) {
        best = { canonical, matched: syn, dist };
      }
    }
  }
  return best ? { canonical: best.canonical, matched: best.matched } : null;
}

// Channel kanonik sebuah row hasil pencarian Jubelio. Sumber utama
// channel_name; row dari beberapa endpoint WMS tidak membawanya — fallback
// ke prefix salesorder_no. Tidak dikenal -> null (saat filter channel aktif,
// row tanpa channel yang bisa dipastikan TIDAK diikutkan).
const PREFIX_TO_CHANNEL = {
  SHF: 'shopify',
  SP: 'shopee',
  TP: 'tokopedia',
  TT: 'tiktok',
  WS: 'internal',
  CS: 'internal',
  DP: 'internal',
  DW: 'internal',
  LB: 'internal',
  EB: 'internal',
};

function channelOfRow(row) {
  const name = norm(row?.channel_name);
  if (name === 'shopify') return 'shopify';
  if (name === 'shopee') return 'shopee';
  if (name === 'tokopedia') return 'tokopedia';
  if (name.includes('shop | tokopedia') || name.includes('tiktok')) return 'tiktok';
  if (name === 'internal') return 'internal';
  const prefix = String(row?.salesorder_no || '').split('-')[0].toUpperCase();
  return PREFIX_TO_CHANNEL[prefix] || null;
}

const CHANNEL_HINT = CHANNELS.map((c) => c.canonical).join(', ');

module.exports = { resolveChannel, channelOfRow, CHANNEL_HINT };
