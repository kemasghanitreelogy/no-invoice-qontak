# Design: Name Matching Engine v2 (typo + sinonim, presisi tinggi)

Status: IMPLEMENTED & CALIBRATED (2026-07-06) — hasil eval: recovery light 100%
(199/200 + 1 ambigu-wajar), medium 99.5%, false positive 0/100.
Catatan kalibrasi pasca-eval: (a) match via inisial di sisi target didiskon
(numerator cap 1, denominator ½ bobot) — tanpa ini gibberish bisa menunggangi
inisial; (b) match yang melibatkan inisial/sinonim/fonetik di-cap 0.96 (tak
pernah `exact`); (c) query identik yang low-info ("sari" == "Sari") tetap
di-cap `probable`.
Target: upgrade `src/fuzzy.js` menjadi modul matching yang toleran typo **dan** paham
variasi ejaan/sinonim nama Indonesia, dengan kebijakan keputusan yang eksplisit
supaya tidak pernah mengembalikan order orang yang salah (privacy-critical:
output dipakai bot CS Qontak/WhatsApp).

## 1. Prinsip utama

**Presisi > recall.** Salah kirim detail order = bocor data pelanggan.
Lebih baik jawab "ada 3 kandidat, yang mana?" daripada menebak salah.
Semua parameter di bawah dikalibrasi ke prinsip ini.

## 2. Arsitektur pipeline

```
input nama
  │
  ▼
[1] Normalisasi ──► [2] Ekspansi sinonim ──► [3] Candidate generation (query Jubelio)
                                                    │
  hasil ◄── [6] Decision policy ◄── [5] Scoring ◄── [4] Kumpulkan rows semua status
```

File plan (pecah dari `src/fuzzy.js`):

| File | Isi |
|---|---|
| `src/matching/normalize.js` | normalisasi + deteksi nama ter-masking |
| `src/matching/phonetic.js` | transduser Ejaan Lama→EYD + phonetic key Indonesia |
| `src/matching/synonyms.js` | kamus variasi nama (data murni, gampang ditambah) |
| `src/matching/score.js` | Damerau-Levenshtein, Jaro-Winkler, skor gabungan |
| `src/matching/index.js` | orkestrasi: queries builder + rank + decision |
| `src/fuzzy.js` | re-export tipis (kompatibilitas mundur) |

Tanpa dependency baru — semua algoritma kecil dan diimplement sendiri (deterministik, mudah diuji).

## 3. Parameter per tahap (yang "harus dipikirkan agar no mistake")

### [1] Normalisasi

| Parameter | Nilai awal | Alasan / risiko jika salah |
|---|---|---|
| Unicode | NFKD + buang diakritik | `é→e`; tanpa ini nama impor gagal match |
| **Deteksi masking DULU** | token mengandung `*` → tandai `masked` sebelum strip simbol | Data riil Tokopedia: `S***n L***n`. v1 mengubahnya jadi `s n l n` → sumber false positive |
| Karakter noise | strip `|`, emoji, tanda baca → spasi | Data riil: `\| Komang Budiasa` |
| Honorifik/stopword | buang: pak, bu, bpk, ibu, bapak, sdr, sdri, kak, mas, mbak, bang, h, hj, dr, ir, drg, dan gelar akademik (spd, se, sh, mm, …) | "Ibu Komang" harus == "Komang"; tapi JANGAN buang jika hasilnya jadi kosong |
| Deteksi alamat-sebagai-nama | token mengandung digit + kata jln/jl/jin/no/rt/rw → turunkan bobot baris | Data riil: `JIn Prof HB JASSIN NO.293` di field customer_name |
| Panjang minimum query | ≥ 3 huruf setelah normalisasi | di bawah itu tolak 400 |

### [2] Sinonim & variasi ejaan (fitur "sinonim")

Dua lapisan, keduanya diterapkan ke query **dan** target:

1. **Transduser Ejaan Lama → EYD** (aturan berurutan, deterministik):
   `oe→u, dj→j, tj→c, nj→ny, sj→sy, ch→kh` → `Oemar==Umar`, `Djoko==Joko`, `Tjahjadi==Cahyadi`.
