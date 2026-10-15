export const runtime = "nodejs";

/**
 * POST /api/conformidade/cofre/documentos/verificar — Diz quais destes arquivos
 * o cofre já tem, pelo SHA-256, ANTES de qualquer upload.
 *
 * A tela calcula o hash no navegador (crypto.subtle) e pergunta aqui: o usuário
 * vê o aviso e decide remover ou forçar, em vez de descobrir a duplicata depois
 * de subir 40 MB — sem esse passo, duplicata exata entra no cofre sem que
 * ninguém perceba.
 *
 * Body: { sha256: ["<64 hex minúsculos>", ...] } — de 1 a 50 por chamada.
 * Resposta: { existentes: { "<sha>": { id, restrito, titulo, criadoEm, operacaoCodigo } } }
 *   — SÓ os hashes encontrados; hash inédito simplesmente não aparece no mapa.
 *   `operacaoCodigo` é null quando o documento não está ligado a operação.
 *   Documento restrito visto por papel fora de Conformidade vem CEGO
 *   ({ id, restrito: true, titulo: null, criadoEm: null, operacaoCodigo: null }).
 *
 * Guard: requireAuth + podeGerenciarDocumentosHabilitacao — o MESMO do POST de
 * documento (quem pergunta é quem vai subir). 401 COM `code`; 403 SEM `code`.
 */

import { NextRequest, NextResponse } from "next/server";
import { podeGerenciarDocumentosHabilitacao, isConformidade } from "@/lib/permissions";
import { requireAuth, handleApiError } from "@/lib/api/guards";
import {
  VerificarHashesSchema,
  formatZodErrors,
} from "@/lib/conformidade/operacoes/validations";
import { getDocumentosPorSha256 } from "@/lib/conformidade/cofre/queries";

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = VerificarHashesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const rows = await getDocumentosPorSha256(parsed.data.sha256);

  // Uma entrada por hash. As linhas vêm da mais antiga para a mais nova, então
  // o primeiro que chega vence e as repetições do mesmo hash são ignoradas.
  //
  // 0034 (R5) — ocultação de restrito: a linha restrita NÃO é filtrada (o
  // uploader precisa saber que é duplicata, senão sobe de novo), mas para papel
  // fora de Conformidade a entrada vem CEGA — título/data/operação não vazam.
  // A ordem das chaves (id, restrito, titulo, criadoEm, operacaoCodigo) é a
  // MESMA nos dois ramos — contrato de paridade com o BFF.
  const existentes: Record<
    string,
    {
      id: string;
      restrito: boolean;
      titulo: string | null;
      criadoEm: Date | null;
      operacaoCodigo: string | null;
    }
  > = {};

  const cegar = (restrito: boolean) => restrito && !isConformidade(session.user.role);

  for (const row of rows) {
    if (row.sha256 === null || existentes[row.sha256]) continue;
    existentes[row.sha256] = cegar(row.restrito)
      ? {
          id:             row.id,
          restrito:       true,
          titulo:         null,
          criadoEm:       null,
          operacaoCodigo: null,
        }
      : {
          id:             row.id,
          restrito:       row.restrito,
          titulo:         row.titulo,
          criadoEm:       row.criadoEm,
          operacaoCodigo: row.operacaoCodigo,
        };
  }

  return NextResponse.json({ existentes });
}
