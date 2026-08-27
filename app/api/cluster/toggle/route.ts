import { NextResponse } from "next/server";
import { toggleComfyService } from "@/engine/cluster/spark-client";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { action = "on" } = await req.json();
  const ok = await toggleComfyService(action === "on" ? "on" : "off");
  return NextResponse.json({ ok, action });
}
