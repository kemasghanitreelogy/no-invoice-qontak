const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeName, isMaskedName, looksLikeAddress } = require('../src/matching/normalize');
const { oldToEyd, phoneticKey } = require('../src/matching/phonetic');
const { sameSynonymGroup } = require('../src/matching/synonyms');
const { nameScore, damerauLevenshtein } = require('../src/matching/score');
const { confidenceOf, matchRow, buildNameQueries, decideMatches, TIER } = require('../src/matching');

const conf = (q, t) => {
  const r = nameScore(normalizeName(q), normalizeName(t));
  return { ...r, confidence: confidenceOf(r.score, r) };
};

test('normalisasi: honorifik, noise, diakritik', () => {
  assert.equal(normalizeName('Ibu Komang Rahayu'), 'komang rahayu');
  assert.equal(normalizeName('| Komang Budiasa'), 'komang budiasa');
  assert.equal(normalizeName('H. Ahmad Yani, S.E.'), 'ahmad yani');
  assert.equal(normalizeName('José'), 'jose');
  // Semua token honorifik -> jangan jadi kosong
  assert.equal(normalizeName('Ibu Hj'), 'ibu hj');
});

test('deteksi masking & alamat', () => {
  assert.equal(isMaskedName('S***n L***n'), true);
  assert.equal(isMaskedName('Komang Rahayu'), false);
  assert.equal(looksLikeAddress('JIn Prof HB JASSIN NO.293'), true);
  assert.equal(looksLikeAddress('Komang Rahayu Lestari'), false);
});

test('ejaan lama & fonetik', () => {
  assert.equal(oldToEyd('oemar'), 'umar');
  assert.equal(oldToEyd('djoko'), 'joko');
  assert.equal(oldToEyd('tjahjadi'), 'cahjadi');
  assert.equal(phoneticKey('tjahjadi'), phoneticKey('cahyadi'));
  assert.equal(phoneticKey('jusuf'), phoneticKey('yusuf'));
  assert.equal(phoneticKey('vitri'), phoneticKey('fitri'));
});

test('kamus sinonim', () => {
  assert.equal(sameSynonymGroup('moh', 'muhammad'), true);
  assert.equal(sameSynonymGroup('rizky', 'rizqi'), true);
  assert.equal(sameSynonymGroup('yusuf', 'yosef'), false); // grup sengaja dipisah
});

test('damerau: transposisi = 1 edit', () => {
  assert.equal(damerauLevenshtein('rahayu', 'rahyau'), 1);
  assert.equal(damerauLevenshtein('komang', 'komanng'), 1);
});

test('typo recovery: tetap strong, tidak pernah exact', () => {
  const r = conf('Komanng Rahau', 'Komang Rahayu Lestari');
  assert.equal(r.confidence, 'strong');
  const eyd = conf('Oemar Bakri', 'Umar Bakri');
  assert.ok(['strong', 'exact'].includes(eyd.confidence), `oemar: ${eyd.confidence}`);
});

test('sinonim & inisial: strong tapi tidak exact', () => {
  const r = conf('Moh Rizky', 'Muhammad Rizky');
  assert.equal(r.confidence, 'strong');
  assert.ok(r.score <= 0.96);
  const ini = conf('M Rizky Pratama', 'Muhammad Rizky Pratama');
  assert.ok(['strong', 'exact'].includes(ini.confidence));
});

test('urutan token bebas', () => {
  const r = conf('Rahayu Komang', 'Komang Rahayu');
  assert.ok(r.score >= TIER.EXACT, `reorder score ${r.score}`);
});

test('GUARD: nama pendek beda 1 huruf tidak pernah strong', () => {
  for (const [a, b] of [
    ['Budi', 'Rudi'],
    ['Sari', 'Sadi'],
    ['Dedi', 'Desi'],
    ['Andi', 'Anti'],
    ['Agus', 'Anus'],
  ]) {
    const r = conf(a, b);
    assert.ok(
      !['exact', 'strong'].includes(r.confidence),
      `${a} vs ${b} tidak boleh ${r.confidence} (score ${r.score})`,
    );
  }
});

test('query semua token umum/pendek -> maksimal probable', () => {
  const r = conf('sari', 'Ratna Sari');
  assert.equal(r.confidence, 'probable');
  const bali = conf('komang', 'Ni Komang Sukereni');
  assert.equal(bali.confidence, 'probable');
  // Bahkan match identik: "sari" == pelanggan bernama persis "Sari".
  const identik = conf('sari', 'Sari');
  assert.equal(identik.confidence, 'probable');
});

