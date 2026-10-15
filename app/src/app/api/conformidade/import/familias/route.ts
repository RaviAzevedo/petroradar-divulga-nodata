export const runtime = "nodejs";

/**
 * POST /api/conformidade/import/familias       — preview (dry-run): retorna diff
 * POST /api/conformidade/import/familias?aplicar=1 — commit: aplica o diff
 *
 * Body (multipart/form-data):
 *   - file: XLSX da planilha mestre
 *
 * Auth: sessão NextAuth com role ADMIN/LIDER/SGI
 *       OU header Authorization: Bearer <import-token>
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { podeImportarConformidade } from "@/lib/permissions";
import { verificarImportToken } from "@/lib/conformidade/import-tokens";
import {
  parsePlanilhaFamilias,
  gerarDiffFamilias,
  aplicarDiffFamilias,
} from "@/lib/conformidade/import-familias";
import { validarMagicBytes } from "@/lib/storage/upload";

const EXTENSOES_PLANILHA = [".xlsx", ".xls"] as const;

interface AuthInfo { userId: string; role: string; }

async function autenticar(request: NextRequest): Promise<AuthInfo | { erro: string; status: number }> {
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = await verificarImportToken(token);
    if (!payload) return { erro: "Token de importação inválido ou expirado", status: 401 };
    if (!podeImportarConformidade(payload.role)) {
      return { erro: "Token sem permissão de importação", status: 403 };
    }
    return { userId: payload.sub, role: payload.role };
  }

  const session = await auth();
  if (!session?.user) return { erro: "Não autenticado", status: 401 };
  if (!podeImportarConformidade(session.user.role)) return { erro: "Permissão negada", status: 403 };
  return { userId: session.user.id, role: session.user.role };
}

export async function POST(request: NextRequest) {
  const a = await autenticar(request);
  if ("erro" in a) return NextResponse.json({ error: a.erro }, { status: a.status });

  const aplicar = new URL(request.url).searchParams.get("aplicar") === "1";

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Esperado multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Arquivo XLSX é obrigatório" }, { status: 422 });
  }

  // Whitelist de extensão (planilha)
  const extensao = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
  if (!(EXTENSOES_PLANILHA as readonly string[]).includes(extensao)) {
    return NextResponse.json(
      { error: "Tipo de arquivo não permitido. Use XLSX ou XLS." },
      { status: 422 },
    );
  }

  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "Planilha muito grande (máx 10MB)" }, { status: 422 });
  }

  // Verifica conteúdo binário real (magic-bytes) — impede que um PDF/EXE
  // renomeado pra .xlsx chegue ao parser.
  const magic = await validarMagicBytes(file);
  if (!magic.valido) {
    return NextResponse.json(
      { error: magic.erro ?? "Conteúdo do arquivo não corresponde ao tipo declarado" },
      { status: 422 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let parsed;
  try {
    parsed = await parsePlanilhaFamilias(buffer);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Falha ao processar planilha" },
      { status: 422 },
    );
  }

  const diff = await gerarDiffFamilias(parsed.linhas, parsed.erros);

  if (!aplicar) {
    // Preview: retorna diff resumido (sem expor objetos completos do banco)
    return NextResponse.json({
      modo: "preview",
      resumo: {
        novas:        diff.novas.length,
        atualizadas:  diff.atualizadas.length,
        inalteradas:  diff.inalteradas,
        erros:        diff.erros.length,
      },
      novas: diff.novas.map((l) => ({
        linhaPlanilha: l.linhaPlanilha,
        codigoCrc:     l.codigoCrc,
        nome:          l.nome,
        segmento:      l.segmentoPetrobras,
        statusFluxo:   l.statusFluxoCrc,
        validadeFim:   l.validadeFim?.toISOString() ?? null,
      })),
      atualizadas: diff.atualizadas.map((u) => ({
        linhaPlanilha: u.linha.linhaPlanilha,
        codigoCrc:     u.linha.codigoCrc,
        nome:          u.linha.nome,
        mudancas:      u.mudancas,
      })),
      erros: diff.erros,
    });
  }

  // Commit
  const resultado = await aplicarDiffFamilias(diff, a.userId);
  return NextResponse.json({ modo: "commit", ...resultado });
}
