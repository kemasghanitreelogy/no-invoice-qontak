// Kamus variasi/nickname nama Indonesia. Data murni — tambah grup baru di sini
// saat eval menemukan pasangan yang belum tertangkap.
// Match via kamus bernilai skor 0.95 (bukti kuat, BUKAN identitas) dan tidak
// pernah menaikkan tier ke `exact` (design doc §3.2).

const GROUPS = [
  ['muhammad', 'muhamad', 'mohammad', 'mohamad', 'mochammad', 'mochamad', 'moch', 'moh', 'muh', 'mhd', 'md'],
  ['ahmad', 'achmad', 'akhmad', 'ahmed'],
  ['abdul', 'abd', 'abdoel'],
  ['nur', 'noor', 'noer'],
  ['yusuf', 'jusuf', 'yusup', 'ucup'],
  ['yosef', 'josef', 'yoseph', 'joseph', 'yosep', 'josep'],
  ['umar', 'oemar'],
  ['usman', 'oesman', 'utsman', 'uthman'],
  ['aisyah', 'aisha', 'aishah', 'aisah'],
  ['fatimah', 'fatima', 'fatmah', 'fatma'],
  ['khadijah', 'khodijah', 'kadijah', 'chodijah'],
  ['rizky', 'rizki', 'rizqi', 'riski', 'risky', 'rezki', 'rezky'],
  ['dedi', 'dedy', 'deddy'],
  ['andi', 'andy'],
  ['edi', 'edy', 'eddy'],
  ['hendri', 'hendry', 'henry'],
  ['soni', 'sony', 'sonny'],
  ['doni', 'dony', 'donny'],
  ['toni', 'tony', 'tonny'],
  ['roni', 'rony', 'ronny'],
  ['yeni', 'yenny', 'yenni', 'jeni', 'jenny'],
  ['lili', 'lilis', 'lily'],
  ['kristina', 'christina', 'cristina'],
  ['kristian', 'christian', 'cristian'],
  ['stefani', 'stephanie', 'stefanie', 'stephani', 'stefany'],
  ['yohanes', 'johanes', 'johannes', 'yohannes'],
  ['yohan', 'johan'],
  ['siti', 'sitti'],
  ['aditya', 'adithya', 'aditia', 'adytia'],
  ['syaiful', 'saiful', 'syaifullah', 'saifullah'],
  ['zainal', 'jainal', 'zaenal'],
  ['nurdin', 'noerdin', 'nordin'],
];

const TOKEN_TO_GROUP = new Map();
GROUPS.forEach((group, idx) => {
  for (const t of group) TOKEN_TO_GROUP.set(t, idx);
});

function synonymGroup(token) {
  const g = TOKEN_TO_GROUP.get(token);
  return g === undefined ? null : g;
}

function sameSynonymGroup(a, b) {
  const ga = synonymGroup(a);
  return ga !== null && ga === synonymGroup(b);
}

// Varian untuk candidate generation (query substring ke Jubelio):
// varian terpendek (>=3 huruf) + kanonik, supaya "muhammad" ikut menemukan
// baris "Moh. Rizky" di server.
function queryVariants(token) {
  const g = synonymGroup(token);
  if (g === null) return [];
  const group = GROUPS[g].filter((t) => t !== token && t.length >= 3);
  if (!group.length) return [];
  const shortest = group.reduce((a, b) => (b.length < a.length ? b : a));
  const canonical = GROUPS[g][0];
  return [...new Set([shortest, canonical])].filter((t) => t !== token);
}

module.exports = { GROUPS, synonymGroup, sameSynonymGroup, queryVariants };