test('inisial di sisi target: kandidat sah tapi tidak pernah kuat', () => {
  // "Dyah Ratna S" tidak boleh mengalahkan "Ratna Sari" untuk query "Ratna Sarie"
  const abbrev = conf('Ratna Sarie', 'Dyah Ratna S');
  const full = conf('Ratna Sarie', 'Ratna Sari');
  assert.ok(full.score > abbrev.score, `full ${full.score} harus > abbrev ${abbrev.score}`);
  assert.ok(!['exact', 'strong'].includes(abbrev.confidence));
  // Tapi abreviasi yang benar-benar cocok tetap muncul sebagai kandidat.
  const legit = conf('Dian Fitri Rahma', 'Dian Fitri R');
  assert.ok(['probable', 'weak'].includes(legit.confidence), `legit: ${legit.confidence}`);
});

test('nama beda total -> none', () => {
  const r = conf('Zulkifli Hasan', 'Komang Rahayu Lestari');
  assert.equal(r.confidence, 'none');
});

test('masked: cap 0.75 + masked_possible, tidak pernah dipilih yakin', () => {
  const row = { customer_name: 'S***n L***n', shipping_full_name: 'S***n L***n' };
  const hit = matchRow(normalizeName('Susan Lubin'), row);
  assert.equal(hit.confidence, 'masked_possible');
  assert.equal(hit.score, TIER.MASKED_SCORE);
  const miss = matchRow(normalizeName('Komang Rahayu'), row);
  assert.equal(miss.score, 0);
});

test('alamat sebagai nama -> penalti + cap probable', () => {
  const row = { customer_name: 'JIn Prof HB JASSIN NO.293', shipping_full_name: null };
  const hit = matchRow(normalizeName('Jassin'), row);
  assert.ok(hit.score < 0.9);
  assert.ok(!['exact', 'strong'].includes(hit.confidence));
});

test('ambiguity margin: dua orang mirip -> is_ambiguous', () => {
  const entries = [
    { row: { salesorder_id: 1, transaction_date: '2026-01-01' }, match: { score: 0.9, confidence: 'strong', matched_name: 'Komang Rahayu' } },
    { row: { salesorder_id: 2, transaction_date: '2026-01-02' }, match: { score: 0.88, confidence: 'strong', matched_name: 'Komang Rahayo' } },
  ];
  const d = decideMatches(entries, { limit: 5 });
  assert.equal(d.is_ambiguous, true);
});

test('multi-order satu orang BUKAN ambigu', () => {
  const entries = [
    { row: { salesorder_id: 1, transaction_date: '2026-01-01' }, match: { score: 0.95, confidence: 'strong', matched_name: 'Komang Rahayu' } },
    { row: { salesorder_id: 2, transaction_date: '2026-01-02' }, match: { score: 0.95, confidence: 'strong', matched_name: 'komang rahayu' } },
  ];
  const d = decideMatches(entries, { limit: 5 });
  assert.equal(d.is_ambiguous, false);
  assert.equal(d.primary.length, 2);
});

test('GUARD inisial: gibberish tidak boleh menunggangi inisial target (temuan eval)', () => {
  // "rcowkymge rbffyivrhj" vs "Dian Fitri R" sempat 0.85 probable karena
  // kedua token match inisial "r" dengan bobot penuh.
  const r = conf('rcowkymge rbffyivrhj', 'Dian Fitri R');
  assert.equal(r.confidence, 'none', `harus none, dapat ${r.confidence} (${r.score})`);
  // Arah yang sah tetap jalan: user mengetik inisial.
  const ok = conf('M Rizky Pratama', 'Muhammad Rizky Pratama');
  assert.ok(['strong', 'exact'].includes(ok.confidence));
});

