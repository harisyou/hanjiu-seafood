import { createClient } from "@supabase/supabase-js";

// Never reads cookies or an admin browser session. Public pages always use anon RLS.
export function createPublicClient(allowBuildPlaceholder = false) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if ((!url || !key) && allowBuildPlaceholder && typeof window === "undefined") {
    return createClient("http://127.0.0.1:54321", "build-placeholder", { auth: { persistSession: false } });
  }
  if (!url || !key) throw new Error("尚未設定 Supabase 環境變數。");
  return createClient(url, key, { auth: { storageKey: "hanjiu-public-anonymous", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) } });
}
