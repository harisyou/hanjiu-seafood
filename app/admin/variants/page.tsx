"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";

type Product = {
  id: string;
  name: string;
  status: "available" | "sold_out" | "hidden";
};

type Variant = {
  id?: string;
  product_id: string;
  name: string;
  weight_liang: number | null;
  price: number;
  stock: number;
  is_active: boolean;
  sort_order: number;
};

function liangLabel(value: number | null) {
  if (value === null || Number.isNaN(value)) return "";
  const jin = Math.floor(value / 16);
  const liang = value % 16;
  if (jin > 0 && liang > 0) return `約 ${jin} 台斤 ${liang} 兩`;
  if (jin > 0) return `約 ${jin} 台斤`;
  return `約 ${liang} 兩`;
}

function stockLabel(stock: number) {
  if (stock <= 0) return "已售完";
  if (stock === 1) return "最後 1 份";
  if (stock <= 4) return "剩少量";
  return "現貨充足";
}

export default function ProductVariantsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [variants, setVariants] = useState<Variant[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const email = data.session?.user.email || "";
      setUser(email);
      setReady(true);
      if (email) loadProducts();
    });
  }, [supabase]);

  useEffect(() => {
    if (productId) loadVariants(productId);
    else setVariants([]);
  }, [productId]);

  async function loadProducts() {
    const { data, error } = await supabase
      .from("products")
      .select("id,name,status")
      .order("sort_order", { ascending: true });

    if (error) {
      setNotice(`商品讀取失敗：${error.message}`);
      return;
    }

    const rows = (data || []) as Product[];
    setProducts(rows);
    if (!productId && rows.length > 0) setProductId(rows[0].id);
  }

  async function loadVariants(selectedProductId: string) {
    const { data, error } = await supabase
      .from("product_variants")
      .select("*")
      .eq("product_id", selectedProductId)
      .order("sort_order", { ascending: true });

    if (error) {
      setNotice(`規格讀取失敗：${error.message}`);
      return;
    }

    setVariants((data || []) as Variant[]);
  }

  function addRow() {
    const nextOrder = variants.length === 0
      ? 100
      : Math.max(...variants.map((item) => item.sort_order || 0)) + 10;

    setVariants((current) => [
      ...current,
      {
        product_id: productId,
        name: "",
        weight_liang: null,
        price: 0,
        stock: 0,
        is_active: true,
        sort_order: nextOrder
      }
    ]);
  }

  function updateRow(index: number, patch: Partial<Variant>) {
    setVariants((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item
      )
    );
  }

  async function saveAll() {
    if (!productId) {
      setNotice("請先選擇商品。");
      return;
    }

    if (variants.some((item) => !item.name.trim())) {
      setNotice("每一列都要填寫規格名稱。");
      return;
    }

    if (variants.some((item) => item.price < 0 || item.stock < 0)) {
      setNotice("價格與庫存不能是負數。");
      return;
    }

    setBusy(true);
    setNotice("");

    try {
      for (const variant of variants) {
        const payload = {
          product_id: productId,
          name: variant.name.trim(),
          weight_liang: variant.weight_liang,
          price: Number(variant.price),
          stock: Number(variant.stock),
          is_active: variant.is_active,
          sort_order: Number(variant.sort_order) || 100
        };

        const result = variant.id
          ? await supabase.from("product_variants").update(payload).eq("id", variant.id)
          : await supabase.from("product_variants").insert(payload);

        if (result.error) throw result.error;
      }

      setNotice("所有規格已儲存。");
      await loadVariants(productId);
    } catch (error) {
      setNotice(error instanceof Error ? `儲存失敗：${error.message}` : "儲存失敗。");
    } finally {
      setBusy(false);
    }
  }

  async function removeRow(index: number) {
    const row = variants[index];
    if (!confirm(`確定刪除「${row.name || "這個規格"}」嗎？`)) return;

    if (row.id) {
      const { error } = await supabase.from("product_variants").delete().eq("id", row.id);
      if (error) {
        setNotice(`刪除失敗：${error.message}`);
        return;
      }
    }

    setVariants((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setNotice("規格已刪除。");
  }

  function applyPriceChange(amount: number) {
    setVariants((current) =>
      current.map((item) => ({ ...item, price: Math.max(0, item.price + amount) }))
    );
  }

  if (!ready) return <main className="variantPage"><p>正在確認登入狀態…</p></main>;

  if (!user) {
    return (
      <main className="variantPage">
        <section className="variantCard">
          <h1>請先登入店家後台</h1>
          <p>登入後才能管理商品規格。</p>
          <a className="primaryLink" href="/admin">前往登入</a>
        </section>
        <Styles />
      </main>
    );
  }

  return (
    <main className="variantPage">
      <header className="variantHeader">
        <div>
          <a href="/admin">← 回店家後台</a>
          <p className="eyebrow">HARIS OS · F001</p>
          <h1>商品規格管理</h1>
          <p>每個重量可設定不同價格、庫存與販售狀態。</p>
        </div>
        <button className="outlineButton" type="button" onClick={() => loadVariants(productId)}>
          重新整理
        </button>
      </header>

      <section className="variantCard">
        <label className="productPicker">
          選擇商品
          <select value={productId} onChange={(event) => setProductId(event.target.value)}>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}{product.status === "hidden" ? "（已隱藏）" : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="toolbar">
          <button type="button" onClick={addRow}>＋ 新增規格</button>
          <button type="button" onClick={() => applyPriceChange(100)}>全部＋100</button>
          <button type="button" onClick={() => applyPriceChange(-100)}>全部－100</button>
          <button className="saveButton" type="button" disabled={busy} onClick={saveAll}>
            {busy ? "儲存中…" : "儲存全部"}
          </button>
        </div>

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>規格名稱</th>
                <th>重量（兩）</th>
                <th>前台顯示</th>
                <th>售價</th>
                <th>庫存</th>
                <th>客人看到</th>
                <th>販售</th>
                <th>排序</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {variants.map((variant, index) => (
                <tr key={variant.id || `new-${index}`}>
                  <td>
                    <input
                      value={variant.name}
                      placeholder="例如：約 9 兩"
                      onChange={(event) => updateRow(index, { name: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={variant.weight_liang ?? ""}
                      onChange={(event) => {
                        const value = event.target.value === "" ? null : Number(event.target.value);
                        updateRow(index, {
                          weight_liang: value,
                          name: variant.name || liangLabel(value)
                        });
                      }}
                    />
                  </td>
                  <td className="muted">{liangLabel(variant.weight_liang) || "自訂規格"}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={variant.price}
                      onChange={(event) => updateRow(index, { price: Number(event.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={variant.stock}
                      onChange={(event) => updateRow(index, { stock: Number(event.target.value) })}
                    />
                  </td>
                  <td><span className={`stockBadge stock-${Math.min(5, variant.stock)}`}>{stockLabel(variant.stock)}</span></td>
                  <td>
                    <input
                      className="checkbox"
                      type="checkbox"
                      checked={variant.is_active}
                      onChange={(event) => updateRow(index, { is_active: event.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={variant.sort_order}
                      onChange={(event) => updateRow(index, { sort_order: Number(event.target.value) })}
                    />
                  </td>
                  <td><button className="dangerButton" type="button" onClick={() => removeRow(index)}>刪除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {variants.length === 0 && (
          <div className="emptyState">
            <p>這個商品還沒有規格。</p>
            <button type="button" onClick={addRow}>建立第一個重量規格</button>
          </div>
        )}

        {notice && <p className="noticeBox">{notice}</p>}
      </section>
      <Styles />
    </main>
  );
}

function Styles() {
  return (
    <style jsx global>{`
      .variantPage{min-height:100vh;padding:42px 5vw;background:#f3f7f6;color:#102a2e}
      .variantHeader{max-width:1400px;margin:0 auto 24px;display:flex;justify-content:space-between;gap:24px;align-items:flex-start}
      .variantHeader a{color:#0c6f6a;text-decoration:none;font-weight:800}
      .variantHeader h1{font-size:42px;margin:8px 0}
      .eyebrow{margin:18px 0 0;color:#0c6f6a;font-size:12px;font-weight:900;letter-spacing:.18em}
      .variantCard{max-width:1400px;margin:auto;padding:26px;background:#fff;border:1px solid #d7e3df;border-radius:22px;box-shadow:0 12px 35px rgba(18,55,58,.07)}
      .productPicker{max-width:420px;display:block;font-weight:800}
      .productPicker select{width:100%;margin-top:8px;padding:13px;border:1px solid #cad9d5;border-radius:12px;background:#fff}
      .toolbar{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}
      .toolbar button,.outlineButton,.primaryLink,.emptyState button{padding:11px 15px;border:1px solid #bfd4cf;border-radius:11px;background:#fff;color:#0c6f6a;font-weight:800;cursor:pointer;text-decoration:none}
      .toolbar .saveButton,.primaryLink,.emptyState button{background:#0c6f6a;color:#fff;border-color:#0c6f6a}
      .tableWrap{overflow-x:auto}
      table{width:100%;border-collapse:collapse;min-width:1120px}
      th,td{padding:11px 8px;text-align:left;border-bottom:1px solid #e3ebe8;vertical-align:middle}
      th{font-size:12px;letter-spacing:.04em;color:#5c716f}
      td input:not(.checkbox){width:100%;min-width:90px;padding:10px;border:1px solid #cedbd7;border-radius:9px}
      .checkbox{width:20px;height:20px}
      .muted{color:#667a78;font-size:13px}
      .stockBadge{display:inline-block;white-space:nowrap;padding:7px 10px;border-radius:999px;background:#e7f3ef;color:#0c6f6a;font-size:12px;font-weight:900}
      .stock-0{background:#f2e7e4;color:#9a4035}
      .stock-1,.stock-2,.stock-3,.stock-4{background:#fff1d8;color:#8b5a00}
      .dangerButton{padding:9px 11px;border:1px solid #e5c6c1;border-radius:9px;background:#fff;color:#a13e32;font-weight:800;cursor:pointer}
      .noticeBox{margin-top:18px;padding:14px;background:#e4f2ee;border-radius:12px;font-weight:700}
      .emptyState{text-align:center;padding:42px 20px;color:#607471}
      @media(max-width:720px){
        .variantPage{padding:24px 14px}
        .variantHeader{display:block}
        .variantHeader h1{font-size:32px}
        .outlineButton{margin-top:10px}
        .variantCard{padding:18px}
      }
    `}</style>
  );
}
