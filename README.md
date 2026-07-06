# API No Pesanan Qontak

Backend Express.js untuk lookup detail pesanan **Jubelio** dari kode pesanan marketplace (Shopee, Tokopedia, Shopify, TikTok). Otomatis mendeteksi marketplace dari format input, mencari `salesorder_no` yang benar di Jubelio, lalu mengembalikan ringkasan pesanan + timeline status.

- **Base URL (lokal):** `http://localhost:3000`
- **Sumber data:** Jubelio API v2 (`https://api2.jubelio.com`)
- **Rate limit upstream:** 600 req/menit (per akun Jubelio)

---

## Quick Start

```bash
# 1. Install deps
npm install

# 2. Set kredensial Jubelio di .env
cat > .env <<'EOF'
JUBELIO_API_USERNAME=email@anda.com
JUBELIO_API_PASSWORD=password-jubelio
PORT=3000
EOF

# 3. Jalankan
npm start
```

Output:
```
API listening on http://localhost:3000
POST /api/orders/lookup  body: { "salesorder_no": "<kode pesanan>" }
```

---

## Environment Variables

| Variable | Wajib | Default | Keterangan |
|---|---|---|---|
| `JUBELIO_API_USERNAME` | ✓ | — | Email login Jubelio |
| `JUBELIO_API_PASSWORD` | ✓ | — | Password Jubelio |
| `JUBELIO_BASE_URL` | — | `https://api2.jubelio.com` | Override jika perlu |
| `PORT` | — | `3000` | Port HTTP server |

Token Jubelio di-cache in-memory selama **11 jam** (TTL token Jubelio = 12 jam). Auto-refresh saat upstream balas 401.

---

## Endpoints

### `POST /api/orders/lookup`

Lookup detail pesanan berdasarkan kode dari marketplace.

**Request body** (alias diterima):

```json
{ "salesorder_no": "260421CSQM3TER" }
```

| Field | Tipe | Catatan |
|---|---|---|
| `salesorder_no` | string | Kode pesanan dari marketplace |
| `order_no` | string | Alias `salesorder_no` |
| `kode_pesanan` | string | Alias `salesorder_no` |
| `no_pesanan` | string | Alias `salesorder_no` |
| `verbose` | boolean | Jika `true`, sertakan field mentah Jubelio di `_raw` |

**Query string:**

| Param | Tipe | Catatan |
|---|---|---|
| `verbose=1` | flag | Sama dengan body `verbose: true` |

**Response 200**:

```json
{
  "input": "260421CSQM3TER",
  "detected_channel": "shopee",
  "salesorder_no": "SP-260421CSQM3TER",
  "ref_no": "260421CSQM3TER",
  "channel": "SHOPEE",
  "store": "Treelogy Moringa",
  "customer": "Wiwit Olina",
  "status": "COMPLETED",
  "transaction_date": "2026-04-21T03:05:54.000Z",
  "grand_total": 1096250,
  "products": [
    {
      "name": "TREELOGY The Movement & Relief | Moringa Daun Kelor Premium | 180 Kapsul + Oil 60ml",
      "sku": "The-Movement-&-Relief",
      "qty": 1
    }
  ],
  "history": [
    { "step": "Dibuat",  "at": "2026-04-21T03:06:02.835Z", "by": "wiwitolina" },
    { "step": "Dibayar", "at": "2026-04-21T03:07:14.000Z", "by": "wiwitolina" },
    { "step": "Diambil", "at": "2026-04-21T03:32:40.344Z", "by": "kemas@treelogy.com" },
    { "step": "Dikirim", "at": "2026-04-21T03:32:40.344Z", "by": "system" },
    { "step": "Selesai", "at": "2026-04-27T06:48:53.302Z", "by": "system" }
  ]
}
```

**Field reference:**

