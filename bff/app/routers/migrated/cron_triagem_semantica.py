"""Rota migrada (strangler-fig): GET /api/cron/triagem-semantica.

Equivalente 1:1 de ``src/app/api/cron/triagem-semantica/route.ts`` (handler GET).

Cron leve de pré-classificação de relevância do feed Petronect. Para cada
licitação ainda não classificada por IA (``classificado_ia_em IS NULL``), monta
objeto + objetoResumido + itens (família/descrição) e envia ao Claude Haiku
(prompt caching no bloco estático de escopos/famílias Proponente). A resposta
``{score, segmento, aderencia, justificativa, perfil_sugerido}`` é validada
(Zod no Next → Pydantic/validação manual aqui) e gravada em:
  - ``licitacoes.classificacao_ia``  (jsonb)
  - ``licitacoes.classificado_ia_em`` (timestamptz)

O feed pode então ranquear por score. Notificação de score alto é
responsabilidade do cron oportunidades-novas (não duplicamos disparo aqui).

────────────────────────────────────────────────────────────────────────────
Auth (réplica EXATA de ``autorizarCron`` do route.ts):
  - Se ``CRON_SECRET`` (settings.cron_secret) estiver definido (truthy):
    exige header ``Authorization: Bearer <CRON_SECRET>`` — qualquer outro → 401
    ``{"error": "Não autorizado"}``.
  - Se ``CRON_SECRET`` NÃO estiver definido: aceita ``x-vercel-cron: 1`` —
    qualquer outro → 401 ``{"error": "Não autorizado"}``.
  (Não há disparo manual por ADMIN logado neste cron — o Next só checa o cron.)

Gate gracioso (idêntico ao Next):
  - desabilitado por config → 200 ``{ok:true, skipped:"desabilitado"}``
  - IA bloqueada/sem chave  → 200 ``{ok:true, skipped:"IA bloqueada (ver
    bff/app/services/anthropic.py)"}``. A triagem semântica está FORA da allowlist
    da trava de IA (só a análise de edital consome a API da Anthropic), então HOJE
    este cron sempre pula por aqui — verde, sem gastar token.

Operações no banco (réplica do Drizzle):
  1. SELECT id/numero/objeto/objeto_resumido FROM licitacoes
     WHERE classificado_ia_em IS NULL ORDER BY criado_em DESC LIMIT <lote>.
  2. SELECT licitacao_id/descricao/familia/familia_descricao FROM itens
     WHERE licitacao_id IN (...). Limita a 40 itens por licitação (em memória).
  3. Para cada candidata: classifica via Haiku (tool-use forçado) e acumula um
     UPDATE licitacoes SET classificacao_ia, classificado_ia_em=now(),
     atualizado_em=now() WHERE id = ...
  4. Persiste todos os UPDATEs (o Next usa db.batch; aqui um commit único da
     sessão do request engloba tudo — mesmo efeito).

Shape da resposta (200, idêntico ao Next):
  {"ok": true, "stats": {candidatas, classificadas, altoInteresse, errosParse,
   falhas, tokensInput, tokensOutput}}
  ou {"ok": true, "stats": {...}} quando não há pendentes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import bindparam, text

from app.core.config import settings
from app.core.cron_auth import safe_equal
from app.core.ia_budget import budget_excedido, registrar_tokens
from app.core.observability import record_anthropic_usage
from app.db.session import SessionLocal
from app.routers.migrated._shared import flag, num
from app.services import anthropic as anthropic_svc

router = APIRouter()


# ── Config dos crons (réplica de src/lib/config.ts → config.crons.triagemSemantica)
#
# O ``config.ts`` lê variáveis de ambiente com fallbacks via helpers ``flag``/
# ``num``. Aqui os valores CRUS vêm do ``settings`` (campos str espelhos de
# process.env — D5a) e são interpretados pelos helpers paritários de
# ``_shared`` — MESMOS defaults e semântica de habilitação/limiares do Next.


def _cron_habilitado() -> bool:
    """config.crons.triagemSemantica.habilitado (default true)."""
    return flag(settings.cron_triagem_enabled, True)


def _cron_lote() -> int:
    """config.crons.triagemSemantica.lotePorExecucao (default 40)."""
    return num(settings.cron_triagem_lote, 40)


def _cron_max_chars() -> int:
    """config.crons.triagemSemantica.maxCharsEntrada (default 12_000)."""
    return num(settings.cron_triagem_max_chars, 12_000)


def _cron_score_alto() -> int:
    """config.crons.triagemSemantica.scoreAltoInteresse (default 70)."""
    return num(settings.cron_triagem_score_alto, 70)


# ── Triagem semântica (porta de src/lib/licitacoes/triagem-semantica.ts) ───────

#: Versão do schema de triagem — bump quando o contrato mudar.
TRIAGEM_SCHEMA_VERSAO = 1

#: Nome do tool forçado (function calling).
TOOL_TRIAGEM_NOME = "registrar_triagem"

# Bloco estático (cacheável) — escopos e famílias-alvo Proponente.
INSTRUCAO_SISTEMA = f"""Você é um analista de inteligência comercial da empresa proponente, especializada no setor de óleo & gás no Brasil, atuando no fluxo Petrobras/Petronect.

