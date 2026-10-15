"""Rota MIGRADA (estrangulador): GET + POST /api/resultados/{id}/eventos.

Espelho 1:1 de ``src/app/api/resultados/[id]/eventos/route.ts`` — paridade de
resposta com o BFF FastAPI (``JSON.parse(bff) === JSON.parse(next)``).

  GET  /api/resultados/[id]/eventos — linha do tempo UNIFICADA de eventos do
       vencedor: eventos MANUAIS (``licitacao_eventos_vencedor``) + AUTOMÁTICOS
       (``petronect_lic_eventos``). Cada item tem ``fonteEvento`` =
       'manual' | 'automatico'.
  POST /api/resultados/[id]/eventos — registra novo evento (ANUNCIADO,
       DESCLASSIFICADO, CONVOCADO, DESISTIU, HOMOLOGADO). Quando
       tipo=CONVOCADO + cnpj=Proponente, dispara o workflow (cria envelope com
       prazo de 5 dias úteis + marca participação como GANHOU).

GUARDS (mapeados require* do Next → BFF):
  - GET  → ``requireVisualizar()`` == role ∈ ROLES_VISUALIZAR (ADMIN, LIDER,
           ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR). 401 sem sessão (shape do
           ApiError: ``{error, code}``), 403 sem permissão.
  - POST → ``requireAuth()`` (401 ``{error, code}``) + checagem inline
           ``podeGerenciarEnvelope(role)`` (isConformidade: ADMIN, LIDER, SGI);
           senão 403 ``{"error": "Permissão negada — restrita a CONFORMIDADE"}``.

Resolução de ``[id]`` (igual ao Next, ``numeroPorId``):
  - regex ``^\\d{8,12}$`` → numero = id.
  - senão SELECT numero_licitacao FROM resultados_licitacao WHERE id LIMIT 1;
    null → 404 ``{"error": "Resultado não encontrado"}``.

NOTA de transação (verbatim do Next/queries.ts): o driver neon-http não suporta
transações; os statements rodam sequencialmente (cada um atômico por si).
Replicamos a sequência exata (ordem, INSERT evento, UPDATE vencedor, audit log,
workflow de envelope) e damos commit ao final no POST.

SERIALIZAÇÃO (paridade JSON com Drizzle/pg):
  - uuid → ``str`` (Drizzle/pg devolve uuid como string).
  - timestamp(tz) → ISO via ``new Date(...).toISOString()`` (UTC, 'Z', ms) nos
    campos ``dataEvento``/``registradoEm`` dos eventos MANUAIS; ``detectadoEm``
    dos AUTOMÁTICOS vai cru (no Next o objeto Drizzle serializa o Date como ISO
    via JSON.stringify → mesmo formato ``toISOString``).
  - numeric → number|null (não há numeric no shape final aqui).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import get_current_user, is_conformidade, pode_visualizar
from app.db.session import get_db

# Réplica canônica do CNPJ Proponente — ver _shared.py.
from app.routers.migrated._shared import PROPONENTE_CNPJ

router = APIRouter()

# Mesma regex do Next (numeroPorId): numero "puro" (8 a 12 dígitos).
_NUMERO_REGEX = re.compile(r"^\d{8,12}$")

# Prazo de protocolo (queries.ts: PRAZO_PROTOCOLO_DIAS_UTEIS = 5).
PRAZO_PROTOCOLO_DIAS_UTEIS = 5

# Tipos/motivos/fontes do schema zod (validations.ts).
_TIPOS_EVENTO = ("ANUNCIADO", "DESCLASSIFICADO", "CONVOCADO", "DESISTIU", "HOMOLOGADO")
_MOTIVOS_EVENTO = (
    "DOCUMENTACAO_INSUFICIENTE",
    "INEXEQUIBILIDADE",
    "DESCUMPRIMENTO_REQUISITOS",
    "DESISTENCIA_VOLUNTARIA",
    "CADUCIDADE_PRAZO",
    "OUTRO",
)
_FONTES_EVENTO = (
    "PORTAL_PETRONECT",
    "EMAIL_PETROBRAS",
    "DOU",
    "CONFIRMACAO_INTERNA",
    "OUTRO",
)

# Keyword → subcategoria de doc (espelha KEYWORD_TO_SUB de envelopes.ts).
# (regex_flags, padrão) — todos case-insensitive como no Next (flag /i).
_KEYWORD_TO_SUB: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"cnd[\s_-]?federal|debitos\s+federais|pgfn", re.I), "CND_FEDERAL", "Certidão Negativa de Débitos Federais"),
    (re.compile(r"\bfgts\b|crf", re.I), "FGTS", "Certificado de Regularidade FGTS"),
    (re.compile(r"\bcndt\b|debitos\s+trabalhistas", re.I), "CNDT", "CNDT — Trabalhista"),
    (re.compile(r"cnd\s+estadual|sefaz", re.I), "CND_ESTADUAL", "Certidão Estadual"),
    (re.compile(r"cnd\s+municipal", re.I), "CND_MUNICIPAL", "Certidão Municipal"),
    (re.compile(r"falencia|concordata|recupera[çc][aã]o", re.I), "FALENCIA", "Negativa de Falência"),
    (re.compile(r"balan[çc]o|demonstra[çc][oõ]es", re.I), "BALANCO", "Balanço Patrimonial"),
    (re.compile(r"[íi]ndices?\s+(financeir|liquidez|solv)", re.I), "INDICES_FINANCEIROS", "Índices Financeiros"),
    (re.compile(r"contrato\s+social", re.I), "CONTRATO_SOCIAL", "Contrato Social"),
    (re.compile(r"cart[aã]o\s+cnpj|comprovante\s+cnpj", re.I), "CNPJ", "Cartão CNPJ"),
    (re.compile(r"ato\s+constitutivo", re.I), "ATO_CONSTITUTIVO", "Ato Constitutivo"),
    (re.compile(r"procura[çc][aã]o", re.I), "PROCURACAO", "Procuração"),
    (re.compile(r"atestad|capacidade\s+t[ée]cnica|\bact\b", re.I), "ATESTADO_ACT", "Atestado de Capacidade Técnica"),
    (re.compile(r"iso\s*9001", re.I), "ISO_9001", "ISO 9001"),
    (re.compile(r"iso\s*14001", re.I), "ISO_14001", "ISO 14001"),
    (re.compile(r"iso\s*45001", re.I), "ISO_45001", "ISO 45001"),
    (re.compile(r"nr\s*-?\s*10\b", re.I), "NR_10", "NR-10 Eletricidade"),
    (re.compile(r"nr\s*-?\s*13\b", re.I), "NR_13", "NR-13 Vasos de Pressão"),
    (re.compile(r"nr\s*-?\s*35\b", re.I), "NR_35", "NR-35 Trabalho em Altura"),
    (re.compile(r"\basme\b", re.I), "ASME", "ASME"),
    (re.compile(r"api\s*q1", re.I), "API_Q1", "API Q1"),
    (re.compile(r"api\s*6d", re.I), "API_6D", "API 6D"),
    (re.compile(r"\bped\b", re.I), "PED", "PED"),
    (re.compile(r"crea[\s_-]*pj|registro\s+(da\s+)?empresa", re.I), "CREA_PJ", "CREA Pessoa Jurídica"),
    (re.compile(r"crea[\s_-]*pf|engenheiro\s+respons[áa]vel", re.I), "CREA_PF", "CREA Pessoa Física"),
    (re.compile(r"\bart\b|cat[\s_-]+t[ée]cn", re.I), "ART_CAT", "ART / CAT"),
    (re.compile(r"menor.*n[aã]o\s+emprega|trabalho\s+menor", re.I), "DECL_MENOR_NAO_EMPREGA", "Decl. Não Emprega Menor"),
    (re.compile(r"idoneidade", re.I), "DECL_IDONEIDADE", "Decl. Idoneidade"),
    (re.compile(r"me[\s_-]*epp|microempresa", re.I), "DECL_ME_EPP", "Decl. ME / EPP"),
]

# Core sempre incluído (espelha CORE de extrairRequisitosDeAnalise).
_CORE_REQUISITOS: list[tuple[str, str]] = [
    ("CND_FEDERAL", "CND Federal (Receita/PGFN)"),
    ("FGTS", "CRF FGTS"),
    ("CNDT", "CNDT (Trabalhista)"),
    ("CONTRATO_SOCIAL", "Contrato Social"),
    ("CNPJ", "Cartão CNPJ"),
]


# ── Helpers de serialização (paridade JSON com Drizzle/pg) ────────────────────


def _to_iso_z(dt) -> str:
    """Replica ``new Date(dt).toISOString()`` do JS (UTC, sufixo 'Z', ms).

    Espelha o ``new Date(...).toISOString()`` aplicado em ``dataEvento`` e
    ``registradoEm`` (queries.ts listarEventos/registrarEvento). asyncpg entrega
    ``timestamp withTimezone`` como ``datetime`` aware; normalizamos p/ UTC e
    formatamos com ms para casar byte-a-byte. (Quando o valor é falsy o Next usa
    ``"" ``, tratado pelo chamador.)
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{ms:03d}Z"


