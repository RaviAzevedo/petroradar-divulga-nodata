import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { perfisInteresse } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireGestao, handleApiError } from "@/lib/api/guards";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireGestao();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  const body = await request.json();

  const [updated] = await db.update(perfisInteresse)
    .set({ ...body, atualizadoEm: new Date() })
    .where(eq(perfisInteresse.id, id))
    .returning();

  if (!updated) return NextResponse.json({ error: { message: "Perfil não encontrado" } }, { status: 404 });
  return NextResponse.json({ data: updated });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireGestao();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  await db.delete(perfisInteresse).where(eq(perfisInteresse.id, id));
  return new NextResponse(null, { status: 204 });
}
