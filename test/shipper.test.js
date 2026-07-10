// Test unit + integrasi (tanpa network ke Jubelio/Shopify) untuk auto-fill kurir.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  shipperForTrackingUrl,
  shipperFromTrackingUrls,
  isFillable,
  currentShipperOf,
  buildSavePayload,
} = require('../src/shipper');

// ---- mapping tracking URL -> kurir -----------------------------------------

test('mapping tracking URL sesuai keputusan user (jnt/lion/jne)', () => {
  assert.equal(shipperForTrackingUrl('https://jet.co.id/track'), 'jnt');
  assert.equal(shipperForTrackingUrl('https://lionparcel.com/track/stt'), 'lion');
  assert.equal(shipperForTrackingUrl('https://jne.co.id/tracking-package'), 'jne');
});

test('mapping URL: case-insensitive, query string, dan URL tak dikenal', () => {
  assert.equal(shipperForTrackingUrl('HTTPS://JET.CO.ID/track?awb=123'), 'jnt');
  assert.equal(shipperForTrackingUrl('https://spx.co.id/track'), null);
  assert.equal(shipperForTrackingUrl(''), null);
  assert.equal(shipperForTrackingUrl(null), null);
});

test('shipperFromTrackingUrls memeriksa SEMUA url, bukan hanya yang pertama', () => {
  assert.equal(shipperFromTrackingUrls(['https://spx.co.id/x', 'https://jne.co.id/y']), 'jne');
  assert.equal(shipperFromTrackingUrls(['https://spx.co.id/x']), null);
  assert.equal(shipperFromTrackingUrls([]), null);
  assert.equal(shipperFromTrackingUrls(undefined), null);
});

// ---- kebijakan isi/lewati ---------------------------------------------------

test('isFillable: hanya placeholder yang boleh diisi otomatis', () => {
  assert.equal(isFillable(''), true);
  assert.equal(isFillable(null), true);
  assert.equal(isFillable('Domestic Shipping'), true);
  assert.equal(isFillable('  domestic shipping  '), true);
  assert.equal(isFillable('J&T REG'), false); // isian manual tidak ditimpa
  assert.equal(isFillable('jnt'), false); // sudah pernah diisi
});

test('currentShipperOf: header dulu, fallback ke item', () => {
  assert.equal(currentShipperOf({ shipper: 'lion', items: [] }), 'lion');
  assert.equal(currentShipperOf({ items: [{ shipper: 'jne' }] }), 'jne');
  assert.equal(currentShipperOf({ items: [{}] }), '');
  assert.equal(currentShipperOf({}), '');
});

// ---- payload edit Jubelio ---------------------------------------------------

const DETAIL = {
  salesorder_id: 7430,
  salesorder_no: 'SHF-8506-128887',
  contact_id: 8251,
  customer_name: 'Timotius Randy',
  transaction_date: '2026-07-07T09:00:14.000Z',
  sub_total: '690000.0000',
  total_disc: null, // <- field WAJIB yang null di detail: tetap harus dikirim
  total_tax: null,
  grand_total: '590000.0000',
  location_id: -1,
  source: 1048576,
  add_disc: '125000.0000',
  is_paid: true,
  ref_no: '6559579046076',
  shipping_full_name: 'Timotius Randy',
  salesmen_id: null, // <- opsional null: TIDAK boleh ikut terkirim
  items: [
    {
      salesorder_detail_id: 1,
      item_id: 14,
      price: '690000.0000',
      qty_in_base: '1.0000',
      disc: 0,
      disc_amount: 0,
      tax_amount: 0,
      amount: '565000.0000',
      loc_id: -1, // <- detail pakai loc_id, skema edit minta location_id
      tracking_no: null,
      item_name: 'Moringa 180 Caps', // <- di luar skema edit: tidak ikut
    },
  ],
};

test('buildSavePayload: field wajib selalu ada walau null di detail', () => {
  const p = buildSavePayload(DETAIL, 'jnt');
  for (const k of [
    'salesorder_id', 'salesorder_no', 'contact_id', 'customer_name',
    'transaction_date', 'sub_total', 'total_disc', 'total_tax', 'grand_total',
    'location_id', 'source', 'add_fee', 'add_disc', 'service_fee', 'items',
  ]) {
    assert.ok(k in p, `field wajib "${k}" hilang dari payload`);
  }
  assert.equal(p.total_disc, 0);
  assert.equal(p.total_tax, 0);
  assert.equal(p.add_fee, 0);
  assert.equal(p.service_fee, 0);
});

