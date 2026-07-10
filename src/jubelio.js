const axios = require('axios');
const { detectChannel } = require('./detect');
const { channelOfRow } = require('./channels');
const { buildNameQueries, matchRow, decideMatches, normalizeName, TIER } = require('./matching');

const BASE_URL = process.env.JUBELIO_BASE_URL || 'https://api2.jubelio.com';
const TOKEN_TTL_MS = 11 * 60 * 60 * 1000;

const tokenCache = { value: null, expiresAt: 0 };

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

async function login() {
  const email = process.env.JUBELIO_API_USERNAME;
  const password = process.env.JUBELIO_API_PASSWORD;
  if (!email || !password) {
    throw new Error('JUBELIO_API_USERNAME / JUBELIO_API_PASSWORD belum di-set di .env');
  }
  const { data } = await http.post('/login', { email, password });
  if (!data || !data.token) throw new Error('Login Jubelio gagal: token kosong');
  return data.token;
}

async function getToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;
  const token = await login();
  tokenCache.value = token;
  tokenCache.expiresAt = now + TOKEN_TTL_MS;
  return token;
}

const authHeaders = (token) => ({ Authorization: token });

async function withAuth(fn) {
  let token = await getToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err.response && err.response.status === 401) {
      token = await getToken({ forceRefresh: true });
      return await fn(token);
    }
    throw err;
  }
}

async function tryGetOrderByNo(salesorderNo) {
  return withAuth(async (token) => {
    try {
      const { data } = await http.post(
        '/wms/order/getOrderByNo/',
        { salesorder_no: salesorderNo },
        { headers: authHeaders(token) },
      );
      if (data && data.salesorder_id) return { salesorder_id: data.salesorder_id, matched: salesorderNo };
      return null;
    } catch (err) {
      const status = err.response?.status;
      if (status === 404 || status === 400) return null;
      throw err;
    }
  });
}

const SEARCH_PATHS = [
  '/sales/orders/completed/',
  '/sales/orders/cancel/',
  '/sales/orders/failed/',
  '/sales/orders/returned-list/',
  '/wms/sales/orders/ready-to-pick/',
  '/wms/sales/orders/ready-to-process/',
  '/wms/sales/orders/empty-stock/',
  '/wms/sales/orders/finish-pick/',
  '/wms/sales/orders/request-cancel/',
  '/wms/sales/order/ready-to-ship',
  '/wms/sales/shipped/',
  '/wms/sales/picklists/confirm-pick/',
  '/wms/sales/packlists/finish-pack/',
];

