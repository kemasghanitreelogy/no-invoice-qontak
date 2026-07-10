#!/usr/bin/env node
// Ubah kurir (field `shipper`) pada order Jubelio, per order beda-beda.
//
// Pakai:
//   node scripts/update-shipper.js mapping.csv          # dry-run (tidak mengirim apa pun)
//   node scripts/update-shipper.js mapping.csv --apply  # benar-benar mengubah di Jubelio
//
// Format mapping.csv (satu order per baris, header opsional):
//   salesorder_no,shipper_baru
//   SHF-8506,J&T REG
//   2506-1234,SiCepat BEST
//
// PENTING: endpoint edit Jubelio (POST /sales/orders/) bukan patch parsial —
// seluruh payload order dikirim ulang. Helper di lib/shipper.js menyalin semua
// field dari detail order apa adanya dan HANYA mengganti kurir, tapi tetap:
// tes dulu di 1 order dan cek hasilnya di UI sebelum jalan massal.

require('dotenv').config();
const fs = require('fs');
const { smartLookup } = require('../src/jubelio');
const { applyShipper, currentShipperOf } = require('./lib/shipper');

function parseMapping(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Kolom 1 = nomor order, sisanya = nama kurir (boleh mengandung koma).
    const sep = trimmed.includes('\t') ? '\t' : ',';
    const idx = trimmed.indexOf(sep);
    if (idx < 0) {
      console.error(`Baris dilewati (tidak ada pemisah "${sep}"): ${trimmed}`);
      continue;
    }
    const orderNo = trimmed.slice(0, idx).trim().replace(/^"|"$/g, '');
    const shipper = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
    if (/^(salesorder_no|order|no)/i.test(orderNo) && /shipper|kurir/i.test(shipper)) continue; // header
    if (orderNo && shipper) rows.push({ orderNo, shipper });
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const filePath = args.find((a) => !a.startsWith('--'));
  if (!filePath) {
    console.error('Pakai: node scripts/update-shipper.js mapping.csv [--apply]');
    process.exit(1);
  }

  const mapping = parseMapping(filePath);
  if (!mapping.length) {
    console.error('Mapping kosong — tidak ada yang dikerjakan.');
    process.exit(1);
  }
  console.log(`${mapping.length} order di mapping. Mode: ${apply ? 'APPLY (mengubah data!)' : 'dry-run'}\n`);

  let ok = 0;
  let failed = 0;
  for (const { orderNo, shipper } of mapping) {
    try {
      const result = await smartLookup(orderNo);
      if (!result.found) {
        console.log(`✗ ${orderNo}: tidak ditemukan di Jubelio`);
        failed += 1;
        continue;
      }
      const detail = result.order;
      const current = currentShipperOf(detail) || '(kosong)';
      if (current === shipper) {
        console.log(`= ${detail.salesorder_no}: sudah "${shipper}", dilewati`);
        ok += 1;
        continue;
      }

      if (!apply) {
        console.log(`~ ${detail.salesorder_no} (id ${detail.salesorder_id}): "${current}" -> "${shipper}" [dry-run]`);
        ok += 1;
        continue;
      }

      const { saved, afterValue, changed } = await applyShipper(detail, shipper);
      console.log(
        `${changed ? '✓' : '?'} ${detail.salesorder_no}: "${current}" -> "${afterValue}"` +
          `${changed ? '' : ' — CEK MANUAL, hasil tidak sesuai harapan'} (save id: ${saved?.id ?? '-'})`,
      );
      if (changed) ok += 1;
      else failed += 1;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
      console.log(`✗ ${orderNo}: gagal${status ? ` (HTTP ${status})` : ''} — ${body}`);
      failed += 1;
    }
  }

  console.log(`\nSelesai: ${ok} ok, ${failed} gagal.${apply ? '' : ' (dry-run — tidak ada data yang diubah)'}`);
  process.exit(failed ? 1 : 0);
}

main();
