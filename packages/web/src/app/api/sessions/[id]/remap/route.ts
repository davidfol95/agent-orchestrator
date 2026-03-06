import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    const opencodeSessionId = await sessionManager.remap(id, true);
    return NextResponse.json({ ok: true, sessionId: id, opencodeSessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to remap session";
    if (msg.includes("not found")) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.includes("not using the opencode agent") || msg.includes("mapping is missing")) {
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
