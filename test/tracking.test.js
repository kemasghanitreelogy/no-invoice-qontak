// Test pelacakan BinderByte + resolusi telepon (fetch di-mock, tanpa network).
const { test } = require('node:test');
const assert = require('node:assert');

const { detectCourier, awbOf, trackOrder } = require('../src/binderbyte');
const { isMaskedPhone, phoneDigits, last5 } = require('../src/phone');

// ---- deteksi kurir -----------------------------------------------------------

test('detectCourier: dari shipper (auto-fill & manual)', () => {
  assert.equal(detectCourier('jnt', null), 'jnt');
  assert.equal(detectCourier('lion', null), 'lion');
  assert.equal(detectCourier('jne', null), 'jne');
  assert.equal(detectCourier('J&T REG', null), 'jnt');
  assert.equal(detectCourier('JNE YES', null), 'jne');
  assert.equal(detectCourier('Lion Parcel', null), 'lion');
});

test('detectCourier: fallback prefix AWB bila shipper tak dikenal', () => {
  assert.equal(detectCourier('Domestic Shipping', '11LP1783571534901'), 'lion');
  assert.equal(detectCourier(null, 'JP2255749628'), 'jnt');
  assert.equal(detectCourier('Domestic Shipping', '582230008329223'), null); // digit polos ambigu
  assert.equal(detectCourier('SiCepat REG', 'SC123'), null); // kurir di luar 3 -> tidak dilacak
});

test('awbOf: header dulu, fallback item', () => {
  assert.equal(awbOf({ tracking_no: 'AAA' }), 'AAA');
  assert.equal(awbOf({ items: [{ tracking_no: null }, { tracking_no: 'BBB' }] }), 'BBB');
  assert.equal(awbOf({ items: [] }), null);
});

// ---- helper telepon -----------------------------------------------------------

test('isMaskedPhone / phoneDigits / last5', () => {
  assert.equal(isMaskedPhone('**********95'), true);
  assert.equal(isMaskedPhone(''), true);
  assert.equal(isMaskedPhone(null), true);
  assert.equal(isMaskedPhone('+62816947095'), false);
  assert.equal(phoneDigits('+62 813-3857-8895'), '6281338578895');
  assert.equal(last5('+62 813-3857-8895'), '78895');
  assert.equal(last5('+62816947095'), '47095');
  assert.equal(last5('123'), null); // terlalu pendek
});

// ---- trackOrder dengan fetch di-mock ------------------------------------------

const BB_OK = {
  status: 200,
  message: 'Successfully tracked package',
  data: {
    summary: { awb: '11LP1783571534901', courier: 'Lion Parcel', service: 'REGPACK', status: 'DELIVERED' },
    detail: { origin: 'DENPASAR', destination: 'JAKARTA BARAT', shipper: 'TREELOGY', receiver: 'Grace' },
    history: [
      { date: '2026-07-08 10:00', desc: 'Paket diproses di gudang', location: 'DENPASAR' },
      { date: '2026-07-10 09:00', desc: 'Paket diterima', location: 'JAKARTA BARAT' },
    ],
  },
};

async function withMockFetch(impl, fn) {
  const saved = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = saved;
  }
}

test('trackOrder: sukses — ringkasan + history + last_update terpetakan', async () => {
  process.env.BINDERBYTE_API_KEY = 'kunci-tes';
  const urls = [];
  const result = await withMockFetch(
    async (url) => { urls.push(String(url)); return { ok: true, json: async () => BB_OK }; },
    () => trackOrder({ shipper: 'lion', tracking_no: '11LP1783571534901' }),
  );
  assert.equal(result.courier, 'lion');
  assert.equal(result.status, 'DELIVERED');
  assert.equal(result.history.length, 2);
  assert.equal(result.last_update.desc, 'Paket diterima');
  assert.equal(result.destination, 'JAKARTA BARAT');
  assert.match(urls[0], /courier=lion&awb=11LP1783571534901/);
  assert.ok(!urls[0].includes('number='), 'non-JNE tidak boleh kirim param number');
});

test('trackOrder: JNE menyertakan number=5 digit terakhir dari telepon yang tidak disensor', async () => {
  process.env.BINDERBYTE_API_KEY = 'kunci-tes';
  const urls = [];
  const result = await withMockFetch(
    async (url) => { urls.push(String(url)); return { ok: true, json: async () => BB_OK }; },
    () => trackOrder({ shipper: 'jne', tracking_no: '582230008329223', shipping_phone: '+62816947095' }),
  );
  assert.match(urls[0], /courier=jne/);
  assert.match(urls[0], /number=47095/); // last5 dari shipping_phone (sumber termurah)
  assert.equal(result.phone_last5_source, 'order_detail');
});

test('trackOrder: error BinderByte 400 -> non-fatal, tanpa retry, error apa adanya', async () => {
  process.env.BINDERBYTE_API_KEY = 'kunci-tes';
  let calls = 0;
  const result = await withMockFetch(
    async () => { calls += 1; return { ok: false, status: 400, json: async () => ({ status: 400, message: 'API Key not found' }) }; },
    () => trackOrder({ shipper: 'lion', tracking_no: '11LP1' }),
  );
  assert.equal(calls, 1); // 400 permanen — tidak boleh di-retry
  assert.equal(result.error, 'API Key not found');
  assert.equal(result.awb, '11LP1');
});

test('trackOrder: null bila belum ada resi atau kurir di luar jne/jnt/lion', async () => {
  assert.equal(await trackOrder({ shipper: 'lion', items: [] }), null);
  assert.equal(await trackOrder({ shipper: 'SiCepat', tracking_no: 'SC1' }), null);
  assert.equal(await trackOrder({}), null);
});

test('trackOrder: hasil sukses di-cache (panggilan kedua tanpa fetch), error tidak', async () => {
  process.env.BINDERBYTE_API_KEY = 'kunci-tes';
  let calls = 0;
  const detail = { shipper: 'lion', tracking_no: 'AWB-CACHE-1' };
  await withMockFetch(
    async () => { calls += 1; return { ok: true, json: async () => BB_OK }; },
    async () => {
      await trackOrder(detail);
      await trackOrder(detail); // kedua: dari cache
    },
  );
  assert.equal(calls, 1);

  let errCalls = 0;
  const errDetail = { shipper: 'lion', tracking_no: 'AWB-ERR-1' };
  await withMockFetch(
    async () => { errCalls += 1; return { ok: false, status: 400, json: async () => ({ status: 400, message: 'resi tidak ditemukan' }) }; },
    async () => {
      await trackOrder(errDetail);
      await trackOrder(errDetail); // error tidak di-cache -> fetch lagi
    },
  );
  assert.equal(errCalls, 2);
});