test('buildSavePayload: edit in-place, hanya kurir yang berubah', () => {
  const p = buildSavePayload(DETAIL, 'jnt');
  assert.equal(p.salesorder_id, 7430); // bukan 0 -> mode edit, bukan create
  assert.equal(p.salesorder_no, 'SHF-8506-128887');
  assert.equal(p.grand_total, '590000.0000'); // angka uang tak tersentuh
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].shipper, 'jnt');
  assert.equal(p.items[0].amount, '565000.0000');
});

test('buildSavePayload: loc_id item dipetakan ke location_id', () => {
  const p = buildSavePayload(DETAIL, 'jnt');
  assert.equal(p.items[0].location_id, -1);
});

test('buildSavePayload: field di luar skema edit & opsional null tidak dikirim', () => {
  const p = buildSavePayload(DETAIL, 'jnt');
  assert.ok(!('item_name' in p.items[0]));
  assert.ok(!('tracking_no' in p.items[0])); // null -> tidak dikirim
  assert.ok(!('salesmen_id' in p)); // opsional null -> tidak dikirim
  assert.ok(!('items' in p.items[0]));
});

// ---- webhook endpoint (integrasi, tanpa memanggil Jubelio) ------------------

const WEBHOOK_SECRET = 'test-secret-webhook';
process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.CRON_SECRET = 'test-secret-cron';
const app = require('../src/server');

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

function signedHeaders(body, secret = WEBHOOK_SECRET) {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', secret).update(body).digest('base64'),
  };
}

test('webhook: HMAC salah ditolak 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/webhooks/shopify/fulfillment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': 'aW52YWxpZA==' },
      body: JSON.stringify({ name: '#1.1' }),
    });
    assert.equal(res.status, 401);
  });
});

test('webhook: HMAC dihitung dari secret berbeda ditolak 401', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ name: '#1.1' });
    const res = await fetch(`${base}/webhooks/shopify/fulfillment`, {
      method: 'POST',
      headers: signedHeaders(body, 'secret-lain'),
      body,
    });
    assert.equal(res.status, 401);
  });
});

test('webhook: tracking URL tak dikenal -> 200 skip (Shopify tidak retry)', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ name: '#1.1', order_id: 9, tracking_url: 'https://spx.co.id/x' });
    const res = await fetch(`${base}/webhooks/shopify/fulfillment`, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.skipped);
  });
});

test('webhook: payload tanpa name & order_id -> 200 skip', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ tracking_url: 'https://jne.co.id/x' });
    const res = await fetch(`${base}/webhooks/shopify/fulfillment`, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.skipped);
  });
});

test('cron: tanpa/salah Bearer ditolak 401', async () => {
  await withServer(async (base) => {
    const noAuth = await fetch(`${base}/api/cron/sync-shipper`);
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${base}/api/cron/sync-shipper`, {
      headers: { Authorization: 'Bearer salah' },
    });
    assert.equal(badAuth.status, 401);
  });
});

// ---- fallback nama kurir (fulfillment manual tanpa tracking URL) ------------

const { shipperFromCompanies, shipperFromFulfillment } = require('../src/shipper');

test('shipperFromCompanies: J&T Express/JNE/Lion Parcel dikenali', () => {
  assert.equal(shipperFromCompanies(['J&T Express']), 'jnt');
  assert.equal(shipperFromCompanies(['JNE']), 'jne');
  assert.equal(shipperFromCompanies(['Lion Parcel']), 'lion');
  assert.equal(shipperFromCompanies(['UPS']), null);
  assert.equal(shipperFromCompanies([]), null);
});

test('shipperFromFulfillment: URL diprioritaskan, company jadi fallback', () => {
  // kasus #8528: company terisi, url null
  assert.equal(shipperFromFulfillment({ urls: [], companies: ['J&T Express'] }), 'jnt');
  // URL menang atas company bila keduanya ada dan beda
  assert.equal(
    shipperFromFulfillment({ urls: ['https://jne.co.id/x'], companies: ['J&T Express'] }),
    'jne',
  );
  assert.equal(shipperFromFulfillment({ urls: [], companies: ['Other'] }), null);
  assert.equal(shipperFromFulfillment({}), null);
});
