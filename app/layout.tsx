import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "韓九嚴選生鮮",
  description: "南方澳現流海鮮，每日新鮮到貨。"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