def _uuid_str(v):
    """uuid → string (Drizzle/pg devolve uuid como STRING)."""
    if v is None:
        return None
    if isinstance(v, UUID):
        return str(v)
    return v


def _add_dias_uteis(de: datetime, dias: int) -> datetime:
    """Espelha addDiasUteis de queries.ts (pula sáb/dom).

    O Next opera sobre um ``Date`` local; aqui mantemos o ``datetime`` recebido e
    avançamos dia-a-dia pulando fim de semana (``weekday()``: 5=sáb, 6=dom).
    """
    d = de
    restantes = dias
    while restantes > 0:
        d = d + timedelta(days=1)
        dow = d.weekday()  # 0=seg ... 5=sáb, 6=dom
        if dow != 5 and dow != 6:
            restantes -= 1
    return d


# ── numeroPorId (espelha a função homônima do route.ts) ───────────────────────


async def _numero_por_id(db, id: str):
    """Aceita numero direto OU UUID legado → numero_licitacao | None."""
    if _NUMERO_REGEX.match(id):
        return id
    res = await db.execute(
        text(
            'SELECT numero_licitacao AS "numero" '
            "FROM resultados_licitacao WHERE id = :id LIMIT 1"
        ),
        {"id": id},
    )
    row = res.mappings().first()
    return row["numero"] if row is not None else None