2. **Phonetic key Indonesia** (agresif, hanya untuk bonus skor, bukan pengganti):
   setelah (1): `kh→k, sy→s, f/v→p? TIDAK — f/v→f, z→s, q→k, x→s, y→i, double letter→single, h akhir suku kata opsional`.
   Contoh kunci: `yusuf→iusup`… — aturan final ditetapkan lewat test-set, bukan feeling.
3. **Kamus nickname/abbreviasi** (`synonyms.js`, canonical → varian):
   - `muhammad`: muhamad, mohammad, mohamad, mochammad, mochamad, moch, moh, muh, mhd, md, m
   - `ahmad`: achmad, akhmad, ahmed
   - `abdul`: abd, abdoel · `nur`: noor, noer · `yusuf`: jusuf, yusup · `usman`: oesman, utsman
   - `siti`, `sri`, `dewi`, dst. ditambah bertahap dari data eval
   - **Parameter kunci**: match via kamus = skor pasangan token **0.95 (bukan 1.0)** dan tidak pernah menaikkan tier ke `exact` — sinonim adalah bukti kuat, bukan identitas.

### [3] Candidate generation (recall — server Jubelio hanya substring match)

| Parameter | Nilai awal | Catatan |
|---|---|---|
| Sumber query | nama penuh, tiap token, slice 4-huruf posisi 0 dan 1, **+ varian sinonim token** | varian sinonim baru di v2: query "moh" ikut dikirim saat user ketik "muhammad" |
| Max queries | 10 (naik dari 8) | dibatasi biar tidak spam API |
| pageSize | 50 per path | 13 path × 50 = worst case 650 rows/query — masih murah |
| Early-stop | kandidat `strong` ≥ limit → berhenti | jangan early-stop kalau ada flag `ambiguous` (lihat [6]) |
| Urutan query | dari paling spesifik (nama penuh) ke paling umum (slice) | slice pendek dieksekusi terakhir, hanya jika belum cukup kandidat |

### [4→5] Scoring — formula

Per pasangan token (q, t):

```
pairScore = max(
  damerauLevRatio(q, t),      // transposisi = 1 edit ("Komanng", "Rahuya")
  jaroWinkler(q, t),           // bagus untuk nama pendek, bonus prefix
  0.95 jika kamus sinonim,     // lapisan [2].3
  0.95 jika phoneticKey sama,  // lapisan [2].2
  0.93 jika prefix ≥3 huruf,
  0.85 jika q inisial 1 huruf & t diawali huruf itu   // "m rizky" vs "muhammad rizky"
)
```

**Guard absolut (kunci "no mistake"):** pairScore di-nol-kan jika edit distance
melewati ambang panjang token — token pendek tidak boleh lolos dengan rasio saja:

| len(token) | max edit yang dianggap "sama" |
|---|---|
| ≤ 4 | 1, dan HASILNYA di-cap ke tier `probable` (kasus Budi↔Rudi, Sari↔Sri) |
| 5–7 | 2 |
| ≥ 8 | 3 |

Skor nama = rata-rata tertimbang best-pair per token query:

| Parameter | Nilai awal | Alasan |
|---|---|---|
| Bobot token umum | 0.5 untuk ~100 token nama tersering (sari, dewi, putri, ayu, siti, nur, agus, budi, eka, dwi, tri, wati, lestari, …) | "Sari" saja tidak boleh percaya diri |
| Bobot token Bali/partikel | 0.3: ni, i, putu, made, kadek, komang, ketut, wayan, nyoman, gede, luh, bin, binti | penanda urutan lahir, bukan identitas |
| Bobot default | 1.0 × panjang token | token panjang & langka = bukti kuat |
| Urutan token | bebas (token-set) | "Rahayu Komang" == "Komang Rahayu" |
| Query parsial | boleh: token target ekstra TIDAK dipenalti | pengguna sering ketik nama depan saja |
| Token query tak ter-match | ikut rata-rata dengan skor pasangan terbaiknya (rendah) → menurunkan skor total | tidak ada "abaikan token yang gagal" |
| Target ter-masking | match pola skeleton (`S***n` → `^s.+n$`) → skor **cap 0.75**, confidence khusus `masked_possible` | tidak pernah auto-pick baris masked |
| Basis skor | max(customer_name, shipping_full_name), catat `match_basis` | dua-duanya sah sebagai identitas |

