"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buildArrivalContactMessage } from "@/lib/arrival-contact";
import { arrivalWorkflowActions, FishRequest, FishRequestStatus, fishRequestStatusLabel, formatWantedBy, notificationLabel } from "@/lib/fish-requests";
import { canCreateOrderDraft } from "@/lib/order-draft";

type Props = {
  request: FishRequest;
  fishName: string;
  busy: boolean;
  onClose: () => void;
  onUpdateStatus: (status: FishRequestStatus) => void;
  onCreateOrderDraft: () => void;
};

export default function ContactWorkspace({ request, fishName, busy, onClose, onUpdateStatus, onCreateOrderDraft }: Props) {
  const [message, setMessage] = useState(() => buildArrivalContactMessage(request.customer_name, fishName));
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [onClose]);

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
      setFeedback("訊息已複製，可以貼到常用聯絡工具。");
    } catch {
      setFeedback("無法自動複製，請長按或選取訊息後複製。");
    }
  }

  const emailHref = request.email ? `mailto:${request.email}?subject=${encodeURIComponent(`${fishName} 到貨通知`)}&body=${encodeURIComponent(message)}` : "";

  return <div className="contactWorkspaceBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="contactWorkspace" role="dialog" aria-modal="true" aria-labelledby="contact-workspace-title">
      <header><div><small>人工聯絡輔助</small><h2 id="contact-workspace-title">聯絡 {request.customer_name}</h2><span className={`requestStatus status-${request.status}`}>{fishRequestStatusLabel(request.status)}</span></div><button type="button" className="contactWorkspaceClose" aria-label="關閉聯絡工作台" onClick={onClose}>×</button></header>
      <div className="contactWorkspaceBody">
        <section className="contactWorkspaceDetails" aria-label="需求與聯絡資料"><dl><div><dt>客戶姓名</dt><dd>{request.customer_name}</dd></div><div><dt>正式魚種</dt><dd>{fishName}</dd></div>{request.fish_name !== fishName && <div><dt>原始名稱快照</dt><dd>{request.fish_name}</dd></div>}<div><dt>電話</dt><dd><a href={`tel:${request.phone}`}>{request.phone}</a></dd></div>{request.email && <div><dt>Email</dt><dd><a href={`mailto:${request.email}`}>{request.email}</a></dd></div>}<div><dt>LINE</dt><dd>{request.line_user_id ? "已綁定（目前無安全直達對話功能）" : "尚未綁定"}</dd></div><div><dt>數量需求</dt><dd>{request.quantity_request}</dd></div><div><dt>尺寸偏好</dt><dd>{request.size_preference || "未指定"}</dd></div><div><dt>預算</dt><dd>{request.budget || "未指定"}</dd></div><div><dt>希望日期</dt><dd>{formatWantedBy(request.wanted_by)}</dd></div><div><dt>用途</dt><dd>{request.purpose || "未指定"}</dd></div><div><dt>偏好通知</dt><dd>{notificationLabel(request)}</dd></div><div><dt>目前狀態</dt><dd>{fishRequestStatusLabel(request.status)}</dd></div></dl>{request.note && <div className="contactWorkspaceNote"><strong>備註</strong><p>{request.note}</p></div>}</section>
        <section className="contactMessageEditor"><label htmlFor={`contact-message-${request.id}`}>建議聯絡訊息</label><small>請依實際魚況調整後，再貼到您使用的聯絡工具。</small><textarea id={`contact-message-${request.id}`} rows={7} value={message} onChange={(event) => setMessage(event.target.value)} /><div className="contactPrimaryActions"><button type="button" onClick={copyMessage}>複製訊息</button><a className="buttonLink secondaryAdminAction" href={`tel:${request.phone}`}>撥打電話</a>{request.email && <a className="buttonLink secondaryAdminAction" href={emailHref}>開啟 Email</a>}<Link className="buttonLink secondaryAdminAction" href={`/admin/requests/${request.id}`}>需求詳情</Link></div><p className="contactFeedback" aria-live="polite">{feedback}</p></section>
      </div>
      <footer>{canCreateOrderDraft(request) && <button type="button" className="openContactWorkspace createDraftAction" onClick={onCreateOrderDraft}>建立訂單草稿</button>}<strong>更新需求狀態</strong><div className="matchWorkflowActions">{arrivalWorkflowActions.map((action) => <button type="button" className={action.status === "cancelled" ? "dangerSecondaryAction" : action.status === request.status ? "currentWorkflowAction" : "secondaryAdminAction"} disabled={busy || action.status === request.status} onClick={() => onUpdateStatus(action.status)} key={action.status}>{busy ? "更新中…" : action.label}</button>)}</div></footer>
    </section>
  </div>;
}