# ── listarEventos (espelha queries.ts) ────────────────────────────────────────


async def _listar_eventos(db, numero_licitacao: str) -> list[dict]:
    """Eventos MANUAIS de licitacao_eventos_vencedor + nome do registrador.

    Replica a query Drizzle (colunas explícitas + leftJoin users, ORDER BY ordem)
    e o ``.map`` que serializa datas via ``new Date(...).toISOString()`` (ou ""
    quando falsy)."""
    res = await db.execute(
        text(
            """
            SELECT
                e.id                AS id,
                e.numero_licitacao  AS numero_licitacao,
                e.ordem             AS ordem,
                e.cnpj              AS cnpj,
                e.fornecedor        AS fornecedor,
                e.tipo              AS tipo,
                e.data_evento       AS data_evento,
                e.motivo            AS motivo,
                e.motivo_detalhe    AS motivo_detalhe,
                e.fonte             AS fonte,
                e.observacao        AS observacao,
                e.registrado_por    AS registrado_por,
                e.registrado_em     AS registrado_em,
                u.nome              AS registrado_por_nome
            FROM licitacao_eventos_vencedor e
            LEFT JOIN users u ON e.registrado_por = u.id
            WHERE e.numero_licitacao = :numero
            ORDER BY e.ordem
            """
        ),
        {"numero": numero_licitacao},
    )
    rows = res.mappings().all()

    out: list[dict] = []
    for r in rows:
        out.append(
            {
                "id": _uuid_str(r["id"]),
                "numeroLicitacao": r["numero_licitacao"],
                "ordem": r["ordem"],
                "cnpj": r["cnpj"],
                "fornecedor": r["fornecedor"],
                "tipo": r["tipo"],
                "dataEvento": _to_iso_z(r["data_evento"]) if r["data_evento"] else "",
                "motivo": r["motivo"],
                "motivoDetalhe": r["motivo_detalhe"],
                "fonte": r["fonte"],
                "observacao": r["observacao"],
                "registradoPor": _uuid_str(r["registrado_por"]),
                "registradoPorNome": r["registrado_por_nome"],
                "registradoEm": _to_iso_z(r["registrado_em"]) if r["registrado_em"] else "",
            }
        )
    return out


# ── Workflow de envelope (espelha envelopes.ts) ───────────────────────────────


def _extrair_requisitos_de_analise(textos: list[str]) -> list[dict]:
    """Espelha extrairRequisitosDeAnalise de envelopes.ts.

    Keyword matching + sempre inclui o CORE (CND_FEDERAL, FGTS, CNDT,
    CONTRATO_SOCIAL, CNPJ) que ainda não foi visto.
    """
    vistos: set[str] = set()
    requisitos: list[dict] = []

    for texto in textos:
        if not texto:
            continue
        for regex, codigo, descricao in _KEYWORD_TO_SUB:
            if regex.search(texto):
                if codigo in vistos:
                    continue
                vistos.add(codigo)
                requisitos.append({"codigo": codigo, "descricao": descricao})

    for codigo, descricao in _CORE_REQUISITOS:
        if codigo not in vistos:
            vistos.add(codigo)
            requisitos.append({"codigo": codigo, "descricao": descricao})

    return requisitos


async def _sugerir_documento_para_requisito(
    db, codigo_requisito: str, prazo_minimo_vigencia: datetime
) -> dict:
    """Espelha sugerirDocumentoParaRequisito de envelopes.ts.

    Busca os 5 docs VIGENTES da subcategoria (= código) ORDER BY validade_fim DESC
    e escolhe o que segue válido na data limite; senão o mais recente.
    """
    sub = codigo_requisito
    res = await db.execute(
        text(
            """
            SELECT id, validade_fim, validade_indeterminada, status
            FROM documentos_habilitacao
            WHERE subcategoria = :sub AND status = 'VIGENTE'
            ORDER BY validade_fim DESC
            LIMIT 5
            """
        ),
        {"sub": sub},
    )
    docs = res.mappings().all()

    if len(docs) == 0:
        return {"documentoId": None, "score": 0}

    # Preferir o que ainda estará válido na data limite.
    valido = None
    for d in docs:
        vf = d["validade_fim"]
        if d["validade_indeterminada"] or (vf is not None and vf >= prazo_minimo_vigencia):
            valido = d
            break
    if valido is not None:
        return {"documentoId": _uuid_str(valido["id"]), "score": 0.9}

    return {"documentoId": _uuid_str(docs[0]["id"]), "score": 0.5}


