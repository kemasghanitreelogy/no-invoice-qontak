// Test normalisasi parameter channel (sinonim + anti-typo) dan mapping row.
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveChannel, channelOfRow } = require('../src/channels');

const canon = (v) => resolveChannel(v)?.canonical ?? null;

test('resolveChannel: nama kanonik & case-insensitive', () => {
  assert.equal(canon('shopify'), 'shopify');
  assert.equal(canon('SHOPEE'), 'shopee');
  assert.equal(canon('Tokopedia'), 'tokopedia');
  assert.equal(canon('TikTok'), 'tiktok');
  assert.equal(canon('internal'), 'internal');
});

test('resolveChannel: sinonim umum', () => {
  assert.equal(canon('tokped'), 'tokopedia');
  assert.equal(canon('toped'), 'tokopedia');
  assert.equal(canon('tik tok'), 'tiktok');
  assert.equal(canon('tiktok shop'), 'tiktok');
  assert.equal(canon('web'), 'shopify');
  assert.equal(canon('website'), 'shopify');
  assert.equal(canon('wa'), 'internal');
  assert.equal(canon('whatsapp'), 'internal');
});

test('resolveChannel: toleran typo ringan, kata pendek wajib exact', () => {
  assert.equal(canon('tokpedia'), 'tokopedia'); // 1 edit
  assert.equal(canon('shopfy'), 'shopify'); // 1 edit
  assert.equal(canon('tiktik'), 'tiktok'); // 1 edit
  assert.equal(canon('shoppee'), 'shopee'); // 1 edit
  // kata pendek: "tp" vs "tt" cuma 1 edit — harus exact, jangan nyasar
  assert.equal(canon('tp'), 'tokopedia');
  assert.equal(canon('tt'), 'tiktok');
  assert.equal(canon('tx'), null);
});

test('resolveChannel: input tak dikenal -> null', () => {
  assert.equal(canon('lazada'), null); // toko ini tidak jualan di lazada
  assert.equal(canon('bukalapak'), null);
  assert.equal(canon(''), null);
  assert.equal(canon(null), null);
});

test('channelOfRow: channel_name utama, termasuk "Shop | Tokopedia" = tiktok', () => {
  assert.equal(channelOfRow({ channel_name: 'SHOPIFY' }), 'shopify');
  assert.equal(channelOfRow({ channel_name: 'SHOPEE' }), 'shopee');
  assert.equal(channelOfRow({ channel_name: 'TOKOPEDIA' }), 'tokopedia');
  assert.equal(channelOfRow({ channel_name: 'Shop | Tokopedia' }), 'tiktok');
  assert.equal(channelOfRow({ channel_name: 'INTERNAL' }), 'internal');
});

test('channelOfRow: fallback prefix salesorder_no bila channel_name kosong', () => {
  assert.equal(channelOfRow({ salesorder_no: 'SHF-8519-128887' }), 'shopify');
  assert.equal(channelOfRow({ salesorder_no: 'SP-2604172NXMGGQ8' }), 'shopee');
  assert.equal(channelOfRow({ salesorder_no: 'TP-123-1' }), 'tokopedia');
  assert.equal(channelOfRow({ salesorder_no: 'TT-999' }), 'tiktok');
  assert.equal(channelOfRow({ salesorder_no: 'WS-465FKG8WRE2C6N9WTD' }), 'internal');
  assert.equal(channelOfRow({ salesorder_no: 'XX-1' }), null); // tak dikenal -> null
  assert.equal(channelOfRow({}), null);
});
