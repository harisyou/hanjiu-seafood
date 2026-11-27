import { NextRequest, NextResponse } from "next/server";
import { maintenanceConfig, maintenanceHtml } from "@/lib/maintenance.mjs";

const PASS_THROUGH_PATHS = new Set(["/api/healthz", "/favicon.ico", "/robots.txt"]);

export function middleware(request: NextRequest) {
  const config = maintenanceConfig(process.env);
  if (!config.active || PASS_THROUGH_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  return new NextResponse(maintenanceHtml(config), {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Retry-After": String(config.retryAfterSeconds),
      "Cache-Control": "no-store, max-age=0, must-revalidate",
      "Pragma": "no-cache",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"]
};
