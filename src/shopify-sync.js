// Sweep: tarik order Shopify N hari terakhir, map tracking URL fulfillment ->
// kurir, isi field Kurir order Jubelio padanannya. Dipakai oleh cron
// /api/cron/sync-shipper (jaring pengaman harian bila ada webhook yang
// terlewat) dan scripts/sync-shipper-from-shopify.js (backfill manual).
const {
  resolveOrderForShopify,
  shipperFromFulfillment,
  isFillable,
  currentShipperOf,
  applyShipper,
} = require('./shipper');
const { withRetry } = require('./retry');
const { notifyTelegram, describeError } = require('./notify');

const SHOPIFY_API_VERSION = '2026-07';

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
    // eslint-disable-next-line no-loop-func
    const json = await withRetry(async () => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables: { cursor, search: `created_at:>='${since}'` } }),
      });
      if (!res.ok) {
        const err = new Error(`Shopify HTTP ${res.status}`);
        err.status = res.status; // 5xx/429 -> transient, akan di-retry
        throw err;
      }
      return res.json();
    }, { label: 'shopify.orders' });
    if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
    const conn = json.data.orders;
    for (const { node } of conn.edges) orders.push(node);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return orders;
}

function trackingOf(fulfillments) {
  const infos = (fulfillments || []).flatMap((f) => f.trackingInfo || []).filter((t) => t.url || t.company);
  if (!infos.length) return null;
  const urls = infos.map((t) => t.url).filter(Boolean);
  const companies = infos.map((t) => t.company).filter(Boolean);
  return {
    shipper: shipperFromFulfillment({ urls, companies }),
    urls: urls.length ? urls : companies, // untuk pesan log "URL tak dikenal"
    number: infos[0].number,
  };
}

// Jalankan sweep. `log` opsional (per baris, untuk CLI); hasilnya statistik.
async function syncShippers({ days = 7, apply = false, log = () => {} } = {}) {
  const shopifyOrders = await fetchShopifyOrders(days);
  log(`${shopifyOrders.length} order Shopify (${days} hari terakhir). Mode: ${apply ? 'APPLY' : 'dry-run'}`);

  const stats = {
    total: shopifyOrders.length,
    filled: 0,
    skipped_manual: 0,
    no_tracking: 0,
    unknown_url: 0,
    not_found: 0,
    failed: 0,
  };
  const failures = [];

  for (const so of shopifyOrders) {
    const orderNum = String(so.name || '').replace(/^#/, '');
    const label = `#${orderNum}`;
    const tracking = trackingOf(so.fulfillments);

    if (!tracking) {
      stats.no_tracking += 1;
      continue;
    }
    if (!tracking.shipper) {
      stats.unknown_url += 1;
      log(`! ${label}: tracking URL tidak dikenal mapping (${tracking.urls.join(', ')})`);
      continue;
    }

    try {
      const resolved = await withRetry(
        () => resolveOrderForShopify({ orderNum, shopifyOrderId: so.legacyResourceId }),
        { label: `resolve:${label}` },
      );
      if (!resolved) {
        stats.not_found += 1;
        log(`✗ ${label}: tidak ketemu di Jubelio (SHF-${orderNum} / ref ${so.legacyResourceId})`);
        failures.push(
          `${label} — tidak ketemu di Jubelio\n  dicari sebagai: SHF-${orderNum}, lalu ref_no ${so.legacyResourceId}\n  kemungkinan: order belum tersinkron ke Jubelio / order store lain / order tes`,
        );
        continue;
      }
      const { detail } = resolved;
      const current = currentShipperOf(detail);
      if (!isFillable(current)) {
        stats.skipped_manual += 1;
        continue;
      }

      if (!apply) {
        stats.filled += 1;
        log(`~ ${detail.salesorder_no}: "${current || '(kosong)'}" -> "${tracking.shipper}" [dry-run]`);
        continue;
      }

      const { afterValue, changed } = await withRetry(
        () => applyShipper(detail, tracking.shipper),
        { label: `apply:${label}` },
      );
      log(
        `${changed ? '✓' : '?'} ${detail.salesorder_no}: "${current || '(kosong)'}" -> "${afterValue}"` +
          `${changed ? '' : ' — CEK MANUAL'}`,
      );
      if (changed) stats.filled += 1;
      else {
        stats.failed += 1;
        failures.push(
          `${detail.salesorder_no} — update terkirim tapi hasil baca-ulang beda\n  diharapkan: "${tracking.shipper}", terbaca: "${afterValue}"\n  kemungkinan: race dgn sinkronisasi channel Jubelio — cek manual order ini`,
        );
      }
    } catch (err) {
      stats.failed += 1;
      const status = err.response?.status;
      log(`✗ ${label}: gagal${status ? ` (HTTP ${status})` : ''} — ${err.message}`);
      // Diagnostik lengkap per order (request mana, HTTP status, body respons
      // upstream, riwayat retry) supaya root cause langsung kelihatan.
      failures.push(
        `${label} (kurir target: ${tracking.shipper}, resi: ${tracking.number || '-'})\n` +
          describeError(err, { maxBody: 300 })
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n'),
      );
    }
  }

  // Kegagalan yang bertahan setelah retry -> satu notifikasi Telegram berisi
  // diagnostik per order (dibatasi 8 order supaya muat; sisanya dihitung).
  if (failures.length) {
    const shown = failures.slice(0, 8);
    await notifyTelegram(
      `🛑 Auto-fill kurir Jubelio: ${failures.length} order gagal setelah retry\n` +
        `Mode: ${apply ? 'apply' : 'dry-run'} | Rentang: ${days} hari | Waktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB\n\n` +
        shown.map((l, i) => `${i + 1}) ${l}`).join('\n\n') +
        (failures.length > shown.length ? `\n\n…dan ${failures.length - shown.length} order lain (lihat Vercel Logs)` : ''),
      { key: 'sync-shipper:failures' },
    );
  }

  return stats;
}

module.exports = { fetchShopifyOrders, syncShippers, trackingOf, SHOPIFY_API_VERSION };
