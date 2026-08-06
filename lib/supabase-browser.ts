import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if ((!url || !key) && typeof window === "undefined") {
    return createBrowserClient("http://127.0.0.1:54321", "build-placeholder");
  }
  if (!url || !key) throw new Error("尚未設定 Supabase 環境變數。");
  return createBrowserClient(url, key);
}
