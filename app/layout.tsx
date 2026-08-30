import "./globals.css";
import "./liquid-glass-cart.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "漢久海鮮",
  description: "每日嚴選的新鮮海產，線上選購規格並預訂取貨。"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
