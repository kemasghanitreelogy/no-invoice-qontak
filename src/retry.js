// Retry dengan exponential backoff + jitter (praktik standar SDK AWS/Google:
// 3 percobaan total). Hanya error SEMENTARA yang diulang — 4xx (selain 429)
// berarti request-nya memang salah dan pasti gagal lagi, jadi langsung lempar.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransient(err) {
  const status = err?.response?.status ?? err?.status;
  if (status != null) return status >= 500 || status === 429;
  // Tanpa status = error network/timeout (axios ECONNRESET, fetch TypeError).
  return true;
}

async function withRetry(fn, { attempts = 3, baseMs = 500, maxMs = 4000, label = '', onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransient(err)) throw err;
      const delayMs = Math.round(Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5));
      if (onRetry) onRetry({ attempt, delayMs, label, message: err.message });
      else console.log(JSON.stringify({ t: new Date().toISOString(), event: 'retry', label, attempt, delayMs, message: err.message }));
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isTransient };