| Field | Tipe | Sumber Jubelio |
|---|---|---|
| `input` | string | Kode mentah dari user |
| `detected_channel` | enum | Hasil deteksi heuristik (`shopee`/`tokopedia`/`shopify`/`tiktok`/`lazada`/`internal`/`unknown`) |
| `salesorder_no` | string | `salesorder_no` resmi di Jubelio (dengan prefix kanal) |
| `ref_no` | string\|null | `ref_no` |
| `channel` | string\|null | `source_name` |
| `store` | string\|null | `store_name` |
| `customer` | string\|null | `customer_name` |
| `status` | string\|null | `internal_status` ⇨ `wms_status` ⇨ `channel_status` |
| `transaction_date` | ISO 8601\|null | `transaction_date` |
| `grand_total` | number\|null | `grand_total` (sudah cast ke number) |
| `products[].name` | string | `items[].item_name` |
| `products[].sku` | string\|null | `items[].item_code` |
| `products[].qty` | number | `items[].qty` |
| `history[].step` | enum | Lihat tabel di bawah |
| `history[].at` | ISO 8601 | Timestamp UTC |
| `history[].by` | string | Pelaku (`username`/`picker`/`source_name`/`system`) |

**History steps & sumber field:**

| Step | Sumber utama | Fallback |
|---|---|---|
| `Dibuat` | `created_date` | — |
| `Dibayar` | `payment_date` | — |
| `Diambil` | `items[].pick_scanned_date` | `tn_created_date` |
| `Dikemas` | `items[].pack_scanned_date` | — |
| `Dikirim` | `items[].awb_created_date` | `items[].shipped_date` |
| `Diterima` | `received_date` | — |
| `Dibatalkan` | `mp_cancel_date` | `internal_cancel_date` |
| `Gagal` | `failed_order_date` | — |
| `Selesai` | `completed_date` | `mp_completed_date` |

History otomatis di-skip jika field-nya null, dan di-sort ascending berdasarkan timestamp.

**Response 400** — body kosong:
```json
{
  "error": "kode pesanan wajib diisi",
  "hint": "kirim body JSON: { \"salesorder_no\": \"<kode dari TikTok/Tokopedia/Shopee/Shopify>\" }. Contoh: \"260426SDYAE9DE\" (Shopee), \"INV/20250322/MPL/4504975400\" (Tokopedia), \"#6211\" (Shopify)."
}
```

**Response 404** — pesanan tidak ditemukan (transparan, sertakan apa yang sudah dicoba):
```json
{
  "error": "Pesanan tidak ditemukan di Jubelio",
  "input": "583649225541977149",
  "detection": { "channel": "tiktok", "raw": "...", "normalized": "..." },
  "tried": [
    { "method": "getOrderByNo", "value": "TT-583649225541977149" },
    { "method": "getOrderByNo", "value": "TKT-583649225541977149" },
    { "method": "search",       "value": "583649225541977149" }
  ]
}
```

**Response 5xx** — kegagalan upstream:
```json
{
  "error": "Gagal mengambil data pesanan dari Jubelio",
  "message": "<error message>",
  "upstream": { /* body asli dari Jubelio jika ada */ }
}
```

---

### `POST /api/orders/by-name`

Cari pesanan dari **nama pemesan** atau **nama penerima di alamat pengiriman** (`shipping_full_name`). Engine matching v2 (lihat `docs/design-name-matching.md`):

- **Toleran typo** — Damerau-Levenshtein + Jaro-Winkler dengan guard edit-distance per panjang token: `"Komanng Rahau"` menemukan `"Komang Rahayu Lestari"`, tapi `"Budi"` tidak pernah dianggap yakin sama dengan `"Rudi"`.
- **Paham sinonim & ejaan lama** — kamus nickname (`Moh` == `Muhammad`, `Rizqi` == `Rizky`) + transduser Ejaan Lama→EYD (`Oemar` == `Umar`, `Djoko` == `Joko`) + phonetic key Indonesia (`Jusuf` == `Yusuf`, `Vitri` == `Fitri`).
- **Tier confidence** — tiap hasil membawa `confidence`: `exact` / `strong` / `probable` / `weak` / `masked_possible`. Bot CS sebaiknya hanya memakai `exact`/`strong` langsung; `probable` ke bawah wajib konfirmasi ke pelanggan dulu.
- **Deteksi ambiguitas** — jika dua pelanggan *berbeda* punya skor berimpit (selisih < 0.05), response menyertakan `is_ambiguous: true` + `hint`; jangan auto-pick.
- **Nama ter-masking marketplace** (`S***n L***n`) hanya bisa jadi kandidat `masked_possible` (skor cap 0.75), tidak pernah dipilih dengan yakin.

