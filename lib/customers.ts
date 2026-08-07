import type { AdminOrder } from "@/lib/admin-orders";
import type { FishRequest } from "@/lib/fish-requests";

export type CustomerType = "household" | "restaurant";

export type Customer = {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  line_user_id: string | null;
  customer_type: CustomerType;
  business_name: string | null;
  preferred_notification_channel: "line" | "email" | "phone" | null;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomerOrder = AdminOrder & { customer_id: string | null };

export function customerDisplayName(customer: Customer) {
  return customer.customer_type === "restaurant" && customer.business_name
    ? customer.business_name
    : customer.name || "未命名客戶";
}

export function customerTypeLabel(type: CustomerType) {
  return type === "restaurant" ? "餐廳／商用" : "家庭客";
}

export function formatCustomerPhone(phone: string) {
  return phone.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1-$2-$3");
}

export function customerOrderTotal(order: CustomerOrder) {
  return order.order_items.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
}

export function customerSummary(orders: CustomerOrder[]) {
  const completed = orders.filter((order) => order.status !== "cancelled");
  const spending = completed.reduce((sum, order) => sum + customerOrderTotal(order), 0);
  const sorted = [...completed].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return {
    orderCount: completed.length,
    spending,
    average: completed.length ? Math.round(spending / completed.length) : 0,
    firstPurchase: sorted[0]?.created_at || null,
    lastPurchase: sorted.at(-1)?.created_at || null
  };
}

export function frequentlyPurchased(orders: CustomerOrder[]) {
  const counts = new Map<string, number>();
  orders.filter((order) => order.status !== "cancelled").forEach((order) => {
    order.order_items.forEach((item) => counts.set(item.product_name, (counts.get(item.product_name) || 0) + item.quantity));
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}

export function activeFishRequests(requests: FishRequest[]) {
  return requests.filter((request) => ["waiting", "matched", "contacted"].includes(request.status));
}
