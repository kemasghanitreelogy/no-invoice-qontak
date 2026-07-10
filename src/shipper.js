// Logika mengubah kurir (field `shipper`) order Jubelio + mapping tracking
// URL Shopify -> nama kurir. Dipakai webhook /webhooks/shopify/fulfillment
// dan scripts/update-shipper.js / scripts/sync-shipper-from-shopify.js.
const { getOrderDetail, withAuth, http, authHeaders } = require('./jubelio');

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

const currentShipperOf = (detail) => {
  const itemShippers = [...new Set((detail.items || []).map((it) => it?.shipper).filter(Boolean))];
  return detail.shipper || itemShippers.join(' / ') || '';
};

const isFillable = (current) => FILLABLE.has(String(current || '').trim().toLowerCase());

// Susun payload saveSalesOrderRequest dari detail order: salin field yang
// dikenal skema edit, jangan kirim field lain (respons detail punya 162 field,
// skema edit hanya menerima 41).
function buildSavePayload(detail, newShipper) {
  const header = {
    salesorder_id: detail.salesorder_id,
    salesorder_no: detail.salesorder_no,
    contact_id: detail.contact_id,
    customer_name: detail.customer_name,
    transaction_date: detail.transaction_date,
    is_tax_included: detail.is_tax_included ?? false,
    note: detail.note ?? '',
    sub_total: detail.sub_total,
    total_disc: detail.total_disc,
    total_tax: detail.total_tax,
    grand_total: detail.grand_total,
    ref_no: detail.ref_no ?? '',
    location_id: detail.location_id,
    source: detail.source,
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
    add_disc: detail.add_disc ?? 0,
    add_fee: detail.add_fee ?? 0,
    service_fee: detail.service_fee ?? 0,
    payment_method: detail.payment_method ?? '',
    store_id: detail.store_id,
    salesmen_id: detail.salesmen_id,
  };
  // Field opsional yang nilainya null/undefined tidak usah dikirim.
  for (const k of Object.keys(header)) {
    if (header[k] == null) delete header[k];
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
  shipperForTrackingUrl,
  isFillable,
  currentShipperOf,
  buildSavePayload,
  saveSalesOrder,
  applyShipper,
};
