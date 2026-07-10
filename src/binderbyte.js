// Pelacakan paket via BinderByte (https://docs.binderbyte.com) untuk tiga
// kurir yang dipakai toko: jne, jnt, lion. Param `number` (5 digit terakhir
// HP penerima) hanya relevan untuk JNE (opsional menurut docs, tapi beberapa
// resi menolak tanpa itu) — disuplai oleh src/phone.js.
const { withRetry } = require('./retry');
const { resolveFullPhone } = require('./phone');

const BASE_URL = 'https://api.binderbyte.com/v1/track';
const TIMEOUT_MS = 10_000;

// Cache hasil sukses per AWB (TTL 5 menit) — bot CS sering menanyakan order
// yang sama berulang; posisi paket tidak berubah semenit dua menit, dan ini
// menghemat kuota BinderByte. Error TIDAK di-cache supaya perbaikan key/resi
// langsung terasa.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // awb -> { at, value }

function cacheGet(awb) {
  const hit = cache.get(awb);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(awb);
    return null;
  }
  return hit.value;
}

// Deteksi kurir BinderByte dari order Jubelio. Sumber utama: field shipper
// (nilai auto-fill: "jnt"/"lion"/"jne"; manual bisa "J&T REG" dll). Fallback:
// prefix AWB yang tidak ambigu (11LP... = Lion, JP+digit = J&T) — menolong
// order lama yang shippernya masih "Domestic Shipping".
function detectCourier(shipper, awb) {
  const s = String(shipper || '').toLowerCase();
  if (/j&t|jnt/.test(s)) return 'jnt';
  if (/lion/.test(s)) return 'lion';
  if (/jne/.test(s)) return 'jne';
  const a = String(awb || '').toUpperCase();
  if (/^11LP/.test(a)) return 'lion';
  if (/^JP\d/.test(a)) return 'jnt';
  return null;
}

const awbOf = (detail) =>
  detail?.tracking_no || (detail?.items || []).map((it) => it?.tracking_no).find(Boolean) || null;

async function callBinderByte(params) {
  const apiKey = process.env.BINDERBYTE_API_KEY;
  if (!apiKey) {
    const err = new Error('BINDERBYTE_API_KEY belum di-set');
    err.status = 400; // permanen — jangan di-retry
    throw err;
  }
  const qs = new URLSearchParams({ api_key: apiKey, ...params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}?${qs}`, { signal: controller.signal });
    const json = await res.json().catch(() => null);
    // BinderByte memakai body {status,message}; 400 = permanen (key salah /
    // resi tidak ditemukan), 5xx/timeout = transient (di-retry withRetry).
    if (!res.ok || !json || json.status !== 200) {
      const err = new Error(json?.message || `BinderByte HTTP ${res.status}`);
      err.status = json?.status || res.status;
      throw err;
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

// Lacak satu order Jubelio. Mengembalikan:
//   { courier, awb, ...ringkasan, history }  bila sukses;
//   { courier, awb, error }                  bila gagal (non-fatal);
//   null                                     bila order belum bisa dilacak
//                                            (tanpa resi / kurir di luar 3).
async function trackOrder(detail) {
  const awb = awbOf(detail);
  const courier = detectCourier(detail?.shipper, awb);
  if (!awb || !courier) return null;

  const cached = cacheGet(awb);
  if (cached) return cached;

  const params = { courier, awb };
  let phone_source = null;
  if (courier === 'jne') {
    // JNE butuh 5 digit terakhir HP penerima — cari dari segala sumber.
    const resolved = await resolveFullPhone(detail).catch(() => null);
    if (resolved?.last5) {
      params.number = resolved.last5;
      phone_source = resolved.source;
    }
  }

  try {
    const data = await withRetry(() => callBinderByte(params), { attempts: 3, label: `binderbyte:${awb}` });
    const s = data?.summary || {};
    const history = (data?.history || []).map((h) => ({ date: h.date, desc: h.desc, location: h.location }));
    const result = {
      courier,
      awb,
      status: s.status || null, // mis. DELIVERED / ON PROCESS
      service: s.service || null,
      courier_name: s.courier || null,
      last_update: history.length ? history[history.length - 1] : null,
      receiver: data?.detail?.receiver || null,
      origin: data?.detail?.origin || null,
      destination: data?.detail?.destination || null,
      history,
      ...(phone_source ? { phone_last5_source: phone_source } : {}),
    };
    cache.set(awb, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    // Non-fatal: response lookup tetap jalan, error dilaporkan apa adanya
    // supaya root cause kelihatan (key salah vs resi belum terdaftar).
    return { courier, awb, error: err.message };
  }
}

module.exports = { trackOrder, detectCourier, awbOf };
