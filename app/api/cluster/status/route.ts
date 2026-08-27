import { NextResponse } from "next/server";
import { getClusterStatus } from "@/engine/cluster/spark-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const cluster = await getClusterStatus();
  return NextResponse.json({ ok: true, cluster });
}
