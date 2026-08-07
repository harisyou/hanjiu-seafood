export type FishRequestStatus = "waiting" | "matched" | "contacted" | "converted" | "closed";
export type NotificationChannel = "line" | "email" | "phone";

export type FishRequest = {
  id: string;
  customer_id: string | null;
  customer_name: string;
  phone: string;
  email: string | null;
  line_user_id: string | null;
  fish_name: string;
  quantity_request: string;
  size_preference: string | null;
  budget: string | null;
  wanted_by: string | null;
  purpose: string | null;
  note: string | null;
  preferred_notification_channel: NotificationChannel;
  status: FishRequestStatus;
  created_at: string;
  updated_at: string;
};

export const fishRequestStatusOptions: Array<{ value: FishRequestStatus; label: string }> = [
  { value: "waiting", label: "等待中" },
  { value: "matched", label: "已找到" },
  { value: "contacted", label: "已聯絡" },
  { value: "converted", label: "已成交" },
  { value: "closed", label: "已結束" }
];

export function fishRequestStatusLabel(status: FishRequestStatus) {
  return fishRequestStatusOptions.find((option) => option.value === status)?.label || status;
}

export function notificationLabel(request: FishRequest) {
  if (request.preferred_notification_channel === "line") return request.line_user_id ? "偏好 LINE｜可通知" : "偏好 LINE｜尚未綁定";
  if (request.preferred_notification_channel === "email") return "Email";
  return "簡訊／電話";
}

export function formatWantedBy(value: string | null) {
  if (!value) return "未指定";
  return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(new Date(`${value}T00:00:00`));
}