### [6] Decision policy (lapisan paling penting)

| Tier | Skor | Perilaku API |
|---|---|---|
| `exact` | ≥ 0.97 | kembalikan langsung |
| `strong` | ≥ 0.88 | kembalikan langsung |
| `probable` | ≥ 0.72 | kembalikan, tapi `confidence: "probable"` — bot CS wajib konfirmasi dulu |
| `weak` | ≥ 0.55 | hanya muncul di `alternatives`, tanpa detail order lengkap |
| — | < 0.55 | dibuang |

**Ambiguity margin:** jika `top1 − top2 < 0.05` dan keduanya nama orang berbeda
(normalisasi tidak identik) → `is_ambiguous: true`, JANGAN auto-pick; kembalikan
daftar ringkas dan minta konfirmasi. Ini satu-satunya cara benar menangani
"ada 2 pelanggan bernama Komang".

**Grouping:** rows dengan nama ternormalisasi identik = orang yang sama →
banyak order dari 1 orang bukan ambiguitas, kembalikan semuanya (sampai `limit`).

Perubahan kontrak response (aditif, backward-compatible):
`confidence`, `is_ambiguous`, `match_basis`, `alternatives[]`.

## 4. Katalog edge case (dari data live + sintetis)

1. `S***n L***n` — masking Tokopedia → skeleton match, cap 0.75.
2. `| Komang Budiasa` — noise prefix → normalisasi.
3. `JIn Prof HB JASSIN NO.293` — alamat di field nama → penalti baris.
4. `Komanng Rahau` — 2 typo di 2 token → Damerau + guard panjang.
5. `Oemar Bakri` vs `Umar Bakri` — ejaan lama.
6. `Moh. Rizky` vs `Muhammad Rizky` — kamus + inisial.
7. `Budi` vs `Rudi` — edit 1 di token 4 huruf → cap `probable`, tidak pernah `strong`.
8. `Rahayu Komang` — token terbalik → token-set.
9. `ibu komang rahayu` — honorifik → stopword.
10. Dua pelanggan beda dengan nama sama/mirip → `is_ambiguous`.
11. Query 1 token umum (`sari`) → banyak kandidat → bobot rendah memaksa tier `probable` + daftar.
12. Nama non-latin / emoji di nama toko → NFKD + strip, jangan crash.

## 5. Rencana evaluasi ("no mistake" harus terukur)

`scripts/eval-names.js` (npm run eval:names):

1. **Golden set**: tarik ~200 nama riil via API sample (semua status).
2. **Korupsi sintetis** per nama: 1–2 edit acak (insert/delete/substitute/**transpose**),
   drop token, tukar urutan token, ganti ke ejaan lama, ganti ke nickname, tambah honorifik.
3. **Negative set**: 100 nama acak yang tidak ada di data.
4. Metrik & ambang lulus:
   - Top-1 recovery (typo ringan ≤2 edit): **≥ 95%**
   - False positive di negative set (tier ≥ probable): **0** — non-negotiable
   - Ambiguity flag muncul saat memang ada ≥2 orang mirip: dicek manual sample
5. Unit test scorer: pasangan adversarial (Budi/Rudi, Sari/Sri, Agus/Anus, dst.)
   di-assert TIDAK pernah mencapai `strong`.

Kalibrasi ambang (0.97/0.88/0.72/0.55, margin 0.05, guard edit) dilakukan
terhadap hasil eval ini — angka di atas adalah titik awal, bukan angka keramat.

## 6. Urutan implementasi

1. **Fase 1** — modul `src/matching/*` + unit test scorer (tanpa menyentuh API).
2. **Fase 2** — integrasi ke `searchOrdersByName` + field response baru.
3. **Fase 3** — `eval-names.js`, kalibrasi ambang, kunci angka final di README.
