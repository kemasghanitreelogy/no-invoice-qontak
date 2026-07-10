require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { smartLookup, listOrders, searchOrdersByName, getOrderDetail, getPicklist } = require('./jubelio');
const {
  shipperFromFulfillment,
  resolveOrderForShopify,
  isFillable,
  currentShipperOf,
  applyShipper,
} = require('./shipper');
const { syncShippers } = require('./shopify-sync');
const { withRetry } = require('./retry');
const { notifyTelegram, notifyError } = require('./notify');
const { trackOrder } = require('./binderbyte');
const { resolveChannel, CHANNEL_HINT } = require('./channels');
const { formatOrder } = require('./format');
const { parseDateInput, wibDateOf, diffDays } = require('./dates');
const { normalizeName } = require('./matching');

const app = express();

// Terima body dalam bentuk apa pun — klien seperti Qontak (User-Agent: Ruby)
// kadang mengirim JSON tanpa header Content-Type: application/json, atau
// sebagai form-urlencoded. body-parser menandai req._body setelah salah satu
// parser berhasil, jadi urutan ini aman.
// rawBody disimpan untuk verifikasi HMAC webhook Shopify (tanda tangan
// dihitung dari bytes mentah, bukan hasil parse).
const keepRawBody = (req, _res, buf) => {
  req.rawBody = buf;
};
app.use(express.json({ limit: '1mb', verify: keepRawBody }));
app.use(express.urlencoded({ extended: true, limit: '1mb', verify: keepRawBody }));
app.use(express.text({ type: () => true, limit: '1mb', verify: keepRawBody }));
app.use((req, _res, next) => {
  if (typeof req.body === 'string') {
    const rawText = req.body.trim();
    req.body = {};
    if (rawText) {
      try {
        req.body = JSON.parse(rawText);
        req._bodyParsedFrom = 'text-fallback';
      } catch {
        req._bodyRaw = rawText.slice(0, 300);
      }
    }
  }
  next();
});

// ---- logging terstruktur (muncul di Vercel Logs per request) --------------
const truncate = (v, n = 500) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s;
};
const ridOf = (req) => req.headers['x-vercel-id'] || `local-${Date.now().toString(36)}`;
function logEvent(req, event, data = {}) {
  console.log(
    JSON.stringify({ t: new Date().toISOString(), rid: ridOf(req), event, ...data }),
  );
}
app.use((req, res, next) => {
  req._t0 = Date.now();
  logEvent(req, 'request', {
    method: req.method,
    path: req.path,
    ua: req.headers['user-agent'] || null,
    content_type: req.headers['content-type'] || null,
    body_parsed_from: req._bodyParsedFrom || (req.headers['content-type'] || '').split(';')[0] || 'none',
    body: truncate(req.body),
    ...(req._bodyRaw ? { body_raw_unparsed: req._bodyRaw } : {}),
  });
  res.on('finish', () => {
    logEvent(req, 'response', { status: res.statusCode, ms: Date.now() - req._t0 });
  });
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/orders/lookup', async (req, res) => {
  const raw =
    req.body?.salesorder_no ||
    req.body?.order_no ||
    req.body?.kode_pesanan ||
    req.body?.no_pesanan;

  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) {
    return res.status(400).json({
      error: 'kode pesanan wajib diisi',
      hint:
        'kirim body JSON: { "salesorder_no": "<kode dari TikTok/Tokopedia/Shopee/Shopify>" }. ' +
        'Contoh: "260426SDYAE9DE" (Shopee), "INV/20250322/MPL/4504975400" (Tokopedia), "#6211" (Shopify).',
    });
  }

  try {
    const result = await smartLookup(input);
    if (!result.found) {
      return res.status(404).json({
        error: 'Pesanan tidak ditemukan di Jubelio',
        input,
        detection: result.detection,
        tried: result.tried,
      });
    }
    const verbose = req.query.verbose === '1' || req.body?.verbose === true;
    const summary = formatOrder(result.order);
    // Channel asli dari order Jubelio (source_name) lebih akurat daripada tebakan
    // berdasarkan format input — angka panjang ambigu antara tiktok & tokopedia.
    const detected_channel =
      (summary?.channel || result.detection.channel || 'unknown').toLowerCase();
    // Order yang sudah punya kurir + resi (jne/jnt/lion) dilacak live via
    // BinderByte. Non-fatal: gagal lacak -> field tracking berisi error.
    const tracking = await trackOrder(result.order);
    if (tracking) logEvent(req, 'tracking.result', { awb: tracking.awb, courier: tracking.courier, status: tracking.status || null, error: tracking.error || null });
    return res.json({
      input,
      detected_channel,
      ...summary,
      ...(tracking ? { tracking } : {}),
      ...(verbose ? { _raw: result.order } : {}),
    });
  } catch (err) {
    const status = err.response?.status || 500;
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: 'Gagal mengambil data pesanan dari Jubelio',
      message: err.message,
      upstream: err.response?.data,
    });
  }
});

