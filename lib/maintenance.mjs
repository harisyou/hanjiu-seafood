const DEFAULT_RETRY_AFTER_SECONDS = 1800;

export function maintenanceConfig(env = process.env) {
  const rawMode = env.MAINTENANCE_MODE;
  const production = env.NODE_ENV === "production";
  const validMode = rawMode === undefined || rawMode === "" || rawMode === "on" || rawMode === "off";
  const active = rawMode === "on" || (production && !validMode);
  const parsedRetryAfter = Number(env.MAINTENANCE_RETRY_AFTER_SECONDS || DEFAULT_RETRY_AFTER_SECONDS);
  const retryAfterSeconds = Number.isInteger(parsedRetryAfter) && parsedRetryAfter >= 60 && parsedRetryAfter <= 86400
    ? parsedRetryAfter
    : DEFAULT_RETRY_AFTER_SECONDS;
  let lineUrl = null;
  if (env.MAINTENANCE_LINE_URL) {
    try {
      const parsed = new URL(env.MAINTENANCE_LINE_URL);
      if (parsed.protocol === "https:") lineUrl = parsed.toString();
    } catch {}
  }
  return { active, invalidMode: !validMode, retryAfterSeconds, lineUrl };
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

export function maintenanceHtml(config) {
  const contact = config.lineUrl
    ? `<a class="contact" href="${escapeHtml(config.lineUrl)}" rel="noreferrer noopener">透過 LINE 聯繫韓九</a>`
    : "";
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>系統維護中｜韓九嚴選生鮮</title>
<style>html{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(150deg,#eff7f4,#dcece7);color:#183f38;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif}.card{width:min(100%,600px);padding:clamp(28px,7vw,56px);border:1px solid #c8ddd6;border-radius:24px;background:rgba(255,255,255,.94);box-shadow:0 22px 60px rgba(25,74,66,.14);text-align:center}.brand{margin:0 0 22px;color:#0f6a5e;font-size:clamp(14px,3vw,18px);font-weight:900;letter-spacing:.14em}.mark{display:grid;width:68px;height:68px;margin:0 auto 20px;place-items:center;border-radius:50%;background:#e5f3ee;font-size:34px}.card h1{margin:0;font-size:clamp(28px,7vw,42px)}.card p{margin:18px auto 0;max-width:430px;color:#4b6761;font-size:17px;line-height:1.8}.contact{display:inline-flex;min-height:48px;margin-top:28px;align-items:center;justify-content:center;padding:12px 20px;border-radius:999px;background:#0b7969;color:white;font-weight:850;text-decoration:none}.hint{font-size:14px!important;color:#6d807b!important}@media(max-width:480px){body{padding:16px}.card{border-radius:18px}}</style></head>
<body><main class="card"><div class="mark" aria-hidden="true">🐟</div><p class="brand">韓九嚴選生鮮</p><h1>系統維護中</h1><p>目前暫停下單與後台操作，我們正在進行例行維護。請稍後再回來，感謝您的耐心等候。</p>${contact}<p class="hint">維護期間不會要求您提供訂單或付款資料。</p></main></body></html>`;
}

export { DEFAULT_RETRY_AFTER_SECONDS };
