// Util tanggal untuk input pencarian & pembandingan payment_date.
// Jubelio menyimpan timestamp UTC; pengguna berpikir dalam WIB — semua
// pembandingan kalender dilakukan setelah konversi +7 jam.

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// Terima "YYYY-MM-DD", "DD/MM/YYYY", "DD-MM-YYYY" -> "YYYY-MM-DD", else null.
function parseDateInput(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (m) return valid(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return valid(m[3], m[2], m[1]);
  return null;
}

function valid(y, mo, d) {
  const yy = Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// Timestamp ISO (UTC) -> tanggal kalender WIB "YYYY-MM-DD", null jika invalid.
function wibDateOf(isoString) {
  if (!isoString) return null;
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

// Selisih hari antar dua "YYYY-MM-DD" (b - a); null jika salah satunya kosong.
function diffDays(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
}

module.exports = { parseDateInput, wibDateOf, diffDays };