async def _montar_plano_requisitos(
    db, licitacao_id, prazo_vigencia: datetime
) -> list[dict]:
    """Espelha montarPlanoRequisitos de envelopes.ts (somente leituras)."""
    requisitos_extraidos: list[dict] = []

    if licitacao_id:
        res = await db.execute(
            text(
                """
                SELECT criterios_habilitacao, requisitos, objeto_detalhado
                FROM analises_ia
                WHERE licitacao_id = :lic
                LIMIT 1
                """
            ),
            {"lic": licitacao_id},
        )
        analise = res.mappings().first()

        if analise is not None:
            textos: list[str] = []
            ch = analise["criterios_habilitacao"]
            if isinstance(ch, list):
                textos.extend(str(s) for s in ch)
            elif isinstance(ch, str):
                textos.append(ch)

            rq = analise["requisitos"]
            if isinstance(rq, list):
                textos.extend(str(s) for s in rq)

            if analise["objeto_detalhado"]:
                textos.append(analise["objeto_detalhado"])

            requisitos_extraidos = _extrair_requisitos_de_analise(textos)

    if len(requisitos_extraidos) == 0:
        # Fallback: só os core.
        requisitos_extraidos = _extrair_requisitos_de_analise([])

    if not licitacao_id or len(requisitos_extraidos) == 0:
        return []

    plano: list[dict] = []
    for i, r in enumerate(requisitos_extraidos):
        sugestao = await _sugerir_documento_para_requisito(
            db, r["codigo"], prazo_vigencia
        )
        plano.append(
            {
                "codigo": r["codigo"],
                "descricao": r["descricao"],
                "ordem": i,
                "documentoId": sugestao["documentoId"],
                "score": sugestao["score"],
            }
        )
    return plano


async def _gravar_requisitos_do_envelope(
    db, envelope_id: str, licitacao_id, plano: list[dict]
) -> dict:
    """Espelha gravarRequisitosDoEnvelope (1 INSERT requisitos + 1 INSERT itens)."""
    if not licitacao_id or len(plano) == 0:
        return {"totalRequisitos": 0, "itensComDoc": 0, "itensPendentes": 0}

    # 1 INSERT para todos os requisitos (RETURNING id, na MESMA ordem do plano).
    requisitos_criados: list = []
    for r in plano:
        res = await db.execute(
            text(
                """
                INSERT INTO requisitos_edital
                    (licitacao_id, codigo, descricao, obrigatorio, fonte, ordem)
                VALUES (:lic, :codigo, :descricao, true, 'ANALISE_IA', :ordem)
                RETURNING id
                """
            ),
            {
                "lic": licitacao_id,
                "codigo": r["codigo"],
                "descricao": r["descricao"],
                "ordem": r["ordem"],
            },
        )
        requisitos_criados.append(res.mappings().first()["id"])

    # 1 INSERT para todos os itens — casa requisito criado ↔ sugestão por índice.
    for i, req_id in enumerate(requisitos_criados):
        p = plano[i]
        status = "ATRIBUIDO" if p["documentoId"] else "PENDENTE"
        await db.execute(
            text(
                """
                INSERT INTO envelope_itens
                    (envelope_id, requisito_id, documento_id, status,
                     score_sugestao, atribuido_em)
                VALUES (:env, :req, :doc, :status, :score,
                        CASE WHEN :doc IS NULL THEN NULL ELSE now() END)
                """
            ),
            {
                "env": envelope_id,
                "req": req_id,
                "doc": p["documentoId"],
                "status": status,
                "score": p["score"],
            },
        )

    com_doc = len([p for p in plano if p["documentoId"]])
    return {
        "totalRequisitos": len(requisitos_criados),
        "itensComDoc": com_doc,
        "itensPendentes": len(requisitos_criados) - com_doc,
    }


