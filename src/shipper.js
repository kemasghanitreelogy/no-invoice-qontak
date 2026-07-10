// Logika mengubah kurir (field `shipper`) order Jubelio + mapping tracking
// URL Shopify -> nama kurir. Dipakai webhook /webhooks/shopify/fulfillment
// dan scripts/update-shipper.js / scripts/sync-shipper-from-shopify.js.
const {
  getOrderDetail,
  smartLookup,
  trySearchByQuery,
  withAuth,
  http,
  authHeaders,
} = require('./jubelio');

// Mapping tracking URL -> nilai field Kurir di Jubelio (konfirmasi user 2026-07-10).
const URL_TO_SHIPPER = [
  { pattern: 'jet.co.id', shipper: 'jnt' },
  { pattern: 'lionparcel.com', shipper: 'lion' },
  { pattern: 'jne.co.id', shipper: 'jne' },
];

// Hanya order yang kurirnya masih placeholder ini yang diisi otomatis —
// nilai yang sudah diisi manual tidak ditimpa (keputusan user 2026-07-10).
const FILLABLE = new Set(['', 'domestic shipping']);

function shipperForTrackingUrl(url) {
  const lower = String(url || '').toLowerCase();
  for (const { pattern, shipper } of URL_TO_SHIPPER) {
    if (lower.includes(pattern)) return shipper;
  }
  return null;
}

// Periksa SEMUA tracking URL dan ambil mapping pertama yang dikenal — URL
// pertama bisa saja tidak dikenal sementara URL kedua dikenal.
function shipperFromTrackingUrls(urls) {
  for (const url of urls || []) {
    const s = shipperForTrackingUrl(url);
    if (s) return s;
  }
  return null;
}

// Fallback bila fulfillment dibuat manual TANPA tracking URL (kasus nyata
// #8528: company "J&T Express", url null): map dari nama kurir Shopify.
const COMPANY_TO_SHIPPER = [
  { pattern: 'j&t', shipper: 'jnt' },
  { pattern: 'jnt', shipper: 'jnt' },
  { pattern: 'lion', shipper: 'lion' },
  { pattern: 'jne', shipper: 'jne' },
];

function shipperFromCompanies(companies) {
  for (const company of companies || []) {
    const lower = String(company || '').toLowerCase();
    for (const { pattern, shipper } of COMPANY_TO_SHIPPER) {
      if (lower.includes(pattern)) return shipper;
    }
  }
  return null;
}

// Gabungan: URL lebih spesifik jadi diprioritaskan, nama kurir sebagai fallback.
function shipperFromFulfillment({ urls = [], companies = [] } = {}) {
  return shipperFromTrackingUrls(urls) || shipperFromCompanies(companies);
}

// Cari order Jubelio padanan order Shopify dengan dua jalur yang saling
// memverifikasi (ref_no Jubelio = legacy id order Shopify):
//   1. nomor order -> smartLookup("SHF-{no}"), diterima hanya jika ref_no cocok
//      (atau tidak bisa dibandingkan karena salah satunya kosong);
//   2. fallback: cari langsung dengan legacy id — pickFromRows punya
//      exact-match ref_no, jadi jalur ini presisi, bukan fuzzy.
// Mengembalikan { detail, via } atau null bila tidak ditemukan/tidak aman.
async function resolveOrderForShopify({ orderNum, shopifyOrderId }) {
  const refWanted = shopifyOrderId != null ? String(shopifyOrderId) : null;

  if (orderNum) {
    const result = await smartLookup(`SHF-${orderNum}`);
    if (result.found) {
      const refGot = result.order.ref_no != null ? String(result.order.ref_no) : null;
      if (!refWanted || !refGot || refGot === refWanted) {
        return { detail: result.order, via: 'salesorder_no' };
      }
      // ref_no tidak cocok = kemungkinan salah order — jangan dipakai,
      // coba jalur ref_no di bawah.
    }
  }

  if (refWanted) {
    const hit = await trySearchByQuery(refWanted, {});
    if (hit) {
      const detail = await getOrderDetail(hit.salesorder_id);
      if (detail && String(detail.ref_no ?? '') === refWanted) {
        return { detail, via: 'ref_no' };
      }
    }
  }

  return null;
}

const currentShipperOf = (detail) => {
  const itemShippers = [...new Set((detail.items || []).map((it) => it?.shipper).filter(Boolean))];
  return detail.shipper || itemShippers.join(' / ') || '';
};

const isFillable = (current) => FILLABLE.has(String(current || '').trim().toLowerCase());