// Cari order dari nama pemesan ATAU nama penerima di alamat pengiriman.
// Toleran typo + sinonim. POST body raw JSON:
//   { "name": "...", "date": "...", "channel": "..." } — hanya "name" wajib.
// - "date" opsional (tanggal BAYAR versi pelanggan/WIB) — dipakai untuk
//   menaikkan akurasi: verifikasi ke payment_date order & memecah ambiguitas.
// - "channel" opsional (shopify/shopee/tokopedia/tiktok/internal, toleran
//   typo + sinonim mis. "tokped", "tt", "wa") — memfilter kandidat sebelum
//   scoring sehingga juga memecah ambiguitas antar-channel.
// - Jumlah order dipatok internal (maks 5, kandidat >= probable).
const BY_NAME_LIMIT = 5;
const DATE_TOLERANCE_DAYS = 1; // payment_date UTC vs persepsi WIB bisa geser 1 hari
async function handleSearchByName(req, res) {
  const raw =
    req.body?.name ||
    req.body?.nama ||
    req.body?.customer_name ||
    req.body?.shipping_name;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 3) {
    // Diagnosa dikembalikan di response supaya pemanggil (mis. bot Qontak)
    // langsung tahu apa yang sebenarnya diterima server.
    const received = {
      content_type: req.headers['content-type'] || null,
      body_keys: Object.keys(req.body || {}),
      ...(req._bodyRaw ? { body_raw_unparsed: req._bodyRaw } : {}),
    };
    logEvent(req, 'byname.reject', { reason: 'name-missing-or-short', name, received });
    return res.status(400).json({
      error: 'nama wajib diisi (minimal 3 huruf)',
      hint: 'POST body raw JSON: { "name": "Komang Rahayu" } (alias: nama / customer_name / shipping_name). Opsional "date": tanggal bayar. Pastikan header Content-Type: application/json.',
      received,
    });
  }

  // "channel" opsional — dinormalisasi dgn sinonim + anti-typo (channels.js).
  const channelRaw = req.body?.channel ?? req.body?.kanal ?? req.body?.marketplace;
  let channel = null;
  if (channelRaw != null && String(channelRaw).trim() !== '') {
    const resolved = resolveChannel(channelRaw);
    if (!resolved) {
      logEvent(req, 'byname.reject', { reason: 'channel-unknown', channel_raw: String(channelRaw) });
      return res.status(400).json({
        error: 'channel tidak dikenali',
        received: { channel: String(channelRaw) },
        hint: `Channel yang dikenal: ${CHANNEL_HINT} (sinonim & typo ringan diterima, mis. "tokped", "tik tok", "wa").`,
      });
    }
    channel = resolved.canonical;
  }

  const dateRaw = req.body?.date ?? req.body?.tanggal ?? req.body?.payment_date;
  let targetDate = null;
  if (dateRaw != null && String(dateRaw).trim() !== '') {
    targetDate = parseDateInput(dateRaw);
    if (!targetDate) {
      logEvent(req, 'byname.reject', { reason: 'date-unparseable', date_raw: String(dateRaw) });
      return res.status(400).json({
        error: 'format tanggal tidak dikenali',
        received: { date: String(dateRaw) },
        hint: 'Contoh yang diterima: "17/04/2026", "2026-04-17", "17 april 2026", "1 jan", "kemarin". Tanpa tahun otomatis pakai tahun berjalan.',
      });
    }
  }
  logEvent(req, 'byname.search', { name, date_raw: dateRaw != null ? String(dateRaw) : null, date_parsed: targetDate, channel });

  const limit = BY_NAME_LIMIT;
  try {
    const { primary, is_ambiguous, total_found, queries_tried } = await searchOrdersByName(name, {
      limit,
      targetDate,
      channel,
    });
    if (!primary.length) {
      logEvent(req, 'byname.notfound', { name, channel, total_found, queries_tried });
      return res.status(404).json({
        error: channel
          ? `Tidak ada pesanan di channel ${channel} yang cocok dengan nama tersebut`
          : 'Tidak ada pesanan yang cocok dengan nama tersebut',
        input: name,
        ...(channel ? { channel } : {}),
        queries_tried,
      });
    }
    // Detail lengkap hanya untuk kandidat >= probable (privacy: match lemah
    // tidak pernah membuka detail order).
    const detailByNo = new Map(); // untuk pelacakan resi order teratas
    let orders = await Promise.all(
      primary.map(async ({ row, match }) => {
        const detail = await getOrderDetail(row.salesorder_id);
        detailByNo.set(detail.salesorder_no, detail);
        // Timestamp pick gudang ("Diambil") tidak ada di detail order —
        // ambil dari picklist bila row pencarian membawa picklist_id.
        // Pengayaan opsional: gagal fetch picklist tidak menggagalkan response.
        let extras = {};
        const detailHasPick =
          (detail.items || []).some((it) => it?.pick_scanned_date) || detail.tn_created_date;
        if (row.picklist_id && !detailHasPick) {
          try {
            const pl = await getPicklist(row.picklist_id);
            if (pl?.completed_date) {
              extras = { picked_at: pl.completed_date, picked_by: row.picker || null };
            }
          } catch (e) {
            logEvent(req, 'byname.picklist.skip', { picklist_id: row.picklist_id, message: e.message });
          }
        }
        // Shopify sering tidak mengisi payment_date walau lunas — untuk
        // pencocokan tanggal, order lunas fallback ke transaction_date
        // (checkout Shopify = bayar saat itu juga).
        const payRef = detail.payment_date || (detail.is_paid ? detail.transaction_date : null);
        const diff = targetDate ? diffDays(wibDateOf(payRef), targetDate) : null;
        return {
          match_score: Number(match.score.toFixed(3)),
          confidence: match.confidence,
          match_basis: match.basis,
          matched_name: match.matched_name,
          shipping_name: row.shipping_full_name || null,
          ...(targetDate
            ? {
                date_match: diff !== null && Math.abs(diff) <= DATE_TOLERANCE_DAYS,
                date_basis: detail.payment_date ? 'payment_date' : payRef ? 'transaction_date' : null,
              }
            : {}),
          ...formatOrder(detail, extras),
        };
      }),
    );

    let ambiguous = is_ambiguous;
    let resolved_by_date = false;
    if (targetDate) {
      // Order yang tanggal bayarnya cocok naik ke atas.
      const gap = (o) => {
        const ref = o.payment_date || (o.is_paid ? o.transaction_date : null);
        const d = diffDays(wibDateOf(ref), targetDate);
        return d === null ? Number.MAX_SAFE_INTEGER : Math.abs(d);
      };
      orders.sort((a, b) => gap(a) - gap(b) || b.match_score - a.match_score);
      // Tanggal bayar memecah ambiguitas hanya jika TEPAT SATU pelanggan
      // yang tanggalnya cocok — kalau dua-duanya cocok, tetap ambigu.
      // Identitas orang pakai normalizeName (konsisten dgn decideMatches):
      // "| Komang Budiasa" dan "Komang Budiasa" adalah orang yang sama.
      if (ambiguous) {
        const matchedPersons = new Set(
          orders.filter((o) => o.date_match).map((o) => normalizeName(o.matched_name || '')),
        );
        if (matchedPersons.size === 1) {
          const person = [...matchedPersons][0];
          orders = orders.filter((o) => normalizeName(o.matched_name || '') === person);
          ambiguous = false;
          resolved_by_date = true;
        }
      }
    }

    // Lacak resi saat hasil TIDAK ambigu — untuk SEMUA order milik orang
    // yang sama dengan hasil teratas (pelanggan bisa punya beberapa order
    // aktif), maks 3 demi kuota BinderByte. Hasil ambigu tidak dilacak:
    // jangan tampilkan posisi paket orang yang belum tentu benar.
    if (!ambiguous && orders.length) {
      const person = normalizeName(orders[0].matched_name || '');
      const targets = orders
        .filter((o) => normalizeName(o.matched_name || '') === person)
        .slice(0, 3);
      await Promise.all(
        targets.map(async (o) => {
          const detail = detailByNo.get(o.salesorder_no);
          const tracking = detail ? await trackOrder(detail) : null;
          if (tracking) {
            o.tracking = tracking;
            logEvent(req, 'tracking.result', { salesorder_no: o.salesorder_no, awb: tracking.awb, courier: tracking.courier, status: tracking.status || null, error: tracking.error || null });
          }
        }),
      );
    }

    logEvent(req, 'byname.result', {
      name,
      date: targetDate,
      total_found,
      count: orders.length,
      is_ambiguous: ambiguous,
      resolved_by_date,
      queries_tried,
      orders: orders.map((o) => ({
        salesorder_no: o.salesorder_no,
        matched_name: o.matched_name,
        confidence: o.confidence,
        score: o.match_score,
        status: o.status,
        ...(targetDate ? { date_match: o.date_match } : {}),
      })),
    });
    return res.json({
      input: name,
      ...(channel ? { channel } : {}),
      ...(targetDate ? { date: targetDate, resolved_by_date } : {}),
      total_found,
      count: orders.length,
      is_ambiguous: ambiguous,
      ...(ambiguous
        ? { hint: 'Ada beberapa pelanggan berbeda dengan nama mirip — konfirmasi dulu ke pelanggan (mis. minta tanggal bayar) sebelum memakai hasil teratas.' }
        : {}),
      orders,
    });
  } catch (err) {
    logEvent(req, 'byname.error', {
      name,
      message: err.message,
      upstream_status: err.response?.status || null,
      upstream_body: truncate(err.response?.data, 300),
      stack: truncate(err.stack, 800),
    });
    const status = err.response?.status || 500;
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: 'Gagal mencari pesanan berdasarkan nama',
      message: err.message,
      upstream: err.response?.data,
    });
  }
}

