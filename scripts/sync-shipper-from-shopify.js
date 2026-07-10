#!/usr/bin/env node
// Auto-fill kurir Jubelio dari tracking URL fulfillment Shopify.
//
// Alur: tarik order Shopify N hari terakhir (Admin GraphQL) -> baca tracking
// URL fulfillment -> map ke nama kurir -> cari order padanannya di Jubelio
// (SHF-{no}) -> isi field Kurir bila masih "Domestic Shipping"/kosong.
//
// Pakai:
//   node scripts/sync-shipper-from-shopify.js               # dry-run, 7 hari
//   node scripts/sync-shipper-from-shopify.js --days=3      # dry-run, 3 hari
//   node scripts/sync-shipper-from-shopify.js --apply       # benar-benar mengubah
//
// Butuh di .env: ADMIN_API_KEY (token shpat_...), STORE_NAME,
// JUBELIO_API_USERNAME, JUBELIO_API_PASSWORD.

require('dotenv').config();
const { smartLookup } = require('../src/jubelio');
const { applyShipper, currentShipperOf, shipperForTrackingUrl, isFillable } = require('../src/shipper');

const SHOPIFY_API_VERSION = '2026-07';

function shipperFromTracking(fulfillments) {
  for (const f of fulfillments || []) {
    for (const t of f.trackingInfo || []) {
      if (!t.url) continue;
      return { shipper: shipperForTrackingUrl(t.url), url: t.url, number: t.number };
    }
  }
  return null; // belum ada fulfillment/tracking
}

async function fetchShopifyOrders(days) {
  const store = String(process.env.STORE_NAME || '').replace(/\.myshopify\.com.*$/, '');
  const token = process.env.ADMIN_API_KEY;
  if (!store || !token) throw new Error('STORE_NAME / ADMIN_API_KEY belum di-set di .env');
  const endpoint = `https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  // Divalidasi lawan schema live 2026-07 (shopify-dev validate, artifact ord-track-7d-a1).
  const query = `query OrdersWithTracking($cursor: String, $search: String!) {
    orders(first: 50, after: $cursor, query: $search) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        name
        legacyResourceId
        createdAt
        fulfillments(first: 5) { trackingInfo(first: 10) { company number url } }
      } }
    }
  }`;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const orders = [];
  let cursor = null;
  for (;;) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables: { cursor, search: `created_at:>='${since}'` } }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
    const conn = json.data.orders;
    for (const { node } of conn.edges) orders.push(node);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return orders;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const days = Number((args.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 7;

  console.log(`Menarik order Shopify ${days} hari terakhir... Mode: ${apply ? 'APPLY (mengubah data!)' : 'dry-run'}`);
  const shopifyOrders = await fetchShopifyOrders(days);
  console.log(`${shopifyOrders.length} order Shopify ditemukan.\n`);

  const stats = { filled: 0, skipped_manual: 0, no_tracking: 0, unknown_url: 0, not_found: 0, failed: 0 };

  for (const so of shopifyOrders) {
    const orderNum = so.name.replace(/^#/, '');
    const label = `#${orderNum}`;
    const tracking = shipperFromTracking(so.fulfillments);

    if (!tracking) {
      stats.no_tracking += 1;
      console.log(`- ${label}: belum ada tracking, dilewati`);
      continue;
    }
    if (!tracking.shipper) {
      stats.unknown_url += 1;
      console.log(`! ${label}: tracking URL tidak dikenal mapping (${tracking.url}), dilewati`);
      continue;
    }

    try {
      const result = await smartLookup(`SHF-${orderNum}`);
      if (!result.found) {
        stats.not_found += 1;
        console.log(`✗ ${label}: tidak ketemu di Jubelio (SHF-${orderNum})`);
        continue;
      }
      const detail = result.order;
      // Pengaman salah order: ref_no Jubelio = legacy id order Shopify.
      if (detail.ref_no && String(detail.ref_no) !== String(so.legacyResourceId)) {
        stats.failed += 1;
        console.log(`✗ ${label}: ref_no Jubelio (${detail.ref_no}) tidak cocok dengan id Shopify (${so.legacyResourceId}) — dilewati demi aman`);
        continue;
      }

      const current = currentShipperOf(detail);
      if (!isFillable(current)) {
        stats.skipped_manual += 1;
        console.log(`= ${detail.salesorder_no}: kurir sudah diisi ("${current}"), tidak ditimpa`);
        continue;
      }
      if (current.trim().toLowerCase() === tracking.shipper) {
        stats.skipped_manual += 1;
        continue;
      }

      if (!apply) {
        stats.filled += 1;
        console.log(`~ ${detail.salesorder_no}: "${current || '(kosong)'}" -> "${tracking.shipper}" (resi ${tracking.number}) [dry-run]`);
        continue;
      }

      const { afterValue, changed } = await applyShipper(detail, tracking.shipper);
      console.log(
        `${changed ? '✓' : '?'} ${detail.salesorder_no}: "${current || '(kosong)'}" -> "${afterValue}"` +
          `${changed ? '' : ' — CEK MANUAL, hasil tidak sesuai harapan'}`,
      );
      if (changed) stats.filled += 1;
      else stats.failed += 1;
    } catch (err) {
      stats.failed += 1;
      const status = err.response?.status;
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
      console.log(`✗ ${label}: gagal${status ? ` (HTTP ${status})` : ''} — ${body}`);
    }
  }

  console.log(
    `\nSelesai. Diisi: ${stats.filled}${apply ? '' : ' (dry-run)'}, sudah manual/sama: ${stats.skipped_manual}, ` +
      `belum ada tracking: ${stats.no_tracking}, URL tak dikenal: ${stats.unknown_url}, ` +
      `tidak ketemu di Jubelio: ${stats.not_found}, gagal: ${stats.failed}`,
  );
  process.exit(stats.failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