// Susun payload saveSalesOrderRequest dari detail order: salin field yang
// dikenal skema edit, jangan kirim field lain (respons detail punya 162 field,
// skema edit hanya menerima 41).
function buildSavePayload(detail, newShipper) {
  // Field WAJIB menurut skema saveSalesOrderRequest — selalu dikirim, angka
  // yang kosong di-default 0 (menghapusnya membuat edit ditolak Jubelio).
  const header = {
    salesorder_id: detail.salesorder_id,
    salesorder_no: detail.salesorder_no,
    contact_id: detail.contact_id,
    customer_name: detail.customer_name ?? '',
    transaction_date: detail.transaction_date,
    sub_total: detail.sub_total ?? 0,
    total_disc: detail.total_disc ?? 0,
    total_tax: detail.total_tax ?? 0,
    grand_total: detail.grand_total ?? 0,
    location_id: detail.location_id ?? -1,
    source: detail.source,
    add_disc: detail.add_disc ?? 0,
    add_fee: detail.add_fee ?? 0,
    service_fee: detail.service_fee ?? 0,
  };
  // Field OPSIONAL — hanya dikirim bila detail memang punya nilainya.
  const optional = {
    is_tax_included: detail.is_tax_included ?? false,
    note: detail.note ?? '',
    ref_no: detail.ref_no ?? '',
    is_canceled: detail.is_canceled ?? false,
    channel_status: detail.channel_status ?? '',
    shipping_cost: detail.shipping_cost,
    insurance_cost: detail.insurance_cost,
    is_paid: detail.is_paid ?? false,
    shipping_full_name: detail.shipping_full_name ?? '',
    shipping_phone: detail.shipping_phone ?? '',
    shipping_address: detail.shipping_address ?? '',
    shipping_area: detail.shipping_area ?? '',
    shipping_city: detail.shipping_city ?? '',
    shipping_subdistrict: detail.shipping_subdistrict ?? '',
    shipping_province: detail.shipping_province ?? '',
    shipping_post_code: detail.shipping_post_code ?? '',
    shipping_country: detail.shipping_country ?? '',
    payment_method: detail.payment_method ?? '',
    store_id: detail.store_id,
    salesmen_id: detail.salesmen_id,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v != null) header[k] = v;
  }

  header.items = (detail.items || []).map((it) => {
    const item = {
      salesorder_detail_id: it.salesorder_detail_id,
      item_id: it.item_id,
      serial_no: it.serial_no,
      description: it.description,
      tax_id: it.tax_id,
      price: it.price,
      unit: it.unit,
      qty_in_base: it.qty_in_base,
      disc: it.disc,
      disc_amount: it.disc_amount,
      tax_amount: it.tax_amount,
      amount: it.amount,
      // Detail order memakai `loc_id`; skema edit meminta `location_id`.
      location_id: it.location_id ?? it.loc_id,
      shipper: newShipper,
      channel_order_detail_id: it.channel_order_detail_id,
      tracking_no: it.tracking_no,
    };
    for (const k of Object.keys(item)) {
      if (item[k] == null) delete item[k];
    }
    return item;
  });
  return header;
}

async function saveSalesOrder(payload) {
  return withAuth(async (token) => {
    const { data } = await http.post('/sales/orders/', payload, { headers: authHeaders(token) });
    return data;
  });
}

// Ubah shipper satu order + verifikasi dengan baca ulang.
// Jubelio menerima shipper lewat item tapi MENYIMPANNYA di header order
// (terbukti di SHF-8506-128887: items[].shipper tetap null, header berubah).
async function applyShipper(detail, newShipper) {
  const payload = buildSavePayload(detail, newShipper);
  const saved = await saveSalesOrder(payload);
  const after = await getOrderDetail(detail.salesorder_id);
  const afterShippers = [...new Set((after.items || []).map((it) => it?.shipper).filter(Boolean))];
  const afterValue = after.shipper || afterShippers.join(' / ') || '(kosong)';
  const changed =
    after.shipper === newShipper ||
    (afterShippers.length === 1 && afterShippers[0] === newShipper);
  return { saved, afterValue, changed };
}

module.exports = {
  URL_TO_SHIPPER,
  COMPANY_TO_SHIPPER,
  shipperForTrackingUrl,
  shipperFromTrackingUrls,
  shipperFromCompanies,
  shipperFromFulfillment,
  resolveOrderForShopify,
  isFillable,
  currentShipperOf,
  buildSavePayload,
  saveSalesOrder,
  applyShipper,
};
