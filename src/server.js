require('dotenv').config();
const express = require('express');
const { smartLookup, listOrders, searchOrdersByName, getOrderDetail } = require('./jubelio');
const { formatOrder } = require('./format');
const { parseDateInput, wibDateOf, diffDays } = require('./dates');

const app = express();
app.use(express.json());

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
    return res.json({
      input,
      detected_channel,
      ...summary,
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
// Toleran typo + sinonim. POST body raw JSON: { "name": "...", "date": "..." }.
// - "date" opsional (tanggal BAYAR versi pelanggan/WIB) — dipakai untuk
//   menaikkan akurasi: verifikasi ke payment_date order & memecah ambiguitas.
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
    return res.status(400).json({
      error: 'nama wajib diisi (minimal 3 huruf)',
      hint: 'POST body raw JSON: { "name": "Komang Rahayu" } (alias: nama / customer_name / shipping_name). Opsional "date": tanggal bayar, format YYYY-MM-DD atau DD/MM/YYYY.',
    });
  }

  const dateRaw = req.body?.date ?? req.body?.tanggal ?? req.body?.payment_date;
  let targetDate = null;
  if (dateRaw != null && String(dateRaw).trim() !== '') {
    targetDate = parseDateInput(dateRaw);
    if (!targetDate) {
      return res.status(400).json({
        error: 'format tanggal tidak dikenali',
        hint: 'Gunakan "YYYY-MM-DD" atau "DD/MM/YYYY", contoh: "2026-04-17" atau "17/04/2026"',
      });
    }
  }

  const limit = BY_NAME_LIMIT;
  try {
    const { primary, is_ambiguous, total_found, queries_tried } = await searchOrdersByName(name, {
      limit,
      targetDate,
    });
    if (!primary.length) {
      return res.status(404).json({
        error: 'Tidak ada pesanan yang cocok dengan nama tersebut',
        input: name,
        queries_tried,
      });
    }
    // Detail lengkap hanya untuk kandidat >= probable (privacy: match lemah
    // tidak pernah membuka detail order).
    let orders = await Promise.all(
      primary.map(async ({ row, match }) => {
        const detail = await getOrderDetail(row.salesorder_id);
        const paymentDate = detail.payment_date || null;
        const diff = targetDate ? diffDays(wibDateOf(paymentDate), targetDate) : null;
        return {
          match_score: Number(match.score.toFixed(3)),
          confidence: match.confidence,
          match_basis: match.basis,
          matched_name: match.matched_name,
          shipping_name: row.shipping_full_name || null,
          payment_date: paymentDate,
          ...(targetDate ? { date_match: diff !== null && Math.abs(diff) <= DATE_TOLERANCE_DAYS } : {}),
          ...formatOrder(detail),
        };
      }),
    );

    let ambiguous = is_ambiguous;
    let resolved_by_date = false;
    if (targetDate) {
      // Order yang payment_date-nya cocok naik ke atas.
      const gap = (o) => {
        const d = diffDays(wibDateOf(o.payment_date), targetDate);
        return d === null ? Number.MAX_SAFE_INTEGER : Math.abs(d);
      };
      orders.sort((a, b) => gap(a) - gap(b) || b.match_score - a.match_score);
      // Tanggal bayar memecah ambiguitas hanya jika TEPAT SATU pelanggan
      // yang tanggalnya cocok — kalau dua-duanya cocok, tetap ambigu.
      if (ambiguous) {
        const matchedPersons = new Set(
          orders.filter((o) => o.date_match).map((o) => (o.matched_name || '').toLowerCase().trim()),
        );
        if (matchedPersons.size === 1) {
          const person = [...matchedPersons][0];
          orders = orders.filter((o) => (o.matched_name || '').toLowerCase().trim() === person);
          ambiguous = false;
          resolved_by_date = true;
        }
      }
    }

    return res.json({
      input: name,
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

app.use((_req, res) => {
  res.status(404).json({ error: 'Route tidak ditemukan' });
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
