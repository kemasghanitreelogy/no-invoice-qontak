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
    { history_name: 'Dibuat',     at: order.created_date,                                          by: pickActor(order.username, order.user_name, order.source_name) },
    { history_name: 'Dibayar',    at: order.payment_date,                                          by: pickActor(order.username, 'system') },
    { history_name: 'Diambil',    at: itemPicked || order.tn_created_date,                         by: pickActor(order.picker, order.username) },
    { history_name: 'Dikemas',    at: itemPacked,                                                  by: pickActor(order.picker, order.username) },
    { history_name: 'Dikirim',    at: itemAwb || itemShipped,                                      by: 'system' },
    { history_name: 'Diterima',   at: order.received_date,                                         by: 'system' },
    { history_name: 'Dibatalkan', at: order.mp_cancel_date || order.internal_cancel_date,          by: pickActor(order.mp_cancel_by, 'system') },
    { history_name: 'Gagal',      at: order.failed_order_date,                                     by: 'system' },
    { history_name: 'Selesai',    at: order.completed_date || order.mp_completed_date,             by: 'system' },
  ];

  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .map((e, i) => ({ history_id: i + 1, history_name: e.history_name, at: e.at, by: e.by }));
}

function formatOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const products = (order.items || []).map((it) => ({
    name: it.item_name || it.description || it.item_code || '(tanpa nama)',
    sku: it.item_code || null,
    qty: Number(it.qty || 0),
  }));
  const history = buildHistory(order);
  const last_history = history.length ? history[history.length - 1] : null;
  return {
    salesorder_no: order.salesorder_no,
    ref_no: order.ref_no || null,
    channel: order.source_name || null,
    store: order.store_name || null,
    customer: order.customer_name || null,
    status: order.internal_status || order.wms_status || order.channel_status || null,
    transaction_date: order.transaction_date || null,
    last_history,
    grand_total: order.grand_total != null ? Number(order.grand_total) : null,
    products,
    history,
  };
}

module.exports = { formatOrder };
