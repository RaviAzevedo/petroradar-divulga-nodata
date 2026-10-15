import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { perfisInteresse } from "@/db/schema";
import { desc } from "drizzle-orm";
import { requireAuth, requireGestao, handleApiError } from "@/lib/api/guards";

export async function GET() {
  try {
    await requireAuth();
  } catch (e) {
    return handleApiError(e);
  }

  const perfis = await db.select().from(perfisInteresse).orderBy(desc(perfisInteresse.criadoEm));
  return NextResponse.json({ data: perfis });
}

export async function POST(request: NextRequest) {
  try {
    await requireGestao();
  } catch (e) {
    return handleApiError(e);
  }

  const body = await request.json();
  const { nome, descricao, filtros } = body;

  if (!nome || !filtros) {
    return NextResponse.json({ error: { message: "Nome e filtros são obrigatórios" } }, { status: 400 });
  }

  const [created] = await db.insert(perfisInteresse).values({
    nome,
    descricao: descricao || "",
    ativo: true,
    filtros,
  }).returning();

  return NextResponse.json({ data: created }, { status: 201 });
}
