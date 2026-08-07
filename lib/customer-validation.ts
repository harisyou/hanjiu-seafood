const TAIPEI_TIME_ZONE = "Asia/Taipei";

function taipeiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TAIPEI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function taipeiToday(date = new Date()) {
  const parts = taipeiParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function taipeiCurrentTime(date = new Date()) {
  const parts = taipeiParts(date);
  return `${parts.hour}:${parts.minute}`;
}

export function normalizeTaiwanMobile(value: string) {
  return value.replace(/[\s-]/g, "");
}

export function isValidTaiwanMobile(value: string) {
  return /^09\d{8}$/.test(normalizeTaiwanMobile(value));
}

export function isValidEmail(value: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

export function validateTaipeiDateTime(date: string, time = "", now = new Date()) {
  if (!date) return "";
  const today = taipeiToday(now);
  if (date < today) return "希望日期不能早於今天";
  if (date === today && time && time <= taipeiCurrentTime(now)) return "取貨／配送時間不能早於目前時間";
  return "";
}