test('dates: parser pintar segala format', () => {
  const { parseDateInput } = require('../src/dates');
  // "sekarang" = 2026-07-06 12:00 WIB
  const NOW = new Date('2026-07-06T05:00:00Z');
  const p = (s) => parseDateInput(s, NOW);

  // Numerik segala gaya
  assert.equal(p('2026-04-17'), '2026-04-17');
  assert.equal(p('17/04/2026'), '2026-04-17');
  assert.equal(p('17-4-26'), '2026-04-17');
  assert.equal(p('17.04.2026'), '2026-04-17');
  assert.equal(p('1/1/2026'), '2026-01-01');
  assert.equal(p('04/17/2026'), '2026-04-17'); // gaya Amerika -> ditukar otomatis

  // Nama bulan Indonesia/Inggris + prefiks penunjuk
  assert.equal(p('1 januari 2026'), '2026-01-01');
  assert.equal(p('01 Januari 2026'), '2026-01-01');
  assert.equal(p('tgl 17 april 2026'), '2026-04-17');
  assert.equal(p('1 jan 26'), '2026-01-01');
  assert.equal(p('3 pebruari 2026'), '2026-02-03'); // ejaan lama
  assert.equal(p('17 October 2025'), '2025-10-17');

  // Typo nama bulan (Damerau)
  assert.equal(p('1 jnauari 2026'), '2026-01-01');
  assert.equal(p('17 agsutus 2025'), '2025-08-17');
  assert.equal(p('5 setember 2025'), '2025-09-05');

  // Tanpa tahun -> tahun berjalan; hanya hari -> bulan & tahun berjalan
  assert.equal(p('1 januari'), '2026-01-01');
  assert.equal(p('31 desember'), '2026-12-31');
  assert.equal(p('17/4'), '2026-04-17');
  assert.equal(p('17'), '2026-07-17');
  assert.equal(p('5'), '2026-07-05');

  // Relatif
  assert.equal(p('hari ini'), '2026-07-06');
  assert.equal(p('kemarin'), '2026-07-05');
  assert.equal(p('kemaren'), '2026-07-05');

  // Invalid tetap ditolak
  assert.equal(p('31/02/2026'), null);
  assert.equal(p('32/01/2026'), null);
  assert.equal(p('abc'), null);
  assert.equal(p(''), null);
});

test('dates: konversi WIB & selisih hari', () => {
  const { wibDateOf, diffDays } = require('../src/dates');
  // 16 Apr 22:03 UTC = 17 Apr 05:03 WIB — pembandingan harus pakai WIB
  assert.equal(wibDateOf('2026-04-16T22:03:39.000Z'), '2026-04-17');
  assert.equal(wibDateOf('2026-04-16T10:00:00.000Z'), '2026-04-16');
  assert.equal(diffDays('2026-04-16', '2026-04-17'), 1);
  assert.equal(diffDays(null, '2026-04-17'), null);
});

test('formatOrder: resi terbit != dikirim (kasus SP-260704SDAT8VAW)', () => {
  const { formatOrder } = require('../src/format');
  // Order FINISH_PICK: resi sudah dibuat tapi shipped_date null -> timeline
  // TIDAK boleh bilang "Dikirim".
  const o = formatOrder({
    salesorder_no: 'SP-TEST',
    internal_status: 'PROCESSING',
    created_date: '2026-07-04T14:08:45.548Z',
    payment_date: '2026-07-04T14:09:01.000Z',
    tn_created_date: '2026-07-06T02:30:36.254Z',
    items: [{ awb_created_date: '2026-07-06T02:30:36.254Z', shipped_date: null }],
  });
  const names = o.history.map((h) => h.history_name);
  assert.ok(names.includes('Resi dibuat'));
  assert.ok(!names.includes('Dikirim'));
  assert.equal(o.status, 'PROCESSING');
  // Kalau shipped_date terisi, barulah "Dikirim" muncul.
  const shipped = formatOrder({
    salesorder_no: 'SP-TEST2',
    internal_status: 'SHIPPED',
    created_date: '2026-07-04T14:08:45.548Z',
    items: [{ awb_created_date: '2026-07-06T02:30:36.254Z', shipped_date: '2026-07-06T05:00:00.000Z' }],
  });
  assert.equal(shipped.last_history.history_name, 'Dikirim');
});

test('formatOrder: failed_order_date pada order PAID tidak jadi event Gagal (kasus SHF-8506-128887)', () => {
  const { formatOrder } = require('../src/format');
  const paid = formatOrder({
    salesorder_no: 'SHF-TEST',
    internal_status: 'PAID',
    is_paid: true,
    created_date: '2026-07-07T09:00:21.067Z',
    failed_order_date: '2026-07-07T09:00:22.125Z',
    items: [],
  });
  assert.ok(!paid.history.some((h) => h.history_name === 'Gagal'));
  assert.equal(paid.status, 'PAID');
  // Order yang memang FAILED tetap menampilkan event Gagal.
  const failed = formatOrder({
    salesorder_no: 'SHF-TEST2',
    internal_status: 'FAILED',
    created_date: '2026-07-07T09:00:21.067Z',
    failed_order_date: '2026-07-07T09:00:22.125Z',
    items: [],
  });
  assert.ok(failed.history.some((h) => h.history_name === 'Gagal'));
});

test('buildNameQueries: sinonim ikut jadi query server', () => {
  const qs = buildNameQueries('Muhammad Rizky');
  assert.ok(qs.includes('muhammad rizky'));
  assert.ok(qs.some((q) => ['moh', 'muh', 'md'].includes(q)), `varian sinonim tidak ada: ${qs}`);
});
