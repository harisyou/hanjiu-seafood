"use client";

import { FormEvent, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { isValidEmail, isValidTaiwanMobile, normalizeTaiwanMobile, taipeiToday, validateTaipeiDateTime } from "@/lib/customer-validation";

type RequestForm = {
  fishName: string; quantity: string; size: string; budget: string; wantedBy: string;
  purpose: string; customerName: string; phone: string; email: string;
  channel: "line" | "email" | "phone"; note: string;
};

const initialForm: RequestForm = { fishName: "", quantity: "", size: "", budget: "", wantedBy: "", purpose: "", customerName: "", phone: "", email: "", channel: "phone", note: "" };

export default function FishRequestForm() {
  const supabase = useMemo(() => createClient(), []);
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (!form.fishName.trim() || !form.quantity.trim() || !form.customerName.trim() || !form.phone.trim()) {
      setMessage("請填寫想找的魚、需求量、姓名與手機號碼。");
      return;
    }
    if (!isValidTaiwanMobile(form.phone)) {
      setMessage("電話格式錯誤，請輸入 10 碼手機號碼。");
      return;
    }
    if (form.email.trim() && !isValidEmail(form.email)) {
      setMessage("Email 格式錯誤，請確認後再試。");
      return;
    }
    const dateError = validateTaipeiDateTime(form.wantedBy);
    if (dateError) { setMessage(dateError); return; }
    const normalizedPhone = normalizeTaiwanMobile(form.phone);
    setSubmitting(true); setMessage("");
    const { data, error } = await supabase.rpc("create_fish_request", {
      p_customer_name: form.customerName, p_phone: normalizedPhone, p_email: form.email || null,
      p_fish_name: form.fishName, p_quantity_request: form.quantity,
      p_size_preference: form.size || null, p_budget: form.budget || null,
      p_wanted_by: form.wantedBy || null, p_purpose: form.purpose || null,
      p_note: form.note || null, p_preferred_notification_channel: form.channel
    });
    setSubmitting(false);
    if (error || !data) {
      console.error("Fish request submission failed", error);
      setMessage(error?.message.includes("wanted_by_in_past") ? "希望日期不能早於今天" : "需求送出失敗，請稍後再試。\n也可以直接透過 LINE 與韓九聯絡。");
      return;
    }
    setSuccess(true); setForm(initialForm);
  }

  if (success) return <section className="fishRequestSuccess" aria-live="polite"><span>🐟</span><h2>已收到你的需求</h2><p>如果有看到適合的魚，<br />韓九會再聯絡你。</p><button type="button" onClick={() => setSuccess(false)}>再找另一種魚</button></section>;

  return <form className="fishRequestForm" onSubmit={submit} noValidate>
    <div className="fishRequestFields">
      <label>想找的魚 *<input required placeholder="例如：馬頭、赤鯮" value={form.fishName} onChange={(event) => setForm({ ...form, fishName: event.target.value })} /></label>
      <label>數量／需求量 *<input required placeholder="例如：2尾、3斤、大約5人份" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>
      <label>希望尺寸<input placeholder="例如：大尾一點、約1斤左右" value={form.size} onChange={(event) => setForm({ ...form, size: event.target.value })} /></label>
      <label>預算<input placeholder="例如：每尾 500 左右" value={form.budget} onChange={(event) => setForm({ ...form, budget: event.target.value })} /></label>
      <label>希望收到日期<input type="date" min={taipeiToday()} value={form.wantedBy} onChange={(event) => setForm({ ...form, wantedBy: event.target.value })} /></label>
      <label>用途<select value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}><option value="">請選擇</option><option>家庭料理</option><option>聚餐</option><option>送禮</option><option>餐廳</option><option>其他</option></select></label>
      <label>姓名 *<input required autoComplete="name" value={form.customerName} onChange={(event) => setForm({ ...form, customerName: event.target.value })} /></label>
      <label>手機號碼 *<input required type="tel" inputMode="tel" autoComplete="tel" placeholder="例如：0912-345-678" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /><small>例如：0912-345-678</small></label>
      <label className="fullField">Email<input type="email" autoComplete="email" placeholder="可填寫任何有效 Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
    </div>
    <fieldset className="notificationChoices"><legend>偏好通知方式</legend><label><input type="radio" name="notification" checked={form.channel === "line"} onChange={() => setForm({ ...form, channel: "line" })} />LINE</label><label><input type="radio" name="notification" checked={form.channel === "email"} onChange={() => setForm({ ...form, channel: "email" })} />Email</label><label><input type="radio" name="notification" checked={form.channel === "phone"} onChange={() => setForm({ ...form, channel: "phone" })} />簡訊／電話</label><small>選擇你最方便的聯絡方式，有魚到貨時韓九會優先透過此方式聯絡你。<br />LINE 尚未綁定時，韓九會依你留下的電話或 Email 聯絡。</small></fieldset>
    <label className="fishRequestNote">其他需求<textarea rows={5} placeholder={"例如：\n不要太小尾\n如果價格漂亮可以多拿\n希望適合清蒸\n餐廳每週可能固定需要"} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
    <button className="fishRequestSubmit" disabled={submitting} aria-busy={submitting}>{submitting ? "送出中…" : "送出需求"}</button>
    <div className="fishRequestMessage" aria-live="polite">{message && <p>{message}</p>}</div>
  </form>;
}