async def _criar_envelope_apos_vitoria(db, participacao_id: str, responsavel_sgi):
    """Espelha criarEnvelopeAposVitoria de envelopes.ts (idempotente)."""
    # Já existe?
    res_ex = await db.execute(
        text(
            "SELECT id FROM envelopes_habilitacao "
            "WHERE participacao_id = :pid LIMIT 1"
        ),
        {"pid": participacao_id},
    )
    existente = res_ex.mappings().first()
    if existente is not None:
        res_itens = await db.execute(
            text(
                "SELECT id, status FROM envelope_itens WHERE envelope_id = :env"
            ),
            {"env": existente["id"]},
        )
        itens = res_itens.mappings().all()
        return {
            "envelopeId": _uuid_str(existente["id"]),
            "totalRequisitos": len(itens),
            "itensComDoc": len([i for i in itens if i["status"] == "ATRIBUIDO"]),
            "itensPendentes": len([i for i in itens if i["status"] == "PENDENTE"]),
        }

    # Buscar dados da participação.
    res_part = await db.execute(
        text(
            """
            SELECT id, numero_edital, empresa_contratante, objeto,
                   licitacao_petro_radar_id, prazo_portal
            FROM participacoes_licitacao
            WHERE id = :pid
            LIMIT 1
            """
        ),
        {"pid": participacao_id},
    )
    part = res_part.mappings().first()
    if part is None:
        return None

    plano = await _montar_plano_requisitos(
        db,
        part["licitacao_petro_radar_id"],
        part["prazo_portal"] if part["prazo_portal"] is not None else datetime.now(tz=timezone.utc),
    )

    res_env = await db.execute(
        text(
            """
            INSERT INTO envelopes_habilitacao
                (origem, participacao_id, licitacao_id, numero_edital,
                 empresa_contratante, objeto, status, prazo_protocolo,
                 responsavel_sgi)
            VALUES ('PARTICIPACAO', :pid, :lic, :numero_edital,
                    :empresa, :objeto, 'EM_MONTAGEM', NULL, :resp)
            RETURNING id
            """
        ),
        {
            "pid": participacao_id,
            "lic": part["licitacao_petro_radar_id"],
            "numero_edital": part["numero_edital"],
            "empresa": part["empresa_contratante"],
            "objeto": part["objeto"],
            "resp": responsavel_sgi,
        },
    )
    envelope_id = res_env.mappings().first()["id"]

    resultado = await _gravar_requisitos_do_envelope(
        db, envelope_id, part["licitacao_petro_radar_id"], plano
    )

    return {"envelopeId": _uuid_str(envelope_id), **resultado}


async def _criar_envelope_avulso(
    db,
    numero_edital: str,
    empresa_contratante: str,
    objeto: str,
    licitacao_id,
    prazo_protocolo,
    responsavel_sgi,
    observacoes,
):
    """Espelha criarEnvelopeAvulso de envelopes.ts."""
    origem = "LICITACAO" if licitacao_id else "AVULSO"

    dados_lic = None
    if licitacao_id:
        res_lic = await db.execute(
            text(
                "SELECT numero, empresa, objeto FROM licitacoes "
                "WHERE id = :id LIMIT 1"
            ),
            {"id": licitacao_id},
        )
        lic = res_lic.mappings().first()
        if lic is None:
            raise ValueError("Licitação informada não existe")
        dados_lic = lic

    numero_edital_f = numero_edital or (dados_lic["numero"] if dados_lic else None) or ""
    empresa_f = (
        empresa_contratante
        or (dados_lic["empresa"] if dados_lic else None)
        or "Petrobras"
    )
    objeto_f = objeto or (dados_lic["objeto"] if dados_lic else None) or ""

    plano = await _montar_plano_requisitos(
        db,
        licitacao_id,
        prazo_protocolo if prazo_protocolo is not None else datetime.now(tz=timezone.utc),
    )

    res_env = await db.execute(
        text(
            """
            INSERT INTO envelopes_habilitacao
                (origem, participacao_id, licitacao_id, numero_edital,
                 empresa_contratante, objeto, status, prazo_protocolo,
                 responsavel_sgi, observacoes)
            VALUES (:origem, NULL, :lic, :numero_edital, :empresa, :objeto,
                    'EM_MONTAGEM', :prazo, :resp, :obs)
            RETURNING id
            """
        ),
        {
            "origem": origem,
            "lic": licitacao_id,
            "numero_edital": numero_edital_f,
            "empresa": empresa_f,
            "objeto": objeto_f,
            "prazo": prazo_protocolo,
            "resp": responsavel_sgi,
            "obs": observacoes,
        },
    )
    envelope_id = res_env.mappings().first()["id"]

    resultado = await _gravar_requisitos_do_envelope(
        db, envelope_id, licitacao_id, plano
    )

    return {"envelopeId": _uuid_str(envelope_id), **resultado}


# ── registrarEvento (espelha queries.ts) ──────────────────────────────────────


