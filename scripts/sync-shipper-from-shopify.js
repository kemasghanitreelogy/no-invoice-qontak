#!/usr/bin/env node
// Auto-fill kurir Jubelio dari tracking URL fulfillment Shopify (backfill).
// Logika intinya di src/shopify-sync.js — sama dengan cron /api/cron/sync-shipper.
//
// Pakai:
//   node scripts/sync-shipper-from-shopify.js               # dry-run, 7 hari
//   node scripts/sync-shipper-from-shopify.js --days=3      # dry-run, 3 hari
//   node scripts/sync-shipper-from-shopify.js --apply       # benar-benar mengubah
//
// Butuh di .env: ADMIN_API_KEY (token shpat_...), STORE_NAME,
// JUBELIO_API_USERNAME, JUBELIO_API_PASSWORD.

require('dotenv').config();
const { syncShippers } = require('../src/shopify-sync');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const days = Number((args.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 7;

  const stats = await syncShippers({ days, apply, log: console.log });
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
