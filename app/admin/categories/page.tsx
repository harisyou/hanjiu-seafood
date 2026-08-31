"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Product, ProductCategoryRecord } from "@/lib/catalog";
import { createClient } from "@/lib/supabase-browser";

type CategoryDraft = { name: string; sort_order: number; active: boolean };

const emptyDraft: CategoryDraft = { name: "", sort_order: 100, active: true };

function categoryErrorMessage(message: string) {
  if (message.includes("category_in_use")) return "此類別仍有商品使用中，請先將商品移至其他類別後再刪除。";
  if (message.includes("duplicate_category_name")) return "已有相同名稱的商品類別。";
  if (message.includes("invalid_category_name")) return "請輸入 100 字以內的類別名稱。";
  if (message.includes("invalid_category_sort_order")) return "排序必須是 0 到 1,000,000 之間的整數。";
  if (message.includes("admin_required")) return "沒有管理員權限。";
  return `類別操作失敗：${message}`;
}

export default function ProductCategoriesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState("");
  const [categories, setCategories] = useState<ProductCategoryRecord[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [draft, setDraft] = useState<CategoryDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [categoryResult, productResult] = await Promise.all([
      supabase.from("product_categories").select("*").order("sort_order").order("name"),
      supabase.from("products").select("id,category_id")
    ]);
    if (categoryResult.error) setNotice(`類別載入失敗：${categoryResult.error.message}`);
    else setCategories((categoryResult.data || []) as ProductCategoryRecord[]);
    if (productResult.error) setNotice(`商品載入失敗：${productResult.error.message}`);
    else setProducts((productResult.data || []) as Product[]);
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || "");
      if (data.session) load();
    });
  }, [load, supabase]);

  const productCount = (categoryId: string) => products.filter((product) => product.category_id === categoryId).length;

  function resetForm() {
    setDraft(emptyDraft);
    setEditingId(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return setNotice("請輸入類別名稱。");
    if (!Number.isInteger(draft.sort_order) || draft.sort_order < 0) return setNotice("排序必須是大於或等於 0 的整數。");
    setBusy(true);
    setNotice("");
    const args = editingId
      ? { p_category_id: editingId, p_name: name, p_active: draft.active, p_sort_order: draft.sort_order }
      : { p_name: name, p_sort_order: draft.sort_order };
    const rpcName = editingId ? "admin_update_product_category" : "admin_create_product_category";
    const { error } = await supabase.rpc(rpcName, args);
    if (error) setNotice(categoryErrorMessage(error.message));
    else {
      setNotice(editingId ? "類別已更新。" : "類別已新增。 ");
      resetForm();
      await load();
    }
    setBusy(false);
  }

  function edit(category: ProductCategoryRecord) {
    setEditingId(category.id);
    setDraft({ name: category.name, sort_order: category.sort_order, active: category.active });
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(category: ProductCategoryRecord) {
    const count = productCount(category.id);
    if (count > 0) return setNotice(`此類別目前有 ${count} 個商品使用中，請先將商品移至其他類別後再刪除。`);
    if (!window.confirm(`確定要刪除「${category.name}」嗎？`)) return;
    setBusy(true);
    setNotice("");
    const { error } = await supabase.rpc("admin_delete_product_category", { p_category_id: category.id });
    if (error) setNotice(categoryErrorMessage(error.message));
    else {
      setNotice("類別已刪除。");
      if (editingId === category.id) resetForm();
      await load();
    }
    setBusy(false);
  }

  if (!user) return <main className="admin"><section className="login"><h1>後台登入</h1><p>請先從商品後台登入後再管理商品類別。</p><Link className="buttonLink" href="/admin">前往後台登入</Link></section></main>;

  return (
    <main className="admin">
      <header className="adminTop"><div><Link href="/admin">← 返回商品後台</Link><h1>商品類別管理</h1><p>{user}</p></div><button onClick={() => supabase.auth.signOut().then(() => setUser(""))}>登出</button></header>
      <section className="adminGrid categoryManagementGrid">
        <form className="panel categoryEditor" onSubmit={save}>
          <h2>{editingId ? "編輯類別" : "＋新增類別"}</h2>
          <label>類別名稱<input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：火鍋料" /></label>
          <label>前台排序<input type="number" min="0" step="1" value={draft.sort_order} onChange={(event) => setDraft({ ...draft, sort_order: Number(event.target.value) })} /></label>
          {editingId && <label className="check"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />在前台顯示此類別</label>}
          <button disabled={busy}>{busy ? "儲存中…" : editingId ? "儲存類別" : "新增類別"}</button>
          {editingId && <button type="button" className="cancelEditButton" onClick={resetForm}>取消編輯</button>}
          {notice && <p className="notice" role="status">{notice}</p>}
        </form>
        <section className="panel categoryListPanel">
          <h2>類別清單</h2>
          <p className="categoryListHint">啟用中的類別會依排序顯示在前台商品篩選。已有商品使用的類別無法刪除。</p>
          <div className="categoryTable" role="table" aria-label="商品類別">
            <div className="categoryTableHeader" role="row"><span>類別名稱</span><span>商品數量</span><span>狀態</span><span>操作</span></div>
            {categories.map((category) => {
              const count = productCount(category.id);
              return <div className="categoryTableRow" role="row" key={category.id}>
                <strong>{category.name}<small>排序 {category.sort_order}</small></strong>
                <span>{count} 個商品</span>
                <span className={category.active ? "categoryActive" : "categoryInactive"}>{category.active ? "啟用" : "已隱藏"}</span>
                <span className="categoryActions"><button type="button" onClick={() => edit(category)} disabled={busy}>編輯</button><button type="button" className="categoryDeleteButton" onClick={() => remove(category)} disabled={busy}>刪除</button></span>
              </div>;
            })}
          </div>
        </section>
      </section>
    </main>
  );
}
