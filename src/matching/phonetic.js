// Ejaan Lama -> EYD + phonetic key untuk nama Indonesia.
// Dua lapisan terpisah:
//  - oldToEyd: transduser deterministik ejaan kolonial (Oemar->Umar, Djoko->Joko)
//  - phoneticKey: kunci fonetik agresif; HANYA dipakai sebagai bonus skor (0.95),
//    tidak pernah dianggap identitas (lihat design doc §3.2)

function oldToEyd(token) {
  return String(token || '')
    .replace(/oe/g, 'u')   // Oemar -> Umar
    .replace(/dj/g, 'j')   // Djoko -> Joko
    .replace(/tj/g, 'c')   // Tjahjadi -> Cahjadi
    .replace(/nj/g, 'ny')  // Njoman -> Nyoman
    .replace(/sj/g, 'sy')  // Sjarif -> Syarif
    .replace(/ch/g, 'kh'); // Chairil -> Khairil
}

// Catatan aturan:
// - j/y/i dilebur ke 'i' (Jusuf==Yusuf; ejaan lama pakai j untuk bunyi y)
// - v->f (Vitri==Fitri), z/x->s, q->k, kh->k, sy->s, dh->d, th->t, gh->g
// - huruf ganda diringkas (Dedde -> dede)
function phoneticKey(token) {
  let t = oldToEyd(String(token || '').toLowerCase());
  t = t
    .replace(/kh/g, 'k')
    .replace(/sy/g, 's')
    .replace(/dh/g, 'd')
    .replace(/th/g, 't')
    .replace(/gh/g, 'g')
    .replace(/v/g, 'f')
    .replace(/z/g, 's')
    .replace(/q/g, 'k')
    .replace(/x/g, 's')
    .replace(/j/g, 'y')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');
  return t;
}

module.exports = { oldToEyd, phoneticKey };