Mencakup semua status order (completed, cancel, failed, returned, ready-to-pick/process/ship, shipped, dll.). Hanya kandidat ber-tier ≥ `probable` yang dikembalikan; match `weak` dibuang (privasi — match lemah tidak pernah membuka detail order).

**Input** — hanya POST dengan body raw JSON (GET dijawab `405`). Jumlah hasil dipatok internal maksimal 5 order:

```bash
curl -X POST http://localhost:3000/api/orders/by-name \
  -H 'Content-Type: application/json' \
  -d '{"name": "Fenny Oey", "date": "17/04/2026"}'
```

| Field body | Wajib? | Keterangan |
|---|---|---|
| `name` | ya | Min 3 huruf. Alias: `nama` / `customer_name` / `shipping_name` |
| `date` | tidak | **Tanggal bayar** (payment date) versi pelanggan/WIB, untuk menaikkan akurasi. Format bebas: `17/04/2026`, `2026-04-17`, `17-4-26`, `04/17/2026` (US, ditukar otomatis), `1 januari 2026`, `1 jan 26`, `tgl 17 april`, `kemarin`, `hari ini` — nama bulan toleran typo (`jnauari`, `agsutus`, `pebruari`). Tanpa tahun → tahun berjalan; hanya angka hari (mis. `"17"`) → bulan & tahun berjalan. Alias: `tanggal` / `payment_date` |

Jika `date` diisi: tiap order diberi `date_match` (payment_date order, dikonversi UTC→WIB, cocok ±1 hari), hasil diurut dari yang tanggalnya paling dekat, dan bila hasil tadinya ambigu tapi hanya **satu** pelanggan yang tanggal bayarnya cocok, ambiguitas dipecahkan otomatis (`resolved_by_date: true`).

**Response 200** — tiap order berisi detail lengkap (produk, harga, history) sama seperti `/api/orders/lookup`, plus metadata kecocokan:

```json
{
  "input": "Komanng Rahayu",
  "total_found": 4,
  "count": 1,
  "is_ambiguous": false,
  "orders": [
    {
      "match_score": 0.954,
      "confidence": "strong",
      "match_basis": "customer",
      "matched_name": "Komang Rahayu Lestari",
      "shipping_name": "Komang Rahayu Lestari",
      "salesorder_no": "TP-583564250368280183-128884",
      "channel": "TOKOPEDIA",
      "customer": "Komang Rahayu Lestari",
      "status": "COMPLETED",
      "grand_total": 790000,
      "products": [ { "name": "...", "qty": 1, "price": 790000, "subtotal": 790000 } ],
      "history": [ { "history_name": "Dibuat", "at": "..." } ]
    }
  ]
}
```

Saat `is_ambiguous: true` ada field `hint` tambahan — konfirmasi dulu ke pelanggan sebelum memakai hasil teratas. Hasil diurutkan dari skor tertinggi, lalu tanggal transaksi terbaru. `404` jika tidak ada nama yang cukup mirip (`queries_tried` disertakan untuk debug).

**Kualitas terukur** (jalankan sendiri):

```bash
npm test            # 18 unit test scorer, termasuk guard adversarial (Budi vs Rudi, dll.)
npm run eval:names  # eval vs 200 nama riil + typo sintetis + 100 gibberish
                    # syarat lulus: recovery >= 95%, false positive = 0
```

---

### `GET /api/orders/sample`

Endpoint diagnostik untuk inspect format `salesorder_no` riil di akun Jubelio yang terhubung. Berguna untuk verifikasi prefix channel atau debug ketika lookup 404.

**Query params:**

| Param | Tipe | Default | Pilihan |
|---|---|---|---|
| `status` | enum | `completed` | `completed` / `cancel` / `failed` / `returned` |
| `q` | string | — | Filter teks (Sales Order Number / Customer Name / dll.) |
| `limit` | int | `10` | Max 50 |

**Contoh:**
```bash
curl 'http://localhost:3000/api/orders/sample?status=completed&q=tiktok&limit=5'
```

**Response 200:**
```json
{
  "status": "cancel",
  "q": "tiktok",
  "count": 88,
  "rows": [
    {
      "salesorder_id": 115,
      "salesorder_no": "TT-583574103704044695-128883",
      "channel_name": "Shop | Tokopedia",
      "store_name": "...",
      "transaction_date": "2026-04-...",
      "grand_total": "...",
      "internal_status": "CANCELLED"
    }
  ]
}
```

