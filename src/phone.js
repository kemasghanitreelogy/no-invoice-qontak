// Resolusi nomor telepon LENGKAP dari segala sumber. Detail order Jubelio
// menyensor nomor (mis. "**********95"), padahal tracking JNE di BinderByte
// butuh 5 digit terakhir HP penerima. Urutan sumber (dari yang termurah):
//   1. detail order sendiri — kadang tidak disensor (order internal lama);
//   2. kontak Jubelio (GET /contacts/{id}) — terbukti utuh utk order
//      internal/WS (kasus Desak: "+62 813-3857-8895");
//   3. Shopify Admin API via ref_no (= legacy order id) — terbukti utuh utk
//      order SHF (kasus #8519: shippingAddress.phone "+62816947095").
// Order marketplace (Shopee/Tokopedia/TikTok) disensor dari sumbernya —
// tidak ada jalur legal untuk membukanya; fungsi ini mengembalikan null.
const { getOrderDetail, withAuth, http, authHeaders } = require('./jubelio');
const { withRetry } = require('./retry');

const SHOPIFY_API_VERSION = '2026-07';

const isMaskedPhone = (v) => {
  const s = String(v || '').trim();
  return !s || s.includes('*');
};

// "+62 813-3857-8895" -> "6281338578895"; "0816947095" -> "0816947095"
const phoneDigits = (v) => String(v || '').replace(/\D/g, '');

const last5 = (v) => {
  const d = phoneDigits(v);
  return d.length >= 5 ? d.slice(-5) : null;
};

async function phoneFromContact(contactId) {
  if (!contactId) return null;
  const { data } = await withAuth((t) => http.get(`/contacts/${contactId}`, { headers: authHeaders(t) }));
  for (const candidate of [data?.phone, data?.mobile]) {
    if (!isMaskedPhone(candidate)) return candidate;
  }
  return null;
}

async function phoneFromShopify(refNo) {
  const store = String(process.env.STORE_NAME || '').replace(/\.myshopify\.com.*$/, '');
  const token = process.env.ADMIN_API_KEY;
  if (!store || !token || !/^\d+$/.test(String(refNo || ''))) return null;
  // Divalidasi lawan schema live 2026-07 (artifact order-phone-q1).
  const query = `query OrderPhone($id: ID!) {
    order(id: $id) {
      phone
      customer { defaultPhoneNumber { phoneNumber } }
      shippingAddress { phone }
    }
  }`;
  const res = await fetch(`https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { id: `gid://shopify/Order/${refNo}` } }),
  });
  if (!res.ok) {
    const err = new Error(`Shopify HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const order = json?.data?.order;
  if (!order) return null;
  for (const candidate of [
    order.shippingAddress?.phone, // paling sering terisi (alamat kirim)
    order.phone,
    order.customer?.defaultPhoneNumber?.phoneNumber,
  ]) {
    if (!isMaskedPhone(candidate)) return candidate;
  }
  return null;
}

// Kembalikan { phone, last5, source } atau null bila semua sumber buntu.
// Tiap sumber dicoba dengan retry ringan; kegagalan satu sumber TIDAK
// menggagalkan rantai — lanjut ke sumber berikutnya.
async function resolveFullPhone(detail) {
  if (!isMaskedPhone(detail?.shipping_phone)) {
    return { phone: detail.shipping_phone, last5: last5(detail.shipping_phone), source: 'order_detail' };
  }
  if (!isMaskedPhone(detail?.customer_phone)) {
    return { phone: detail.customer_phone, last5: last5(detail.customer_phone), source: 'order_detail' };
  }

  try {
    const phone = await withRetry(() => phoneFromContact(detail?.contact_id), { attempts: 2, label: 'phone.contact' });
    if (phone) return { phone, last5: last5(phone), source: 'jubelio_contact' };
  } catch (err) {
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'phone.contact.fail', message: err.message }));
  }

  try {
    const phone = await withRetry(() => phoneFromShopify(detail?.ref_no), { attempts: 2, label: 'phone.shopify' });
    if (phone) return { phone, last5: last5(phone), source: 'shopify' };
  } catch (err) {
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'phone.shopify.fail', message: err.message }));
  }

  return null;
}

module.exports = { resolveFullPhone, isMaskedPhone, phoneDigits, last5 };
