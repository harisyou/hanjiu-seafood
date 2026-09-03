import Link from "next/link";
import { notFound } from "next/navigation";
import { createPublicClient } from "@/lib/supabase-public";
import { visibleFaqs } from "@/lib/catalog-content";
import type { Product, ProductFaq, ProductImage } from "@/lib/catalog";
import ProductGallery from "@/components/product-gallery";

export const dynamic = "force-dynamic";
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const db = createPublicClient();
  const result = await db.from("products").select("*").eq("id", id).neq("status", "hidden").maybeSingle();
  if (result.error) throw new Error("商品資料暫時無法載入");
  if (!result.data) notFound();
  const product = result.data as Product;
  const [images, faqs, categories, options, presets] = await Promise.all([
    db.from("product_images").select("*").eq("product_id", id).order("sort_order").order("id"),
    db.from("product_faqs").select("*").eq("product_id", id).eq("active", true).order("sort_order").order("id"),
    db.from("product_categories").select("id,name").eq("id", product.category_id || "").maybeSingle(),
    db.from("product_processing_options").select("processing_options!inner(name,active)").eq("product_id", id).eq("active", true).eq("processing_options.active", true),
    db.from("product_processing_presets").select("processing_presets!inner(name,active)").eq("product_id", id).eq("active", true).eq("processing_presets.active", true)
  ]);
  if (images.error || faqs.error || categories.error || options.error || presets.error) throw new Error("商品內容暫時無法載入");
  const questions = visibleFaqs((faqs.data || []) as ProductFaq[]);
  const processingNames = [...new Set([...options.data || [], ...presets.data || []].flatMap((row) => {
    const value = "processing_options" in row ? row.processing_options : row.processing_presets;
    return (Array.isArray(value) ? value : [value]).map((entry) => entry.name);
  }))];
  return <article className="content catalogDetail">
    <Link href="/">← 返回商品目錄</Link>
    <div className="catalogDetailGrid"><ProductGallery images={(images.data || []) as ProductImage[]} fallback={product.image_url} name={product.name} />
      <div><small>{categories.data?.name}</small><h1>{product.name}</h1>
        {[["商品介紹", product.description], ["肉質／口感", product.texture_description], ["推薦料理", product.cooking], ["保存方式", product.storage_instructions]].map(([title, value]) => value ? <section className="catalogCopy" key={title}><h2>{title}</h2><p>{value}</p></section> : null)}
        {product.processing_enabled && processingNames.length > 0 && <section><h2>可選處理方式</h2><p>{processingNames.join("、")}（處理費 NT$0）</p></section>}
        <p className="weightBasisNotice">※ 商品重量皆為處理前重量，處理後重量會依處理方式有所減少。</p>
        {product.status === "sold_out" && <p role="status">目前暫停購買，商品資訊仍可瀏覽。</p>}
      </div></div>
    {questions.length > 0 && <section className="catalogFaq"><h2>商品常見問題</h2>{questions.map((faq) => <details key={faq.id}><summary>{faq.question}</summary><p>{faq.answer}</p></details>)}</section>}
  </article>;
}