A Proponente presta principalmente:
- Engenharia de processo, básica e de detalhamento (refino, processamento, dutos, plantas de processo).
- Manutenção industrial, montagem eletromecânica, inspeção e integridade de equipamentos.
- Serviços de SMS (segurança, meio ambiente e saúde) e consultoria técnica de engenharia.
- Fornecimento de mão de obra técnica especializada de engenharia.

Famílias/segmentos de ALTO interesse: refino, paradas de manutenção, engenharia de detalhamento,
inspeção e integridade, tubulação/caldeiraria, instrumentação e automação, elétrica industrial.
Famílias de BAIXO/NENHUM interesse: fornecimento puro de commodities/materiais sem engenharia,
TI, serviços administrativos, alimentação, locação de veículos, obras civis genéricas sem disciplina de processo.

Sua tarefa é, dado o objeto de uma licitação e seus itens, pré-classificar a relevância para a Proponente,
SEMPRE chamando a ferramenta "{TOOL_TRIAGEM_NOME}".

Regras:
- "score": 0 a 100. Use >= 70 só quando houver clara aderência ao core de engenharia O&G da Proponente.
- "segmento": rótulo curto do segmento detectado (ex.: "Refino", "Manutenção Industrial", "Engenharia de Detalhamento", "Fora do escopo").
- "aderencia": ALTA | MEDIA | BAIXA — aderência ao portfólio Proponente.
- "justificativa": 1-2 frases objetivas explicando o score (cite o que pesou).
- "perfil_sugerido": rótulo curto do perfil de interesse mais provável, ou "Nenhum" se fora de escopo.
- Não invente itens nem escopo: classifique apenas com base no texto fornecido."""


def _build_tool_input_schema() -> dict[str, Any]:
    """Réplica de ``buildToolInputSchema`` (triagem-semantica.ts)."""
    return {
        "type": "object",
        "properties": {
            "score": {
                "type": "number",
                "description": "Aderência ao portfólio Proponente, de 0 a 100.",
            },
            "segmento": {
                "type": "string",
                "description": "Rótulo curto do segmento detectado.",
            },
            "aderencia": {
                "type": "string",
                "enum": ["ALTA", "MEDIA", "BAIXA"],
                "description": "Nível de aderência ao portfólio Proponente.",
            },
            "justificativa": {
                "type": "string",
                "description": "1-2 frases objetivas explicando o score.",
            },
            "perfil_sugerido": {
                "type": "string",
                "description": "Perfil de interesse mais provável, ou 'Nenhum' se fora de escopo.",
            },
        },
        "required": [
            "score",
            "segmento",
            "aderencia",
            "justificativa",
            "perfil_sugerido",
        ],
    }


def _validar_triagem(input_: Any) -> dict[str, Any]:
    """Réplica de ``validarTriagem`` (Zod ``triagemSchema.safeParse``).

    Valida o input do tool; em caso de falha devolve fallback neutro com
    ``ok=False`` e a mensagem de erro (truncada a 400 chars como no Next).

    Regras do ``triagemSchema``:
      - score:           number, 0..100
      - segmento:        string, 1..120 chars
      - aderencia:       enum ALTA|MEDIA|BAIXA
      - justificativa:   string, 1..600 chars
      - perfil_sugerido: string, 1..120 chars
    """
    fallback = {
        "score": 0,
        "segmento": "Indeterminado",
        "aderencia": "BAIXA",
        "justificativa": "Falha ao validar a resposta da triagem (erro de parse).",
        "perfil_sugerido": "Nenhum",
    }

    if not isinstance(input_, dict):
        return {"ok": False, "data": fallback, "erro": "Invalid input"[:400]}

    erros: list[str] = []

    score = input_.get("score")
    if not isinstance(score, (int, float)) or isinstance(score, bool):
        erros.append("score: expected number")
    elif score < 0 or score > 100:
        erros.append("score: out of range")

    segmento = input_.get("segmento")
    if not isinstance(segmento, str):
        erros.append("segmento: expected string")
    elif len(segmento) < 1 or len(segmento) > 120:
        erros.append("segmento: invalid length")

    aderencia = input_.get("aderencia")
    if aderencia not in ("ALTA", "MEDIA", "BAIXA"):
        erros.append("aderencia: invalid enum value")

    justificativa = input_.get("justificativa")
    if not isinstance(justificativa, str):
        erros.append("justificativa: expected string")
    elif len(justificativa) < 1 or len(justificativa) > 600:
        erros.append("justificativa: invalid length")

    perfil_sugerido = input_.get("perfil_sugerido")
    if not isinstance(perfil_sugerido, str):
        erros.append("perfil_sugerido: expected string")
    elif len(perfil_sugerido) < 1 or len(perfil_sugerido) > 120:
        erros.append("perfil_sugerido: invalid length")

    if not erros:
        return {
            "ok": True,
            "data": {
                "score": score,
                "segmento": segmento,
                "aderencia": aderencia,
                "justificativa": justificativa,
                "perfil_sugerido": perfil_sugerido,
            },
        }

    return {"ok": False, "data": fallback, "erro": "; ".join(erros)[:400]}


def _montar_texto_licitacao(lic: dict[str, Any], max_chars: int) -> str:
    """Réplica de ``montarTextoLicitacao`` (triagem-semantica.ts).

    ``lic`` traz: numero, objeto, objetoResumido, itens (lista de dicts com
    descricao/familia/familiaDescricao).
    """
    partes: list[str] = []
    objeto_resumido = lic.get("objetoResumido")
    objeto = lic.get("objeto")

    if objeto_resumido:
        partes.append(f"Objeto resumido: {objeto_resumido}")
    if objeto and objeto != objeto_resumido:
        partes.append(f"Objeto: {objeto}")

    itens_lic: list[dict[str, Any]] = lic.get("itens") or []
    if len(itens_lic) > 0:
        linhas: list[str] = []
        for it in itens_lic:
            fam = " - ".join(
                p for p in (it.get("familia"), it.get("familiaDescricao")) if p
            )
            desc = it.get("descricao") if it.get("descricao") is not None else ""
            linha = f"• {': '.join(p for p in (fam, desc) if p)}".strip()
            linhas.append(linha)
        linhas = [l for l in linhas if len(l) > 2]
        if len(linhas) > 0:
            partes.append("Itens:\n" + "\n".join(linhas))

    txt = "\n\n".join(partes).strip()
    return txt[:max_chars] if len(txt) > max_chars else txt


async def _classificar_licitacao(lic: dict[str, Any]) -> dict[str, Any]:
    """Réplica de ``classificarLicitacao`` (triagem-semantica.ts).

    Classifica UMA licitação via Haiku (tool-use + validação). Não escreve no
    banco — o cron persiste o resultado. Retorna dict com todos os campos de
    ``TriagemResultado``: score, segmento, aderencia, justificativa,
    perfil_sugerido, modelo, schemaVersao, erroParse, erroDetalhe, tokensInput,
    tokensOutput, tempoMs, classificadoEm.

    TRAVA DE IA: "triagem-semantica" está BLOQUEADO, então get_client() LANÇA aqui —
    igual ao triagem-semantica.ts do Next. O handler do cron faz o gate gracioso com
    ia_permitida() antes e nunca chega a chamar esta função.
    """
    client = anthropic_svc.get_client("triagem-semantica")
    modelo = settings.anthropic_model_haiku
    max_chars = _cron_max_chars()

    texto = _montar_texto_licitacao(lic, max_chars)

    tool = {
        "name": TOOL_TRIAGEM_NOME,
        "description": (
            "Registra a pré-triagem semântica de uma licitação (score de "
            "aderência, segmento, aderência, justificativa e perfil sugerido)."
        ),
        "input_schema": _build_tool_input_schema(),
    }

    start = datetime.now(tz=timezone.utc)

    message = await client.messages.create(
        model=modelo,
        max_tokens=512,
        # Bloco estático (escopos/famílias Proponente) cacheável; só o objeto+itens muda.
        system=[
            {
                "type": "text",
                "text": INSTRUCAO_SISTEMA,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        tools=[tool],
        tool_choice={"type": "tool", "name": TOOL_TRIAGEM_NOME},
        messages=[
            {
                "role": "user",
                "content": (
                    f"Licitação {lic.get('numero')}. Pré-classifique a aderência "
                    "ao portfólio da Proponente chamando a ferramenta.\n\n"
                    "--- DADOS DA LICITAÇÃO ---\n"
                    f"{texto or '(sem objeto/itens informados)'}"
                ),
            }
        ],
    )

    elapsed = int((datetime.now(tz=timezone.utc) - start).total_seconds() * 1000)

    tool_use = next(
        (
            b
            for b in message.content
            if getattr(b, "type", None) == "tool_use"
        ),
        None,
    )

    classificado_em = datetime.now(tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%f"
    )[:-3] + "Z"

    if tool_use is None:
        validado = _validar_triagem({})
        data = validado["data"]
        return {
            **data,
            "modelo": modelo,
            "schemaVersao": TRIAGEM_SCHEMA_VERSAO,
            "erroParse": True,
            "erroDetalhe": "Modelo não retornou bloco tool_use",
            "tokensInput": message.usage.input_tokens,
            "tokensOutput": message.usage.output_tokens,
            "tempoMs": elapsed,
            "classificadoEm": classificado_em,
        }

    validado = _validar_triagem(getattr(tool_use, "input", None))

    return {
        **validado["data"],
        "modelo": modelo,
        "schemaVersao": TRIAGEM_SCHEMA_VERSAO,
        "erroParse": not validado["ok"],
        "erroDetalhe": validado.get("erro"),
        "tokensInput": message.usage.input_tokens,
        "tokensOutput": message.usage.output_tokens,
        "tempoMs": elapsed,
        "classificadoEm": classificado_em,
    }


# ── Auth do cron (réplica de ``autorizarCron`` do route.ts) ────────────────────


def _autorizar_cron(request: Request) -> bool:
    """Réplica EXATA de ``autorizarCron`` (route.ts).

    - Se ``CRON_SECRET`` definido (truthy): exige ``Authorization: Bearer
      <CRON_SECRET>``.
    - Caso contrário: aceita ``x-vercel-cron: 1``.
    """
    cron_secret = settings.cron_secret
    if cron_secret:
        auth_header = request.headers.get("authorization") or ""
        # Constant-time (safe_equal): mesmo resultado booleano da igualdade
        # simples, sem canal de timing (hardening 02/07).
        return safe_equal(auth_header, f"Bearer {cron_secret}")
    return request.headers.get("x-vercel-cron") == "1"


# ── Handler ────────────────────────────────────────────────────────────────────


@router.get("/api/cron/triagem-semantica")
async def get_cron_triagem_semantica(request: Request) -> JSONResponse:
    """GET /api/cron/triagem-semantica — pré-classificação de relevância via Haiku.

    Réplica fiel do handler GET do Next: auth de cron, gates graciosos,
    seleção de candidatas, carregamento de itens, classificação por IA e
    persistência em lote.
    """
    if not _autorizar_cron(request):
        return JSONResponse(content={"error": "Não autorizado"}, status_code=401)

    # Gate gracioso — não quebra o build/run quando desabilitado ou sem secret.
    if not _cron_habilitado():
        return JSONResponse(content={"ok": True, "skipped": "desabilitado"})
    # Gate de IA (services/anthropic.py): a triagem semântica está BLOQUEADA por
    # configuração — só a análise de edital consome a API da Anthropic.
    # ia_permitida() é sempre false aqui, então o cron continua rodando verde (skip
    # explícito) em vez de estourar dentro de _classificar_licitacao(). Cobre também
    # o caso legítimo de ANTHROPIC_API_KEY ausente.
    if not anthropic_svc.ia_permitida("triagem-semantica"):
        # log.warn("IA indisponível/bloqueada para triagem semântica — execução pulada")
        return JSONResponse(
            content={
                "ok": True,
                "skipped": "IA bloqueada (ver bff/app/services/anthropic.py)",
            }
        )

    # G4: kill-switch diário de tokens (IA_BUDGET_TOKENS_DAILY > 0).
    if budget_excedido():
        return JSONResponse(
            content={
                "ok": True,
                "skipped": "ia_budget_excedido",
                "tokensUsadosHoje": True,
            }
        )

    lote = _cron_lote()
    stats = {
        "candidatas": 0,
        "classificadas": 0,
        "altoInteresse": 0,
        "errosParse": 0,
        "falhas": 0,
        "tokensInput": 0,
        "tokensOutput": 0,
    }

    async with SessionLocal() as db:
        # ── 1. Seleciona licitações ainda não classificadas por IA ────────────
        # Prioriza as mais recentes (criado_em desc) para o feed refletir novidades.
        res_pendentes = await db.execute(
            text(
                """
                SELECT
                    id              AS "id",
                    numero          AS "numero",
                    objeto          AS "objeto",
                    objeto_resumido AS "objetoResumido"
                FROM licitacoes
                WHERE classificado_ia_em IS NULL
                ORDER BY criado_em DESC
                LIMIT :lote
                """
            ),
            {"lote": int(lote)},
        )
        pendentes = [dict(r) for r in res_pendentes.mappings().all()]

        stats["candidatas"] = len(pendentes)

        if len(pendentes) == 0:
            # log.info("nenhuma licitação pendente de triagem")
            return JSONResponse(content={"ok": True, "stats": stats})

        # ── 2. Carrega itens de todas as candidatas de uma vez (evita N+1) ─────
        ids = [str(p.get("id")) for p in pendentes]
        res_itens = await db.execute(
            text(
                """
                SELECT
                    licitacao_id      AS "licitacaoId",
                    descricao         AS "descricao",
                    familia           AS "familia",
                    familia_descricao AS "familiaDescricao"
                FROM itens
                WHERE licitacao_id IN :ids
                """
            ).bindparams(bindparam("ids", expanding=True)),
            {"ids": ids},
        )
        itens_rows = [dict(r) for r in res_itens.mappings().all()]

        itens_por_lic: dict[str, list[dict[str, Any]]] = {}
        for it in itens_rows:
            chave = str(it.get("licitacaoId"))
            arr = itens_por_lic.get(chave)
            if arr is None:
                arr = []
            # Limita itens por licitação para conter o tamanho do prompt.
            if len(arr) < 40:
                arr.append(
                    {
                        "descricao": it.get("descricao"),
                        "familia": it.get("familia"),
                        "familiaDescricao": it.get("familiaDescricao"),
                    }
                )
            itens_por_lic[chave] = arr

        # ── 3. Classifica cada licitação e acumula escritas ────────────────────
        statements: list[dict[str, Any]] = []
        score_alto = _cron_score_alto()

        for lic in pendentes:
            if budget_excedido():
                stats["skippedBudget"] = True
                break

            chave = str(lic.get("id"))
            entrada = {
                "numero": lic.get("numero"),
                "objeto": lic.get("objeto"),
                "objetoResumido": lic.get("objetoResumido"),
                "itens": itens_por_lic.get(chave) or [],
            }

            try:
                resultado = await _classificar_licitacao(entrada)
            except Exception:  # noqa: BLE001 — falha de IA não derruba o lote
                stats["falhas"] += 1
                # log.error("falha ao classificar licitação", err, {...})
                continue

            stats["classificadas"] += 1
            stats["tokensInput"] += resultado["tokensInput"]
            stats["tokensOutput"] += resultado["tokensOutput"]
            total_tokens = resultado["tokensInput"] + resultado["tokensOutput"]
            registrar_tokens(total_tokens)
            record_anthropic_usage(
                rota="cron_triagem_semantica",
                modelo=resultado["modelo"],
                input_tokens=resultado["tokensInput"],
                output_tokens=resultado["tokensOutput"],
            )
            if resultado["erroParse"]:
                stats["errosParse"] += 1
            if resultado["score"] >= score_alto:
                stats["altoInteresse"] += 1

            classificacao_ia = {
                "score": resultado["score"],
                "segmento": resultado["segmento"],
                "aderencia": resultado["aderencia"],
                "justificativa": resultado["justificativa"],
                "perfil_sugerido": resultado["perfil_sugerido"],
                "modelo": resultado["modelo"],
                "schema_versao": resultado["schemaVersao"],
                "erro_parse": resultado["erroParse"],
                "classificado_em": resultado["classificadoEm"],
            }

            statements.append(
                {
                    "id": chave,
                    "classificacaoIa": classificacao_ia,
                }
            )

        # ── 4. Persiste tudo (Next: db.batch; aqui um commit único da sessão) ──
        if len(statements) > 0:
            import json as _json

            for st in statements:
                await db.execute(
                    text(
                        """
                        UPDATE licitacoes
                        SET classificacao_ia   = CAST(:classificacao_ia AS jsonb),
                            classificado_ia_em = now(),
                            atualizado_em      = now()
                        WHERE id = :id
                        """
                    ),
                    {
                        "id": st["id"],
                        "classificacao_ia": _json.dumps(
                            st["classificacaoIa"], ensure_ascii=False
                        ),
                    },
                )
            await db.commit()

        # log.info("execução concluída", { stats })
        return JSONResponse(content={"ok": True, "stats": stats})
