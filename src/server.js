require('dotenv').config();
const express = require('express');
const { smartLookup, listOrders } = require('./jubelio');
const { formatOrder } = require('./format');

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

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`POST /api/orders/lookup  body: { "salesorder_no": "<kode pesanan>" }`);
});