app.post('/api/orders/by-name', handleSearchByName);
// GET sengaja tidak didukung — arahkan pemakai ke POST body JSON.
app.get('/api/orders/by-name', (_req, res) => {
  res.status(405).json({
    error: 'Gunakan POST dengan body raw JSON',
    hint: 'POST /api/orders/by-name  body: { "name": "Komang Rahayu" }',
  });
});

app.get('/api/orders/sample', async (req, res) => {
  const status = String(req.query.status || 'completed');
  const q = String(req.query.q || '');
  const pageSize = Math.min(50, Number(req.query.limit) || 10);
  try {
    const rows = await listOrders({ status, q, pageSize });
    res.json({ status, q, count: rows.length, rows });
  } catch (err) {
    const code = err.response?.status || 500;
    res.status(code).json({ error: err.message, upstream: err.response?.data });
  }
});

// ---- Webhook Shopify: fulfillments/create -> auto-isi Kurir di Jubelio ----
// Didaftarkan di Shopify Admin > Settings > Notifications > Webhooks dengan
// event "Fulfillment creation". Saat order di-mark as fulfilled, Shopify
// mengirim payload berisi tracking_url; kita map ke nama kurir (jnt/lion/jne)
// dan mengisi field Kurir order Jubelio padanannya (SHF-{no}) bila masih
// "Domestic Shipping"/kosong. Idempoten: retry Shopify aman.
app.post('/webhooks/shopify/fulfillment', async (req, res) => {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    logEvent(req, 'shopify.webhook.misconfig', { message: 'SHOPIFY_WEBHOOK_SECRET belum di-set' });
    return res.status(503).json({ error: 'webhook belum dikonfigurasi' });
  }

  // Verifikasi tanda tangan: HMAC-SHA256 atas raw body, base64, dibanding
  // header X-Shopify-Hmac-Sha256 secara constant-time.
  const givenHmac = String(req.get('X-Shopify-Hmac-Sha256') || '');
  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(givenHmac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logEvent(req, 'shopify.webhook.bad_hmac', {});
    return res.status(401).json({ error: 'HMAC tidak valid' });
  }

  const f = req.body || {};
  // name fulfillment = "{order_name}.{n}", mis. "#8543.1" -> nomor order 8543.
  const orderNum = String(f.name || '').replace(/^#/, '').split('.')[0];
  const trackingUrls = [
    ...(Array.isArray(f.tracking_urls) ? f.tracking_urls : []),
    ...(f.tracking_url ? [f.tracking_url] : []),
  ];
  // URL diprioritaskan; nama kurir (tracking_company) fallback untuk
  // fulfillment manual tanpa URL (kasus #8528).
  const shipper = shipperFromFulfillment({
    urls: trackingUrls,
    companies: f.tracking_company ? [f.tracking_company] : [],
  });
  const base = {
    order: orderNum,
    order_id: f.order_id,
    tracking_urls: trackingUrls,
    shipper,
    topic: req.get('X-Shopify-Topic') || null,
    shop: req.get('X-Shopify-Shop-Domain') || null,
  };

  // PENTING: balasan non-2xx yang terus-menerus membuat Shopify MENGHAPUS
  // webhook ini. Semua kondisi "tidak bisa diproses" dibalas 200 + log;
  // cron harian /api/cron/sync-shipper menjadi jaring pengaman yang
  // menjamin order terlewat tetap terisi. 5xx hanya untuk gangguan
  // sementara (Jubelio down) di mana retry Shopify memang menolong.
  if (!orderNum && f.order_id == null) {
    logEvent(req, 'shopify.webhook.skip', { ...base, reason: 'payload tanpa name/order_id' });
    return res.status(200).json({ skipped: 'payload tanpa name/order_id' });
  }
  if (!shipper) {
    logEvent(req, 'shopify.webhook.skip', {
      ...base,
      reason: 'tracking URL/kurir tidak dikenal mapping',
      tracking_company: f.tracking_company || null,
    });
    return res.status(200).json({ skipped: 'tracking URL/kurir tidak dikenal', tracking_urls: trackingUrls, tracking_company: f.tracking_company || null });
  }

  try {
    // Retry 3x (backoff+jitter) untuk error sementara sebelum menyerah.
    const resolved = await withRetry(
      () => resolveOrderForShopify({ orderNum, shopifyOrderId: f.order_id }),
      { label: `webhook.resolve:${orderNum}`, onRetry: (r) => logEvent(req, 'shopify.webhook.retry', r) },
    );
    if (!resolved) {
      logEvent(req, 'shopify.webhook.notfound', base);
      return res.status(200).json({ skipped: 'order belum ketemu di Jubelio — akan disapu cron harian' });
    }
    const { detail, via } = resolved;
    const current = currentShipperOf(detail);
    if (!isFillable(current)) {
      logEvent(req, 'shopify.webhook.skip', { ...base, reason: 'kurir sudah terisi', current });
      return res.status(200).json({ skipped: 'kurir sudah terisi', current });
    }

    const { afterValue, changed } = await withRetry(
      () => applyShipper(detail, shipper),
      { label: `webhook.apply:${orderNum}`, onRetry: (r) => logEvent(req, 'shopify.webhook.retry', r) },
    );
    logEvent(req, changed ? 'shopify.webhook.filled' : 'shopify.webhook.unverified', {
      ...base,
      salesorder_no: detail.salesorder_no,
      resolved_via: via,
      before: current,
      after: afterValue,
    });
    if (!changed) {
      // Update terkirim tapi hasil baca-ulang beda — jangan retry (bisa jadi
      // race dgn sinkronisasi channel); cron akan mengevaluasi ulang.
      return res.status(200).json({ warning: 'update terkirim, verifikasi beda', after: afterValue });
    }
    return res.status(200).json({ updated: detail.salesorder_no, shipper });
  } catch (err) {
    logEvent(req, 'shopify.webhook.error', { ...base, message: err.message, upstream: truncate(err.response?.data, 300) });
    // Sudah 3x dicoba tapi tetap gagal -> laporan diagnostik lengkap ke
    // Telegram (throttle per order 15 menit — retry Shopify berikutnya tidak
    // mengirim duplikat), lalu 500 agar Shopify retry (idempoten).
    await notifyError({
      title: 'Webhook auto-fill kurir GAGAL setelah retry',
      layer: 'webhook fulfillments/create',
      context: {
        'order Shopify': `#${orderNum}`,
        'order_id Shopify': f.order_id,
        'kurir target': shipper,
        'tracking URL': trackingUrls.join(', ') || null,
        'tracking company': f.tracking_company || null,
        'shop domain': base.shop,
        'tindak lanjut': 'Shopify retry otomatis; cron 05:30 WIB jadi cadangan',
      },
      error: err,
      key: `webhook:${orderNum || f.order_id}`,
    });
    return res.status(500).json({ error: err.message });
  }
});

