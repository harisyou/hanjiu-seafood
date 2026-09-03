"use client";
export default function ProductError({ reset }: { reset: () => void }) { return <section className="content" role="alert"><h1>商品暫時無法載入</h1><p>請稍後重試。</p><button onClick={reset}>重新載入</button></section>; }
