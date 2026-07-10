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

module.exports = { notifyTelegram };