// ---- Cron Vercel: jaring pengaman harian -----------------------------------
// Menyapu order Shopify 3 hari terakhir dan mengisi kurir yang terlewat
// webhook (server down, order belum tersinkron ke Jubelio saat webhook tiba,
// dsb). Vercel mengirim header "Authorization: Bearer {CRON_SECRET}".
app.get('/api/cron/sync-shipper', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logEvent(req, 'cron.sync.misconfig', { message: 'CRON_SECRET belum di-set' });
    return res.status(503).json({ error: 'cron belum dikonfigurasi' });
  }
  if (req.get('Authorization') !== `Bearer ${secret}`) {
    logEvent(req, 'cron.sync.unauthorized', {});
    return res.status(401).json({ error: 'unauthorized' });
  }

  const days = Math.min(14, Number(req.query.days) || 3);
  try {
    const lines = [];
    const stats = await syncShippers({ days, apply: true, log: (l) => lines.push(l) });
    logEvent(req, 'cron.sync.done', { days, ...stats, detail: truncate(lines.join(' | '), 1500) });
    return res.status(200).json({ days, stats });
  } catch (err) {
    // Gagal total (mis. Shopify tak terjangkau setelah retry) -> Telegram.
    logEvent(req, 'cron.sync.error', { days, message: err.message });
    await notifyError({
      title: 'Cron sync kurir GAGAL TOTAL',
      layer: 'cron /api/cron/sync-shipper',
      context: { 'rentang hari': days, 'tindak lanjut': 'cek Vercel Logs; jalankan manual: node scripts/sync-shipper-from-shopify.js --apply' },
      error: err,
      key: 'cron:fatal',
    });
    return res.status(500).json({ error: err.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Route tidak ditemukan' });
});

// Error handler: JSON rusak (dilempar express.json SEBELUM middleware logger,
// jadi request-nya di-log di sini) + error tak tertangani lainnya.
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    logEvent(req, 'body.parse.error', {
      method: req.method,
      path: req.path,
      ua: req.headers['user-agent'] || null,
      content_type: req.headers['content-type'] || null,
      message: err.message,
      body_raw: truncate(err.body, 300),
    });
    return res.status(400).json({
      error: 'Body bukan JSON valid',
      detail: err.message,
      hint: 'Kirim raw JSON dengan header Content-Type: application/json, contoh: { "name": "Komang Rahayu" }',
    });
  }
  logEvent(req, 'unhandled.error', {
    method: req.method,
    path: req.path,
    message: err.message,
    stack: truncate(err.stack, 800),
  });
  res.status(500).json({ error: 'Internal error', message: err.message });
});

// Di Vercel app di-export dan HTTP server dikelola platform; listen hanya
// saat dijalankan langsung (npm start / npm run dev).
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
    console.log(`POST /api/orders/lookup  body: { "salesorder_no": "<kode pesanan>" }`);
    console.log(`POST /api/orders/by-name body: { "name": "<nama pemesan/penerima>" }  (fuzzy, toleran typo)`);
  });
}

module.exports = app;