async def _registrar_evento(
    db,
    numero_licitacao: str,
    cnpj: str,
    fornecedor: str,
    tipo: str,
    data_evento,
    motivo,
    motivo_detalhe,
    fonte: str,
    observacao,
    user_id: str,
) -> dict:
    """Espelha registrarEvento de queries.ts (sequência completa + workflow)."""
    dt_evento = data_evento if data_evento is not None else datetime.now(tz=timezone.utc)

    # 1. Calcula próxima ordem.
    res_max = await db.execute(
        text(
            """
            SELECT COALESCE(MAX(ordem), 0) AS max
            FROM licitacao_eventos_vencedor
            WHERE numero_licitacao = :numero
            """
        ),
        {"numero": numero_licitacao},
    )
    max_row = res_max.mappings().first()
    ordem = (max_row["max"] if max_row["max"] is not None else 0) + 1

    # 2. Insere o evento.
    res_ev = await db.execute(
        text(
            """
            INSERT INTO licitacao_eventos_vencedor
                (numero_licitacao, ordem, cnpj, fornecedor, tipo, data_evento,
                 motivo, motivo_detalhe, fonte, observacao, registrado_por)
            VALUES (:numero, :ordem, :cnpj, :fornecedor, :tipo, :data_evento,
                    :motivo, :motivo_detalhe, :fonte, :observacao, :registrado_por)
            RETURNING id, numero_licitacao, ordem, cnpj, fornecedor, tipo,
                      data_evento, motivo, motivo_detalhe, fonte, observacao,
                      registrado_por, registrado_em
            """
        ),
        {
            "numero": numero_licitacao,
            "ordem": ordem,
            "cnpj": cnpj,
            "fornecedor": fornecedor,
            "tipo": tipo,
            "data_evento": dt_evento,
            "motivo": motivo if motivo is not None else None,
            "motivo_detalhe": motivo_detalhe if motivo_detalhe is not None else None,
            "fonte": fonte,
            "observacao": observacao if observacao is not None else None,
            "registrado_por": user_id,
        },
    )
    evento = res_ev.mappings().first()

    # 3. Se é CONVOCADO ou HOMOLOGADO, atualiza o cnpj_vencedor "atual".
    cnpj_vencedor_atualizado = False
    if tipo == "CONVOCADO" or tipo == "HOMOLOGADO":
        await db.execute(
            text(
                """
                UPDATE resultados_licitacao
                SET cnpj_vencedor = :cnpj, fornecedor_vencedor = :fornecedor
                WHERE numero_licitacao = :numero
                """
            ),
            {"cnpj": cnpj, "fornecedor": fornecedor, "numero": numero_licitacao},
        )
        cnpj_vencedor_atualizado = True

    # 4. Audit log.
    audit_detalhes = {
        "ordem": ordem,
        "cnpj": cnpj,
        "fornecedor": fornecedor,
        "motivo": motivo,
        "fonte": fonte,
    }
    await db.execute(
        text(
            """
            INSERT INTO audit_log (user_id, acao, entidade, entidade_id, detalhes)
            VALUES (:user_id, :acao, :entidade, :entidade_id,
                    CAST(:detalhes AS jsonb))
            """
        ),
        {
            "user_id": user_id,
            "acao": f"EVENTO_VENCEDOR_{tipo}",
            "entidade": "resultado_licitacao",
            "entidade_id": numero_licitacao,
            "detalhes": json.dumps(audit_detalhes, ensure_ascii=False),
        },
    )

    result = {
        "evento": {
            "id": _uuid_str(evento["id"]),
            "numeroLicitacao": evento["numero_licitacao"],
            "ordem": evento["ordem"],
            "cnpj": evento["cnpj"],
            "fornecedor": evento["fornecedor"],
            "tipo": evento["tipo"],
            "dataEvento": _to_iso_z(evento["data_evento"]) if evento["data_evento"] else "",
            "motivo": evento["motivo"],
            "motivoDetalhe": evento["motivo_detalhe"],
            "fonte": evento["fonte"],
            "observacao": evento["observacao"],
            "registradoPor": _uuid_str(evento["registrado_por"]),
            "registradoPorNome": None,
            "registradoEm": _to_iso_z(evento["registrado_em"]) if evento["registrado_em"] else "",
        },
        "envelopeCriado": None,
        "participacaoAtualizada": False,
        "cnpjVencedorAtualizado": cnpj_vencedor_atualizado,
    }

    # 5. Workflow pós-escrita: criar envelope + atualizar participação.
    if tipo != "CONVOCADO" or cnpj != PROPONENTE_CNPJ:
        return result

    base = data_evento if data_evento is not None else datetime.now(tz=timezone.utc)
    prazo_protocolo = _add_dias_uteis(base, PRAZO_PROTOCOLO_DIAS_UTEIS)

    # Existe participação Proponente para esta licitação?
    res_part = await db.execute(
        text(
            """
            SELECT id, resultado
            FROM participacoes_licitacao
            WHERE numero_edital = :numero AND deletado_em IS NULL
            LIMIT 1
            """
        ),
        {"numero": numero_licitacao},
    )
    participacao = res_part.mappings().first()

    envelope_criado = None
    participacao_atualizada = False

    if participacao is not None:
        env = await _criar_envelope_apos_vitoria(db, participacao["id"], user_id)
        if env:
            await db.execute(
                text(
                    "UPDATE envelopes_habilitacao SET prazo_protocolo = :prazo "
                    "WHERE id = :id"
                ),
                {"prazo": prazo_protocolo, "id": env["envelopeId"]},
            )
            envelope_criado = {"envelopeId": env["envelopeId"], "tipo": "PARTICIPACAO"}

        if participacao["resultado"] != "GANHOU":
            await db.execute(
                text(
                    "UPDATE participacoes_licitacao "
                    "SET resultado = 'GANHOU', atualizado_em = :now "
                    "WHERE id = :id"
                ),
                {"now": datetime.now(tz=timezone.utc), "id": participacao["id"]},
            )
            participacao_atualizada = True
    else:
        # Sem participação: cria envelope avulso vinculado à licitação se houver.
        res_lic = await db.execute(
            text(
                "SELECT id, objeto, empresa FROM licitacoes "
                "WHERE numero = :numero LIMIT 1"
            ),
            {"numero": numero_licitacao},
        )
        lic = res_lic.mappings().first()

        env = await _criar_envelope_avulso(
            db,
            numero_edital=numero_licitacao,
            empresa_contratante=(lic["empresa"] if lic is not None else None) or "Petrobras",
            objeto=(lic["objeto"] if lic is not None else None) or "",
            licitacao_id=(lic["id"] if lic is not None else None),
            prazo_protocolo=prazo_protocolo,
            responsavel_sgi=user_id,
            observacoes=(
                f"Envelope criado automaticamente após convocação "
                f"(evento #{result['evento']['ordem']})."
            ),
        )
        envelope_criado = {"envelopeId": env["envelopeId"], "tipo": "AVULSO"}

    result["envelopeCriado"] = envelope_criado
    result["participacaoAtualizada"] = participacao_atualizada
    return result


