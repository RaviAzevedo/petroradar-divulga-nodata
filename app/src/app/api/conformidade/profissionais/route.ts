export const runtime = "nodejs";

/**
 * GET  /api/conformidade/profissionais — lista de profissionais (B2/D5) com as
 *      contagens de documentos e obras que cada um assina.
 * POST /api/conformidade/profissionais — cadastra um profissional.
 *
 * Query do GET (nenhum default que corte — Q10.3):
 *  - `busca?`:        nome ou CREA (LIKE com o termo escapado);
 *  - `ativo?`:        `"1"`/`"true"`/`"0"`/`"false"`, lido FORA do zod.
 *    ⚠️ AUSENTE = SEM FILTRO (ativos E inativos), nunca `true`: "histórico é
 *    parâmetro explícito, nunca default por papel";
 *  - `comDocumento?`: idem — estreita para quem assina ao menos um documento
 *    VISÍVEL para o papel (`false` não inverte o filtro, e por isso não ecoa);
 *  - `limit?` (1..200, default 50) e `offset?` (>= 0, default 0).
 *
 * Resposta do GET: `{ profissionais, total, filtros }` — `filtros` ecoa só o
 * que foi REALMENTE aplicado, e `total` usa o MESMO predicado das linhas.
 *
 * Body do POST: `{ nome, crea?, creaUf?, formacao? }`.
 * ⚠️ NÃO existe `cpf` — nem coluna, nem campo, nem texto livre (§1d / LGPD):
 * `lib/seguranca/pii.ts` redige CPF antes de gravar, e guardar aqui
 * contradiria a política do próprio módulo. O `z.object()` faz strip de um
 * `cpf` que venha no body.
 *
 * Guards: GET  = `requireConformidade` (403 COM `code`) — spec §1j: nome,
 *         CREA e formação de pessoas não ficam atrás do piso mais baixo;
 *         POST = `requireAuth` + `podeGerenciarDocumentosHabilitacao`
 *         (403 SEM `code`), o mesmo par do POST de medida da onda 1.
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { profissionais, auditLog } from "@/db/schema";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireConformidade, handleApiError } from "@/lib/api/guards";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import {
  CriarProfissionalSchema,
  FiltrosProfissionalSchema,
} from "@/lib/conformidade/profissionais/validations";
import {
  getProfissionalPorCrea,
  listProfissionais,
} from "@/lib/conformidade/profissionais/queries";

/**
 * Flag booleana de três estados, lida fora do zod (padrão do `semOperacao` do
 * cofre, estendido): `"1"`/`"true"` ligam, `"0"`/`"false"` desligam e qualquer
 * outra coisa — inclusive o parâmetro ausente — é `undefined`, isto é, SEM
 * FILTRO. É a diferença entre "só ativos" e "todos", e ela é explícita.
 */
function flagTresEstados(valor: string | null): boolean | undefined {
  if (valor === "1" || valor === "true")  return true;
  if (valor === "0" || valor === "false") return false;
  return undefined;
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  let user: Awaited<ReturnType<typeof requireConformidade>>["user"];
  try {
    ({ user } = await requireConformidade());
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  const parsed = FiltrosProfissionalSchema.safeParse({
    busca:        searchParams.get("busca")  ?? undefined,
    ativo:        flagTresEstados(searchParams.get("ativo")),
    comDocumento: flagTresEstados(searchParams.get("comDocumento")),
    limit:        searchParams.get("limit")  ?? undefined,
    offset:       searchParams.get("offset") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  // O papel entra na query: documento restrito é filtrado das CONTAGENS
  // também (não só das linhas) — senão `totalDocumentos` denunciaria o que a
  // lista esconde (ADR-05).
  const resultado = await listProfissionais(parsed.data, user.role);
  return NextResponse.json(resultado);
}

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

  const parsed = CriarProfissionalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  // CREA duplicado vira 422 NO CAMPO, antes do INSERT: `uniq_profissional_crea`
  // é índice único parcial e o 23505 dele chegaria como 500, sem dizer o que
  // fazer. Só confere quando `crea` veio — N profissionais sem registro
  // convivem (o índice é `WHERE crea IS NOT NULL`).
  if (data.crea) {
    const existente = await getProfissionalPorCrea(data.crea);
    if (existente) {
      return NextResponse.json(
        { error: "Dados inválidos", detalhes: { crea: "Já existe profissional com este CREA" } },
        { status: 422 }
      );
    }
  }

  const [novo] = await db
    .insert(profissionais)
    .values({
      nome:     data.nome,
      crea:     data.crea     ?? null,
      creaUf:   data.creaUf   ?? null,
      formacao: data.formacao ?? null,
    })
    .returning();

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "CRIAR_PROFISSIONAL",
    entidade:   "profissional",
    entidadeId: novo.id,
    detalhes:   { nome: novo.nome, crea: novo.crea, creaUf: novo.creaUf },
  });

  return NextResponse.json(novo, { status: 201 });
}