---

### `GET /health`

Liveness probe.

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

---

## Smart Detection

Detector menebak marketplace dari format input, lalu generate kandidat `salesorder_no` (dengan/ tanpa prefix Jubelio) untuk dicoba.

| Pola input | Channel | Kandidat exact | Stem prefix-match |
|---|---|---|---|
| Awalan `SP-` | shopee | `SP-…` | `SP-{core}-` |
| Awalan `TP-` | tokopedia | `TP-…` | `TP-{core}-`, `TP-{lastNumeric}-` |
| Awalan `LZ-` / `LB-` | lazada | `LZ-…`, `LB-…` | `LZ-{core}-`, `LB-{core}-` |
| Awalan `TT-` / `TKT-` / `TIK-` | tiktok | `TT-…`, `TKT-…`, `TIK-…` | `TT-{core}-`, dst. |
| Awalan `SHF-` / `SHO-` | shopify | `SHF-…`, `SHO-…` | `SHF-{core}-`, `SHO-{core}-` |
| Awalan `#` (mis. `#6211`) | shopify | `SHF-6211`, `SHO-6211`, `#6211`, `6211` | `SHF-6211-`, `SHO-6211-` |
| `INV/YYYYMMDD/MPL/…` | tokopedia | `TP-INV/…`, raw | `TP-{INV}-`, `TP-{lastNumeric}-` |
| 6 digit + 6–10 alphanum (mis. `260426SDYAE9DE`) | shopee | `SP-…`, raw | `SP-…-` |
| 14+ digit numerik (mis. `583649225541977149`) | tiktok | `TT-…`, `TKT-…`, `TIK-…`, raw | `TT-…-`, `TKT-…-`, `TIK-…-` |
| Lain | unknown | raw + brute-force prefix | — |

Tahapan eksekusi (`smartLookup` di `src/jubelio.js`):

1. **Exact lookup**: untuk tiap kandidat, panggil `POST /wms/order/getOrderByNo/`.
2. **Search fallback**: untuk tiap query (core, lastNumeric, raw), panggil `GET` ke 13 list endpoint Jubelio dengan `q={query}`, mencakup seluruh siklus hidup pesanan:
   - `/sales/orders/{completed,cancel,failed,returned-list}/` — status final
   - `/wms/sales/orders/{ready-to-process,ready-to-pick,empty-stock,finish-pick,request-cancel}/` — proses gudang
   - `/wms/sales/picklists/confirm-pick/` — sedang dipick
   - `/wms/sales/packlists/finish-pack/` — selesai pack
   - `/wms/sales/order/ready-to-ship` — siap kirim
   - `/wms/sales/shipped/` — sudah diserahkan ke kurir (belum di-mark complete)
3. **Pemilihan baris** dari hasil search:
   1. Baris dengan `salesorder_no` exact-match kandidat → pilih.
   2. Baris dengan `salesorder_no` startsWith stem → pilih.
   3. Fallback: baris pertama dengan `salesorder_id`.
4. Hit pertama → `GET /sales/orders/{salesorder_id}` untuk detail penuh, lalu di-format.

Hit pertama menang. Kalau semua gagal → 404 dengan `tried` log.

---

## Catatan Khusus per-Channel

- **Shopee**: input bisa raw (`260421CSQM3TER`) atau dengan prefix (`SP-260421CSQM3TER`). Jubelio simpan format `SP-{kode}` tanpa suffix.
- **Tokopedia**: Jubelio simpan format `TP-{tokopedia_order_id}-{store_id}` di mana `tokopedia_order_id` adalah angka 18-digit dari URL Tokopedia. **Format invoice `INV/YYYYMMDD/MPL/...` TIDAK bisa di-lookup langsung** karena bukan field yang di-index — gunakan order_id 18-digit.
- **Shopify**: Jubelio simpan format `SHF-{shopify_order_no}-{store_id}`. Input `#6211` otomatis di-strip jadi `6211` lalu match via stem `SHF-6211-`.
- **TikTok**: Jubelio simpan format `TT-{tiktok_order_id}-{store_id}` (channel di UI bisa muncul sebagai "Shop | Tokopedia" tergantung integrasi). Input 18-digit numerik otomatis terdeteksi.