# ── Validação do body (espelha RegistrarEventoSchema do zod) ──────────────────


def _validar_body(body) -> tuple[dict | None, dict | None]:
    """RegistrarEventoSchema.safeParse — (data, None) | (None, detalhes).

    Espelha o schema zod (validations.ts). ``detalhes`` é o ``formatZodErrors``:
    um dict ``{path: message}`` (primeiro erro por path) consumido pelo cliente.
    """
    erros: dict[str, str] = {}
    if not isinstance(body, dict):
        return None, {"": "Expected object, received " + (
            "null" if body is None else type(body).__name__
        )}

    data: dict = {}

    # cnpj — string → só dígitos → exige 14.
    if "cnpj" not in body or not isinstance(body.get("cnpj"), str):
        if "cnpj" not in erros:
            erros["cnpj"] = "Required" if "cnpj" not in body else "Expected string, received " + type(body.get("cnpj")).__name__
    else:
        digitos = re.sub(r"\D", "", body["cnpj"])
        if len(digitos) != 14:
            if "cnpj" not in erros:
                erros["cnpj"] = "CNPJ inválido"
        else:
            data["cnpj"] = digitos

    # fornecedor — string trim min 2 max 300.
    if "fornecedor" not in body or not isinstance(body.get("fornecedor"), str):
        if "fornecedor" not in erros:
            erros["fornecedor"] = "Required" if "fornecedor" not in body else "Expected string, received " + type(body.get("fornecedor")).__name__
    else:
        f = body["fornecedor"].strip()
        if len(f) < 2:
            if "fornecedor" not in erros:
                erros["fornecedor"] = "String must contain at least 2 character(s)"
        elif len(f) > 300:
            if "fornecedor" not in erros:
                erros["fornecedor"] = "String must contain at most 300 character(s)"
        else:
            data["fornecedor"] = f

    # tipo — enum obrigatório.
    if "tipo" not in body:
        if "tipo" not in erros:
            erros["tipo"] = "Required"
    elif body["tipo"] not in _TIPOS_EVENTO:
        opcoes = ", ".join(f"'{o}'" for o in _TIPOS_EVENTO)
        if "tipo" not in erros:
            erros["tipo"] = f"Invalid enum value. Expected {opcoes}, received '{body['tipo']}'"
    else:
        data["tipo"] = body["tipo"]

    # dataEvento — datetime ISO com offset, opcional.
    if "dataEvento" in body and body["dataEvento"] is not None:
        de = body["dataEvento"]
        parsed_dt = None
        if isinstance(de, str):
            parsed_dt = _parse_datetime_offset(de)
        if parsed_dt is None:
            if "dataEvento" not in erros:
                erros["dataEvento"] = "Invalid datetime"
        else:
            data["dataEvento"] = parsed_dt

    # motivo — enum opcional.
    if "motivo" in body and body["motivo"] is not None:
        if body["motivo"] not in _MOTIVOS_EVENTO:
            opcoes = ", ".join(f"'{o}'" for o in _MOTIVOS_EVENTO)
            if "motivo" not in erros:
                erros["motivo"] = f"Invalid enum value. Expected {opcoes}, received '{body['motivo']}'"
        else:
            data["motivo"] = body["motivo"]

    # motivoDetalhe — string trim max 500, opcional.
    if "motivoDetalhe" in body and body["motivoDetalhe"] is not None:
        md = body["motivoDetalhe"]
        if not isinstance(md, str):
            if "motivoDetalhe" not in erros:
                erros["motivoDetalhe"] = "Expected string, received " + type(md).__name__
        else:
            mdt = md.strip()
            if len(mdt) > 500:
                if "motivoDetalhe" not in erros:
                    erros["motivoDetalhe"] = "String must contain at most 500 character(s)"
            else:
                data["motivoDetalhe"] = mdt

    # fonte — enum com default "CONFIRMACAO_INTERNA".
    if "fonte" not in body or body["fonte"] is None:
        data["fonte"] = "CONFIRMACAO_INTERNA"
    elif body["fonte"] not in _FONTES_EVENTO:
        opcoes = ", ".join(f"'{o}'" for o in _FONTES_EVENTO)
        if "fonte" not in erros:
            erros["fonte"] = f"Invalid enum value. Expected {opcoes}, received '{body['fonte']}'"
    else:
        data["fonte"] = body["fonte"]

    # observacao — string trim max 1000, opcional.
    if "observacao" in body and body["observacao"] is not None:
        ob = body["observacao"]
        if not isinstance(ob, str):
            if "observacao" not in erros:
                erros["observacao"] = "Expected string, received " + type(ob).__name__
        else:
            obt = ob.strip()
            if len(obt) > 1000:
                if "observacao" not in erros:
                    erros["observacao"] = "String must contain at most 1000 character(s)"
            else:
                data["observacao"] = obt

    if erros:
        return None, erros
    return data, None


