// Notifikasi Telegram via bot (dibuat lewat @BotFather).
// Butuh di env: TELEGRAM_BOT_TOKEN (dari BotFather) dan TELEGRAM_CHAT_ID
// (id chat/grup tujuan). Bila belum di-set, notifikasi dilewati dengan log —
// tidak pernah menggagalkan alur utama.
const THROTTLE_MS = 15 * 60 * 1000;
const lastSentAt = new Map(); // key -> epoch ms (per instance serverless)

async function notifyTelegram(text, { key = null } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'telegram.skip', reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID belum di-set' }));
    return false;
  }
  // Throttle per topik supaya outage panjang tidak membanjiri chat.
  if (key) {
    const last = lastSentAt.get(key) || 0;
    if (Date.now() - last < THROTTLE_MS) return false;
    lastSentAt.set(key, Date.now());
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.description || `HTTP ${res.status}`);
    return true;
  } catch (err) {
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'telegram.error', message: err.message }));
    return false;
  }
}

// ---- laporan error detail untuk root-cause analysis ------------------------

const wibNow = () =>
  new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'medium' }) + ' WIB';

// Bongkar error (axios/fetch/manual) jadi baris-baris diagnostik:
// request mana yang gagal, HTTP status, BODY RESPONS UPSTREAM (di sinilah
// root cause Jubelio/Shopify biasanya tertulis), kode network, riwayat
// retry, dan potongan stack.
function describeError(err, { maxBody = 700 } = {}) {
  const lines = [`Pesan: ${err?.message || String(err)}`];

  const cfg = err?.config || err?.response?.config;
  if (cfg?.url) {
    const method = String(cfg.method || 'GET').toUpperCase();
    lines.push(`Request gagal: ${method} ${cfg.baseURL || ''}${cfg.url}`);
    if (cfg.params && Object.keys(cfg.params).length) lines.push(`Params: ${JSON.stringify(cfg.params).slice(0, 200)}`);
  }

  const status = err?.response?.status ?? err?.status;
  if (status != null) {
    lines.push(`HTTP status: ${status}${err?.response?.statusText ? ` ${err.response.statusText}` : ''}`);
  }

  const data = err?.response?.data;
  if (data !== undefined && data !== null && data !== '') {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    lines.push(`Respons upstream (root cause biasanya di sini):\n${body.slice(0, maxBody)}${body.length > maxBody ? `\n…(terpotong, total ${body.length} char)` : ''}`);
  }

  if (err?.code) lines.push(`Kode network: ${err.code}`); // mis. ECONNRESET/ETIMEDOUT

  if (err?.retryInfo) {
    const { label, attempts, history } = err.retryInfo;
    lines.push(`Retry: ${attempts}x gagal semua${label ? ` [${label}]` : ''}`);
    for (const h of history) {
      lines.push(`  • percobaan ${h.attempt}: ${h.status ? `HTTP ${h.status} — ` : ''}${h.message}${h.delayMs ? ` (tunggu ${h.delayMs}ms)` : ''}`);
    }
  }

  if (err?.stack) {
    lines.push(`Stack (teratas):\n${err.stack.split('\n').slice(0, 4).join('\n')}`);
  }
  return lines.join('\n');
}

// Notifikasi error terstruktur: judul, waktu WIB, lapisan, konteks order,
// lalu diagnostik lengkap dari describeError.
async function notifyError({ title, layer, context = {}, error, key = null }) {
  const ctxLines = Object.entries(context)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const text = [
    `🛑 ${title}`,
    `Waktu: ${wibNow()}`,
    layer ? `Lapisan: ${layer}` : null,
    ctxLines.length ? `— Konteks —\n${ctxLines.join('\n')}` : null,
    `— Diagnostik —\n${describeError(error)}`,
  ]
    .filter(Boolean)
    .join('\n');
  return notifyTelegram(text, { key });
}

module.exports = { notifyTelegram, notifyError, describeError };
