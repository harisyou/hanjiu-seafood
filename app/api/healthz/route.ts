import { NextResponse } from "next/server";
import { maintenanceConfig } from "@/lib/maintenance.mjs";

export const dynamic = "force-dynamic";

export function GET() {
  const maintenance = maintenanceConfig(process.env);
  return NextResponse.json(
    { status: "ok", maintenance: maintenance.active, revision: process.env.VERCEL_GIT_COMMIT_SHA || null },
    { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } }
  );
}
