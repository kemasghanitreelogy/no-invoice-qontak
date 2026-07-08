function pickActor(...candidates) {
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.trim()) return c.trim();
  }
  return 'system';
}

function buildHistory(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemAwb = items.map((it) => it?.awb_created_date).find(Boolean) || null;
  const itemShipped = items.map((it) => it?.shipped_date).find(Boolean) || null;
  const itemPicked = items.map((it) => it?.pick_scanned_date).find(Boolean) || null;
  const itemPacked = items.map((it) => it?.pack_scanned_date).find(Boolean) || null;

  const events = [
    { history_name: 'Dibuat',      at: order.created_date,                                         by: pickActor(order.username, order.user_name, order.source_name) },
    { history_name: 'Dibayar',     at: order.payment_date,                                         by: pickActor(order.username, 'system') },
    { history_name: 'Diambil',     at: itemPicked || order.tn_created_date,                        by: pickActor(order.picker, order.username) },
    { history_name: 'Dikemas',     at: itemPacked,                                                 by: pickActor(order.picker, order.username) },
    // Resi terbit BUKAN berarti paket sudah jalan — jangan dilabeli "Dikirim".
    // "Dikirim" hanya dari shipped_date asli (serah terima ke kurir).
    { history_name: 'Resi dibuat', at: itemAwb,                                                    by: 'system' },
    { history_name: 'Dikirim',     at: itemShipped,                                                by: 'system' },
    { history_name: 'Diterima',    at: order.received_date,                                        by: 'system' },
    // Kolom tanggal Jubelio tidak selalu mencerminkan kondisi akhir order:
    // failed_order_date bisa terisi walau order akhirnya PAID (gagal sinkron
    // sesaat lalu pulih — kasus SHF-8506-128887), dan tanggal cancel bisa
    // terisi saat pembeli cuma MENGAJUKAN batal lalu ditolak. Event batal/
    // gagal hanya ditampilkan jika status akhir order memang begitu.
    {
      history_name: 'Dibatalkan',
      at: String(order.internal_status || '').toUpperCase().includes('CANCEL')
        ? order.mp_cancel_date || order.internal_cancel_date
        : null,
      by: pickActor(order.mp_cancel_by, 'system'),
    },
    {
      history_name: 'Gagal',
      at: String(order.internal_status || '').toUpperCase().includes('FAILED')
        ? order.failed_order_date
        : null,
      by: 'system',
    },
    { history_name: 'Selesai',    at: order.completed_date || order.mp_completed_date,             by: 'system' },
  ];

  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .map((e, i) => ({ history_id: i + 1, history_name: e.history_name, at: e.at, by: e.by }));
}

function formatOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const num = (v) => (v != null && v !== '' ? Number(v) : 0);
  const products = (order.items || []).map((it) => {
    const qty = num(it.qty);
    // Harga net per unit = sell_price (sama dgn katalog master). `price` adalah
    // harga listing channel SEBELUM diskon (mis. Tokopedia 940rb -> net 790rb).
    const unitPrice = num(it.sell_price ?? it.original_price);
    const subtotal = it.amount != null ? num(it.amount) : unitPrice * qty;
    // Diskon order-level (add_disc / voucher) dialokasikan Jubelio langsung ke
    // `amount` tanpa mengisi disc_amount — turunkan dari selisih supaya angka
    // baris SELALU konsisten: price*qty - discount = subtotal.
    // (Kasus nyata: harga 690rb, subtotal 565rb, disc_amount 0 -> diskon 125rb.)
    const itemDisc = num(it.disc_amount);
    const derivedDisc = Math.max(0, unitPrice * qty - subtotal);
    return {
      name: it.item_name || it.description || it.item_code || '(tanpa nama)',
      sku: it.item_code || null,
      qty,
      price: unitPrice,                 // harga net per unit (sesuai katalog)
      list_price: num(it.price),        // harga gross channel sebelum diskon
      discount: itemDisc || derivedDisc, // nominal diskon efektif baris ini
      subtotal,                         // total net baris yang benar2 dibayar
    };
  });
  const history = buildHistory(order);
  const last_history = history.length ? history[history.length - 1] : null;

  // Jubelio tidak selalu menyediakan timestamp untuk kejadian retur/batal,
  // sehingga status bisa lebih baru daripada last_history (mis. status
  // RETURNED tapi timeline berhenti di "Dikirim"). status_note menjelaskan
  // itu supaya pembaca (bot CS) tidak salah mengira paket masih jalan.
  const status = order.internal_status || order.wms_status || order.channel_status || null;
  const statusUpper = String(status || '').toUpperCase();
  let status_note = null;
  if (statusUpper.includes('RETURN')) {
    status_note =
      'Order berstatus RETURNED (proses retur/pengembalian, ditandai marketplace mis. TO_RETURN). ' +
      'Tanggal kejadian retur tidak tersedia dari Jubelio, jadi timeline history bisa berhenti di "Dikirim". ' +
      'Detail alasan retur cek di Seller Center marketplace / menu Returned di Jubelio.';
  } else if (statusUpper.includes('CANCEL') && !history.some((h) => h.history_name === 'Dibatalkan')) {
    status_note =
      'Order berstatus CANCELLED tetapi tanggal pembatalan tidak tersedia dari Jubelio, ' +
      'jadi timeline history tidak memuat kejadian "Dibatalkan".';
  } else if (statusUpper.includes('FAILED') && !history.some((h) => h.history_name === 'Gagal')) {
    status_note = 'Order berstatus FAILED tetapi tanggal kejadian gagal tidak tersedia dari Jubelio.';
  }

  return {
    salesorder_no: order.salesorder_no,
    ref_no: order.ref_no || null,
    channel: order.source_name || null,
    store: order.store_name || null,
    customer: order.customer_name || null,
    shipping: {
      name: order.shipping_full_name || null,
      phone: order.shipping_phone || null, // sering disensor marketplace (****22)
      address: order.shipping_address || null,
      area: order.shipping_area || null,
      city: order.shipping_city || null,
      province: order.shipping_province || null,
      post_code: order.shipping_post_code || null,
      country: order.shipping_country || null,
      courier: order.shipper || null,
    },
    status,
    ...(status_note ? { status_note } : {}),
    // Status bayar eksplisit — jangan disimpulkan dari history (Shopify sering
    // tidak mengisi payment_date walau order lunas).
    is_paid: order.is_paid === true,
    payment_date: order.payment_date || null,
    transaction_date: order.transaction_date || null,
    last_history,
    grand_total: order.grand_total != null ? Number(order.grand_total) : null,
    // Rincian uang order-level supaya total selalu bisa dijelaskan:
    // sub_total - other_discount + shipping_cost (net) ~= grand_total.
    totals: {
      sub_total: num(order.sub_total),                    // total harga produk
      other_discount: num(order.add_disc),                // diskon lainnya/voucher order-level
      shipping_cost: num(order.shipping_cost),            // ongkir dibayar pembeli
      shipping_discount: num(order.shipping_cost_discount),
      insurance: num(order.insurance_cost),
      grand_total: order.grand_total != null ? Number(order.grand_total) : null,
    },
    products,
    history,
  };
}

module.exports = { formatOrder };
