// Test logic retry (backoff) dan notifikasi Telegram (tanpa network).
const { test } = require('node:test');
const assert = require('node:assert');
const { withRetry, isTransient } = require('../src/retry');

const httpErr = (status) => {
  const e = new Error(`HTTP ${status}`);
  e.response = { status };
  return e;
};

test('isTransient: 5xx/429/network diulang, 4xx tidak', () => {
  assert.equal(isTransient(httpErr(500)), true);
  assert.equal(isTransient(httpErr(502)), true);
  assert.equal(isTransient(httpErr(429)), true);
  assert.equal(isTransient(httpErr(400)), false);
  assert.equal(isTransient(httpErr(404)), false);
  assert.equal(isTransient(new Error('ECONNRESET')), true); // tanpa status = network
});

test('withRetry: sukses di percobaan kedua setelah 502', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw httpErr(502);
      return 'ok';
    },
    { baseMs: 1, onRetry: () => {} },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry: menyerah setelah 3 percobaan lalu melempar error terakhir', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw httpErr(503);
      },
      { baseMs: 1, onRetry: () => {} },
    ),
    /HTTP 503/,
  );
  assert.equal(calls, 3);
});

test('withRetry: 4xx langsung dilempar tanpa retry', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw httpErr(400);
      },
      { baseMs: 1, onRetry: () => {} },
    ),
    /HTTP 400/,
  );
  assert.equal(calls, 1);
});

test('notifyTelegram: dilewati dengan aman bila env belum di-set', async () => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChat = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  try {
    const { notifyTelegram } = require('../src/notify');
    assert.equal(await notifyTelegram('tes'), false); // skip, tidak melempar
  } finally {
    if (savedToken) process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat) process.env.TELEGRAM_CHAT_ID = savedChat;
  }
});
