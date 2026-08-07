export type OrderStatus = "new" | "processing" | "ready" | "completed" | "cancelled" | "contacted" | "confirmed" | "paid" | "shipped";
export type PaymentStatus = "unpaid" | "paid";

export type AdminOrderItem = {
  id: string;
  order_id: string;
  product_name: string;
  variant_name: string | null;
  quantity: number;
  price: number | null;
  processing_preset_id: string | null;
  processing_preset_name: string | null;
  processing_option_ids: string[];
  processing_option_names: string[];
  processing_note: string | null;
};

export type AdminOrder = {
  id: string;
  customer_id?: string | null;
  customer_name: string;
  phone: string;
  email?: string | null;
  fulfillment: string;
  processing: string;
  note: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  created_at: string;
  order_items: AdminOrderItem[];
};

export const orderStatusOptions: Array<{ value: OrderStatus; label: string }> = [
  { value: "new", label: "新訂單" },
  { value: "processing", label: "處理中" },
  { value: "ready", label: "待配送／待取貨" },
  { value: "completed", label: "已完成" },
  { value: "cancelled", label: "已取消" }
];

export function orderStatusLabel(status: OrderStatus) {
  const legacyLabels: Partial<Record<OrderStatus, string>> = {
    contacted: "處理中",
    confirmed: "處理中",
    paid: "處理中",
    shipped: "待配送／待取貨"
  };
  return orderStatusOptions.find((option) => option.value === status)?.label || legacyLabels[status] || status;
}

export function paymentStatusLabel(status: PaymentStatus) {
  return status === "paid" ? "已付款" : "未付款";
}

export function orderTotal(order: AdminOrder) {
  return order.order_items.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
}

const presetContents: Record<string, string[]> = {
  "three-clean": ["去魚鱗", "去內臟", "去魚鰓"],
  "three-remove": ["去頭", "去尾", "去內臟"],
  none: []
};

export function processingSummary(item: AdminOrderItem) {
  const included = item.processing_preset_id ? presetContents[item.processing_preset_id] || [] : [];
  const containsPreset = included.every((name) => item.processing_option_names?.includes(name));
  const presetNames: Record<string, string> = { "three-clean": "三清", "three-remove": "三去", none: "不處理" };
  const name = item.processing_preset_id && containsPreset ? presetNames[item.processing_preset_id] || item.processing_preset_name || "客製化" : item.processing_preset_name || "不處理";
  const extras = item.processing_preset_id && containsPreset ? (item.processing_option_names || []).filter((option) => !included.includes(option)) : item.processing_option_names || [];
  return { name: name === "客製化處理" ? "客製化" : name, extras };
}

export function parseOrderNote(note: string | null) {
  const details: Record<string, string> = {};
  let customerNote = "";
  const unstructuredLines: string[] = [];
  (note || "").split("\n").forEach((line) => {
    const separator = line.indexOf("：");
    if (separator < 0) {
      if (line.trim()) unstructuredLines.push(line.trim());
      return;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "備註") customerNote = value;
    else if (["地址", "日期", "時間", "門市", "店號"].includes(key) && value) details[key] = value;
    else if (value) unstructuredLines.push(line.trim());
  });
  if (!customerNote && unstructuredLines.length) customerNote = unstructuredLines.join("\n");
  return { details, customerNote };
}

export function formatOrderTime(value: string, includeDate = false) {
  return new Intl.DateTimeFormat("zh-TW", includeDate ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