def _parse_datetime_offset(s: str):
    """Espelha z.string().datetime({offset:true}): exige offset (Z ou ±HH:MM)."""
    try:
        normalized = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(normalized)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        # offset: true exige timezone/offset explícito.
        return None
    return dt


# ── Handlers ──────────────────────────────────────────────────────────────────


@router.get("/api/resultados/{id}/eventos")
async def get_eventos(id: str, request: Request, db=Depends(get_db)) -> JSONResponse:
    """GET — timeline UNIFICADA (manuais + automáticos)."""
    # requireVisualizar() — chamado em try/catch (handleApiError → {error, code}).
    try:
        user = await get_current_user(request)
        if not pode_visualizar(user.role):
            return JSONResponse(
                status_code=403, content={"error": "Permissão negada", "code": "FORBIDDEN"}
            )
    except Exception:  # noqa: BLE001 — ApiError(401) → handleApiError
        return JSONResponse(
            status_code=401, content={"error": "Não autenticado", "code": "UNAUTHENTICATED"}
        )

    numero = await _numero_por_id(db, id)
    if not numero:
        return JSONResponse(
            status_code=404, content={"error": "Resultado não encontrado"}
        )

    # Promise.all([listarEventos, query petronect_lic_eventos ORDER BY detectado_em DESC]).
    eventos_manuais = await _listar_eventos(db, numero)

    res_auto = await db.execute(
        text(
            """
            SELECT id, numero, tipo, campo, valor_anterior, valor_novo, payload,
                   detectado_em
            FROM petronect_lic_eventos
            WHERE numero = :numero
            ORDER BY detectado_em DESC
            """
        ),
        {"numero": numero},
    )
    eventos_auto = res_auto.mappings().all()

    manuais_formatados = [{**e, "fonteEvento": "manual"} for e in eventos_manuais]

    automaticos_formatados = []
    for e in eventos_auto:
        det = e["detectado_em"]
        automaticos_formatados.append(
            {
                "id": _uuid_str(e["id"]),
                "numero": e["numero"],
                "tipo": e["tipo"],
                "campo": e["campo"],
                "valorAnterior": e["valor_anterior"],
                "valorNovo": e["valor_novo"],
                "payload": e["payload"],
                "detectadoEm": _to_iso_z(det) if det else None,
                "fonteEvento": "automatico",
            }
        )

    # Merge — manuais primeiro + automáticos.
    return JSONResponse(
        content={
            "data": [*manuais_formatados, *automaticos_formatados],
            "counts": {
                "manuais": len(manuais_formatados),
                "automaticos": len(automaticos_formatados),
                "total": len(manuais_formatados) + len(automaticos_formatados),
            },
        }
    )


@router.post("/api/resultados/{id}/eventos")
async def post_evento(id: str, req: Request, db=Depends(get_db)) -> JSONResponse:
    """POST — registra novo evento (restrito a CONFORMIDADE)."""
    # requireAuth() — try/catch (handleApiError → {error, code}).
    try:
        user = await get_current_user(req)
    except Exception:  # noqa: BLE001 — ApiError(401)
        return JSONResponse(
            status_code=401, content={"error": "Não autenticado", "code": "UNAUTHENTICATED"}
        )

    # podeGerenciarEnvelope(role) == isConformidade(role).
    if not is_conformidade(user.role):
        return JSONResponse(
            status_code=403,
            content={"error": "Permissão negada — restrita a CONFORMIDADE"},
        )

    numero = await _numero_por_id(db, id)
    if not numero:
        return JSONResponse(
            status_code=404, content={"error": "Resultado não encontrado"}
        )

    # body = await req.json() → 400 "JSON inválido".
    try:
        body = await req.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    # RegistrarEventoSchema.safeParse → 422 {error, detalhes}.
    data, detalhes = _validar_body(body)
    if detalhes is not None:
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": detalhes},
        )
    assert data is not None

    result = await _registrar_evento(
        db,
        numero_licitacao=numero,
        cnpj=data["cnpj"],
        fornecedor=data["fornecedor"],
        tipo=data["tipo"],
        data_evento=data.get("dataEvento"),
        motivo=data.get("motivo"),
        motivo_detalhe=data.get("motivoDetalhe"),
        fonte=data["fonte"],
        observacao=data.get("observacao"),
        user_id=user.id,
    )

    await db.commit()

    return JSONResponse(content=result, status_code=201)