---

## Contoh per-Channel

```bash
# Shopee
curl -X POST http://localhost:3000/api/orders/lookup \
  -H 'Content-Type: application/json' \
  -d '{"salesorder_no":"260421CSQM3TER"}'

# Shopify
curl -X POST http://localhost:3000/api/orders/lookup \
  -H 'Content-Type: application/json' \
  -d '{"salesorder_no":"#7271"}'

# TikTok (kode 18-digit)
curl -X POST http://localhost:3000/api/orders/lookup \
  -H 'Content-Type: application/json' \
  -d '{"salesorder_no":"583574103704044695"}'

# Tokopedia (PAKAI order_id 18-digit, BUKAN INV/...)
curl -X POST http://localhost:3000/api/orders/lookup \
  -H 'Content-Type: application/json' \
  -d '{"salesorder_no":"583556977397302612"}'

# Verbose — sertakan raw payload Jubelio
curl -X POST 'http://localhost:3000/api/orders/lookup?verbose=1' \
  -H 'Content-Type: application/json' \
  -d '{"salesorder_no":"260421CSQM3TER"}'
```

---

## Struktur Proyek

```
src/
├── server.js     # Express app + 3 endpoint
├── jubelio.js    # Login/token cache, getOrderByNo, search, getOrderDetail, smartLookup, listOrders
├── detect.js     # Heuristic channel detection + candidate/stem/query generation
└── format.js     # formatOrder() → response shape rapi (products + history)
```

| File | Fungsi utama |
|---|---|
| `src/jubelio.js` | `smartLookup(input)`, `listOrders({status, q, pageSize})`, `getOrderDetail(id)` |
| `src/detect.js` | `detectChannel(input)` → `{channel, raw, normalized, candidates, stems, queries}` |
| `src/format.js` | `formatOrder(rawOrder)` → response ringkas |

---

## Error Codes & HTTP Status

| Status | Arti |
|---|---|
| `200` | Pesanan ditemukan |
| `400` | Body kosong / tidak valid |
| `404` | Pesanan tidak ditemukan setelah semua kandidat dicoba |
| `429` | Upstream Jubelio rate-limit (forward dari Jubelio) |
| `500`/`502` | Error upstream / koneksi gagal — body memuat `upstream` jika tersedia |

---

## Status Pesanan yang Dijangkau

Lookup mencakup pesanan di **semua tahap operasional** berikut (via 13 endpoint Jubelio):

| Tahap | Endpoint Jubelio | Penjelasan |
|---|---|---|
| Selesai | `/sales/orders/completed/` | Sudah diterima customer |
| Dibatalkan | `/sales/orders/cancel/` | Cancel oleh marketplace/seller |
| Gagal | `/sales/orders/failed/` | Gagal proses |
| Retur | `/sales/orders/returned-list/` | Pesanan dikembalikan |
| Siap proses | `/wms/sales/orders/ready-to-process/` | Belum di-pick |
| Siap pick | `/wms/sales/orders/ready-to-pick/` | Antrian picking |
| Stok kosong | `/wms/sales/orders/empty-stock/` | Tidak bisa di-pick |
| Sedang pick | `/wms/sales/picklists/confirm-pick/` | Picker sedang scan |
| Selesai pick | `/wms/sales/orders/finish-pick/` | Sudah dipick |
| Selesai pack | `/wms/sales/packlists/finish-pack/` | Sudah dipack |
| Siap kirim | `/wms/sales/order/ready-to-ship` | Menunggu kurir |
| Sudah dikirim | `/wms/sales/shipped/` | Sudah diserahkan ke kurir |
| Request cancel | `/wms/sales/orders/request-cancel/` | Customer minta batal |

---

## Limitasi

- **Tidak ada cara map invoice Tokopedia (`INV/...`) ke Jubelio** tanpa Tokopedia API tambahan — gunakan Tokopedia order_id 18-digit.
- **Pencarian terbatas pada list endpoint yang men-support `q`** — order yang sangat lama / di-archive di luar siklus standar mungkin tidak terjangkau.
- **Token cache in-memory** — tidak persisten lintas restart proses; deploy multi-instance akan login terpisah per instance.
- **Tidak ada autentikasi** di sisi API ini. Tambahkan API key / signed header di middleware sebelum expose ke publik.