// Match nomor order harus di BATAS token, bukan substring bebas: "19024"
// TIDAK boleh kena di tengah "TP-584133351608190245-..." (insiden nyata:
// nomor invoice QuickBooks 19024 mengembalikan order Tokopedia acak).
function boundedMatch(haystack, needle) {
  const h = String(haystack || '');
  if (!h) return false;
  if (h === needle) return true;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-zA-Z0-9])${esc}(?![a-zA-Z0-9])`).test(h);
}

function pickFromRows(rows, { stems = [], candidates = [], query = '' } = {}) {
  if (!rows.length) return null;
  const q = String(query || '').trim();
  const needle = q.startsWith('#') ? q.slice(1) : q;
  const exact = rows.find(
    (r) => (r?.salesorder_no && candidates.includes(r.salesorder_no)) || (needle && r?.ref_no === needle),
  );
  if (exact) return exact;
  if (stems.length) {
    const stemHit = rows.find((r) => r?.salesorder_no && stems.some((p) => r.salesorder_no.startsWith(p)));
    if (stemHit) return stemHit;
  }
  // JANGAN asal ambil baris pertama: endpoint Jubelio bisa mengembalikan daftar
  // order walau query tidak match, dan itu memunculkan order yang salah.
  if (needle.length >= 4) {
    const contains = rows.find(
      (r) => boundedMatch(r?.salesorder_no, needle) || boundedMatch(r?.ref_no, needle),
    );
    if (contains) return contains;
  }
  return null;
}

async function trySearchByQuery(query, opts = {}) {
  return withAuth(async (token) => {
    let anySuccess = false;
    let lastFailure = null;
    for (const path of SEARCH_PATHS) {
      try {
        const { data } = await http.get(path, {
          params: { q: query, pageSize: 100 },
          headers: authHeaders(token),
        });
        anySuccess = true;
        const rows = Array.isArray(data?.data) ? data.data : [];
        const hit = pickFromRows(rows, { ...opts, query });
        if (hit) return { salesorder_id: hit.salesorder_id, matched: hit.salesorder_no || query, via: path };
      } catch (err) {
        if (err.response?.status === 401) throw err;
        lastFailure = err;
      }
    }
    // Semua path gagal = gangguan upstream, bukan "tidak ditemukan".
    if (!anySuccess) throw lastFailure || new Error('Semua permintaan pencarian ke Jubelio gagal');
    return null;
  });
}

// Timestamp "Diambil" (pick gudang) tidak ada di detail order — Jubelio
// menyimpannya di picklist (kasus SHF-8506: UI menampilkan Diambil dari
// picklist.completed_date, detail order kosong).
async function getPicklist(picklistId) {
  return withAuth(async (token) => {
    const { data } = await http.get(`/sales/picklists/${picklistId}`, {
      headers: authHeaders(token),
    });
    return data;
  });
}

async function getOrderDetail(salesorderId) {
  return withAuth(async (token) => {
    const { data } = await http.get(`/sales/orders/${salesorderId}`, {
      headers: authHeaders(token),
    });
    return data;
  });
}

async function smartLookup(rawInput) {
  const detection = detectChannel(rawInput);
  const tried = [];

  for (const candidate of detection.candidates) {
    tried.push({ method: 'getOrderByNo', value: candidate });
    const hit = await tryGetOrderByNo(candidate);
    if (hit) {
      const detail = await getOrderDetail(hit.salesorder_id);
      return {
        found: true,
        detection: { channel: detection.channel, raw: detection.raw, normalized: detection.normalized },
        match: { ...hit, method: 'getOrderByNo' },
        tried,
        order: detail,
      };
    }
  }

  for (const q of detection.queries) {
    tried.push({ method: 'search', value: q });
    const hit = await trySearchByQuery(q, {
      stems: detection.stems,
      candidates: detection.candidates,
    });
    if (hit) {
      const detail = await getOrderDetail(hit.salesorder_id);
      return {
        found: true,
        detection: { channel: detection.channel, raw: detection.raw, normalized: detection.normalized },
        match: { ...hit, method: 'search' },
        tried,
        order: detail,
      };
    }
  }

  return {
    found: false,
    detection: { channel: detection.channel, raw: detection.raw, normalized: detection.normalized },
    tried,
  };
}

// Cari order berdasarkan nama pemesan / nama penerima (shipping_full_name).
// Engine v2 (docs/design-name-matching.md): toleran typo + sinonim/ejaan lama,
// dengan decision policy eksplisit (tier confidence + ambiguity margin) supaya
// tidak pernah percaya diri pada match yang meragukan.
// channel (opsional): kanonik dari resolveChannel — memfilter row SEBELUM
// scoring & keputusan ambiguitas, jadi "Komang di Shopee" tidak dianggap
// ambigu dengan "Komang di Tokopedia" saat user sudah menyebut channel.
async function searchOrdersByName(name, { limit = 5, targetDate = null, channel = null } = {}) {
  const queryNorm = normalizeName(name);
  const queries = buildNameQueries(name);
  const tried = [];
  const byId = new Map();
  // Kalau SEMUA request ke Jubelio gagal, itu gangguan upstream — WAJIB jadi
  // error 5xx, bukan "pesanan tidak ditemukan" (data akurat > jawaban cepat).
  let anySuccess = false;
  let lastFailure = null;

  await withAuth(async (token) => {
    for (const q of queries) {
      tried.push(q);
      const results = await Promise.allSettled(
        SEARCH_PATHS.map((path) =>
          http.get(path, { params: { q, pageSize: 100 }, headers: authHeaders(token) }),
        ),
      );
      for (const r of results) {
        if (r.status === 'rejected') {
          // 401 dilempar keluar supaya withAuth refresh token & retry.
          if (r.reason?.response?.status === 401) throw r.reason;
          lastFailure = r.reason;
          continue;
        }
        anySuccess = true;
        const rows = Array.isArray(r.value.data?.data) ? r.value.data.data : [];
        for (const row of rows) {
          if (!row?.salesorder_id || byId.has(row.salesorder_id)) continue;
          if (channel && channelOfRow(row) !== channel) continue;
          const match = matchRow(queryNorm, row);
          if (match.score >= TIER.WEAK) byId.set(row.salesorder_id, { row, match });
        }
      }
      // Early-stop hanya jika kandidat kuat sudah cukup DAN tidak ambigu —
      // kalau ambigu kita justru butuh lebih banyak bukti dari query berikutnya.
      const { primary, is_ambiguous } = decideMatches([...byId.values()], { limit, targetDate });
      const strong = primary.filter((e) => ['exact', 'strong'].includes(e.match.confidence));
      if (strong.length >= limit && !is_ambiguous) break;
    }
  });

  if (!anySuccess) {
    throw lastFailure || new Error('Semua permintaan pencarian ke Jubelio gagal');
  }

  const decision = decideMatches([...byId.values()], { limit, targetDate });
  return { queries_tried: tried, ...decision };
}

async function listOrders({ status = 'completed', q = '', pageSize = 10 } = {}) {
  const map = {
    completed: '/sales/orders/completed/',
    cancel: '/sales/orders/cancel/',
    failed: '/sales/orders/failed/',
    returned: '/sales/orders/returned-list/',
  };
  const path = map[status] || map.completed;
  return withAuth(async (token) => {
    const { data } = await http.get(path, {
      params: q ? { q, pageSize } : { pageSize },
      headers: authHeaders(token),
    });
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map((r) => ({
      salesorder_id: r.salesorder_id,
      salesorder_no: r.salesorder_no,
      customer_name: r.customer_name,
      shipping_full_name: r.shipping_full_name,
      channel_name: r.channel_name,
      store_name: r.store_name,
      transaction_date: r.transaction_date,
      grand_total: r.grand_total,
      internal_status: r.internal_status,
    }));
  });
}

module.exports = {
  smartLookup,
  getOrderDetail,
  getPicklist,
  tryGetOrderByNo,
  trySearchByQuery,
  listOrders,
  searchOrdersByName,
  pickFromRows,
  boundedMatch,
  // Helper low-level untuk scripts/ (mis. update-shipper). Service HTTP-nya
  // sendiri tetap read-only — jangan tambah panggilan tulis di src/.
  withAuth,
  http,
  authHeaders,
};
