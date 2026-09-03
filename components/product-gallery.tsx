"use client";
import { useRef, useState } from "react";
import type { ProductImage } from "@/lib/catalog";
import { imageSource, stableOrder } from "@/lib/catalog-content";

export default function ProductGallery({ images, fallback, name }: { images: ProductImage[]; fallback: string | null; name: string }) {
  const track = useRef<HTMLDivElement>(null);
  const ordered = stableOrder(images);
  const primary = ordered.find((image) => image.is_primary);
  const slides = (primary ? [primary, ...ordered.filter((image) => image.id !== primary.id)] : ordered)
    .map((image) => ({ id: image.id, src: imageSource(image, process.env.NEXT_PUBLIC_SUPABASE_URL || ""), alt: image.alt_text || name }));
  if (!slides.length && fallback) slides.push({ id: "legacy", src: fallback, alt: name });
  const [selected, setSelected] = useState(0);
  if (!slides.length) return <div className="catalogPlaceholder" role="img" aria-label="尚無商品圖片">🐟</div>;
  return <section className="catalogGallery" aria-label={`${name}商品圖片`}>
    <div className="catalogGalleryTrack" ref={track} tabIndex={0} onScroll={() => {
      const node = track.current; if (node) setSelected(Math.round(node.scrollLeft / (node.clientWidth || 1)));
    }}>{slides.map((slide) => <img key={slide.id} src={slide.src} alt={slide.alt} width={1600} height={1200} />)}</div>
    {slides.length > 1 && <div className="catalogThumbnails">{slides.map((slide, index) => <button key={slide.id} type="button" aria-label={`查看第 ${index + 1} 張圖片`} aria-pressed={selected === index} onClick={() => track.current?.scrollTo({ left: index * track.current.clientWidth, behavior: "smooth" })}><img src={slide.src} alt="" loading="lazy" /></button>)}</div>}
  </section>;
}
