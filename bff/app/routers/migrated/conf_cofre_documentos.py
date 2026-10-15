"""Rota MIGRADA (estrangulador): /api/conformidade/cofre/documentos.

Espelha 1:1 ``src/app/api/conformidade/cofre/documentos/route.ts`` do app Next.js.
Cobre os TRÊS handlers exportados pelo Next: GET (lista com filtros), POST
(upload multipart + criação do registro, com OCR opt-in) e DELETE (exclusão em
massa, somente ADMIN). NÃO há PUT/PATCH neste arquivo (o Next não os exporta).

──────────────────────────────────────────────────────────────────────────────
GUARDS (paridade EXATA com o Next — ATENÇÃO: os guards NÃO são os ``require_*``
semânticos do BFF; replicamos as funções de permissions.ts à mão porque a ordem
de checagens e as MENSAGENS de erro divergem dos defaults):

  GET   → ``requireVisualizar()``  == BFF ``require_visualizar`` (ADMIN, LIDER,
          ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR). 401 sem sessão, 403 fora.

  POST  → ``requireAuth()``  (apenas sessão; 401 sem sessão) e SÓ DEPOIS
          ``podeGerenciarDocumentosHabilitacao(role)`` → isConformidade(role)
          (ADMIN/LIDER/SGI) OU role == ORCAMENTISTA OU role == TECNICO.
          Falha de papel → 403 ``{"error":"Permissão negada"}``. Esse conjunto é
          MAIS AMPLO que ``require_conformidade`` (inclui ORCAMENTISTA/TECNICO),
          por isso NÃO usamos o guard semântico — fazemos a checagem manual após
          ``get_current_user`` para manter a ordem 401-antes-de-403 e a mensagem.

  DELETE → ``requireAuth()`` (401 sem sessão) e SÓ DEPOIS
           ``podeExcluirDocumentoHabilitacao(role)`` → isAdmin(role) (somente
           ADMIN). Falha → 403 ``{"error":"Somente administradores podem excluir
           documentos"}``.

SHAPE de erro: o Next usa ``{ "error": <string> }`` (e, nas validações Zod,
``{ "error": <string>, "detalhes": {<campo>: <msg>} }``). NÃO é ``{error:{message}}``.
Replicamos literalmente, com os MESMOS status (400/403/422) e mensagens em PT-BR.

0044 (onda 5) — o que mudou aqui, com espelho obrigatório no Next:
  • B6: cada item da lista e o corpo do 201 ganham ``revisao`` (a revisão que a
    ENGENHARIA carimba: "R0", "R1", "02A"), logo depois de ``versao``. No POST
    multipart o campo é validado (422 "Revisão muito longa" acima de 20 DEPOIS do
    trim) e GRAVADO já aparado; o OCR não o preenche. Editar depois é pelo PATCH
    (conf_cofre_documentos_id.py).
  • D8: o ``ORDER BY`` da lista ganhou ``, d.id ASC``. É a ÚNICA mudança desta
    onda que altera uma resposta JÁ PUBLICADA sem acrescentar campo — e é o que
    torna a rolagem infinita do cofre honesta (spec ONDA-5 §1b).

SHAPE de sucesso:
  GET  200  {"data":[...], "total", "page", "limit", "pages"}  (== listDocumentos)
  POST 201  o REGISTRO inserido cru (NextResponse.json(novo)) — NÃO embrulhado em
            {"data": ...}. camelCase idêntico ao $inferSelect do Drizzle.
  DELETE 200 {"ok": true, "apagados": <int>, "blobsApagados": <int>}.

COFRE POR OPERAÇÃO (migration 0033) — o que mudou nesta rota, sem quebrar quem
já usa (nenhum campo foi removido nem renomeado):
  GET  • novo filtro ``operacaoId`` (uuid) em FiltrosDocumentoSchema;
       • cada item da lista ganha ``"operacao": {id, codigo, clienteNome}`` ou
         ``null`` (LEFT JOIN em ``operacoes``; null = prova solta / documento que
         não é de obra).
  POST • novos campos multipart OPCIONAIS: ``operacaoId`` (uuid), ``papel``
         (ATESTADO|CAT_ART|CONTRATO|ADITIVO|NOTA_FISCAL|DECLARACAO|OUTRO) e
         ``permitirDuplicata`` (flag "true"/"1", como validadeIndeterminada);
       • 409 ``{"error":"Arquivo já está no cofre","documentoId","titulo"}``
         quando o sha256 do conteúdo JÁ existe e ``permitirDuplicata != "true"``.
         O 409 entra DEPOIS das validações de arquivo e do CriarDocumentoSchema
         e ANTES do OCR e do upload no S3 — recusar depois de subir o blob
         deixaria lixo órfão no MinIO e ainda pagaria OCR por um duplicado;
       • as colunas ``operacao_id``/``papel`` entram no INSERT e, por
         consequência do ``.returning()``, aparecem no corpo do 201.

STORAGE: upload/delete no S3/MinIO via ``aioboto3`` (settings.s3_*). Réplica do
``uploadHabilitacao``/``deleteDocumento`` de ``src/lib/storage`` (path-style,
mesma key ``habilitacao/<categoria>/<subcategoria>/<ts>_<nome>``, mesma URL
canônica path-style ``<endpoint>/<bucket>/<key>``). Import lazy de aioboto3 para
não onerar o import do módulo quando a dependência não está instalada.

OCR opt-in: ``ocr=="true"|"1"`` e ``file.type=="application/pdf"`` → extrai
metadados via Anthropic (Haiku), best-effort (falha NÃO derruba o upload). Réplica
de ``src/lib/conformidade/ocr.ts`` (mesmo system prompt cacheável, mesmo parse
tolerante de JSON, sobrescreve só campos que o usuário NÃO preencheu).
LGPD/DPIA: o envio à Anthropic é adicionalmente gated pelo flag
organizacional ``OCR_IA_ENABLED`` (default DESLIGADO) e o ``ocr_texto`` gravado tem
CPF/e-mail REDIGIDOS (``_redigir_pii``). Com a flag off o upload segue sem OCR.

SERIALIZAÇÃO: timestamptz → ``.isoformat()``; uuid → ``str()``; ``ocr_confianca``
(real) numérico; ``tags`` jsonb → list. O Drizzle entrega ``Date`` e o
``NextResponse.json`` chama ``.toISOString()`` (UTC, ms, sufixo 'Z'); como as
colunas de tempo aqui são ``timestamptz`` (asyncpg devolve aware em UTC),
usamos :func:`_js_to_iso_string` para bater wire-a-wire com o ``toISOString``.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import (
    CurrentUser,
    get_current_user,
    require_visualizar,
    ROLE_ADMIN,
    ROLE_ORCAMENTISTA,
    ROLE_TECNICO,
    ROLES_CONFORMIDADE,
)
from app.db.session import get_db
from app.routers.migrated._pii import redigir_pii
from app.routers.migrated._restrito import is_conformidade, restricao_visivel_sql
from app.services.audit import registrar_audit

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Permissões (réplica fiel de src/lib/permissions.ts — usadas pelos handlers)
# ══════════════════════════════════════════════════════════════════════════════


def _is_conformidade(role: str) -> bool:
    """``isConformidade(role)`` — ADMIN, LIDER, SGI."""
    return role in ROLES_CONFORMIDADE


def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    """``podeGerenciarDocumentosHabilitacao(role)``.

    isConformidade(role) || role === ORCAMENTISTA || role === TECNICO
    → {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}.
    """
    return _is_conformidade(role) or role == ROLE_ORCAMENTISTA or role == ROLE_TECNICO


def _pode_excluir_documento_habilitacao(role: str) -> bool:
    """``podeExcluirDocumentoHabilitacao(role)`` — isAdmin(role) (somente ADMIN)."""
    return role == ROLE_ADMIN


# ══════════════════════════════════════════════════════════════════════════════
# Serialização de datetimes (paridade com NextResponse.json -> Date.toISOString)
# ══════════════════════════════════════════════════════════════════════════════


def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` (UTC, milissegundos, sufixo 'Z').

    As colunas de tempo de ``documentos_habilitacao`` são ``timestamptz`` (asyncpg
    devolve ``datetime`` aware em UTC). O Drizzle entrega ``Date`` e o
    ``NextResponse.json`` serializa via ``.toISOString()`` → SEMPRE UTC, precisão
    de MILISSEGUNDOS, sufixo ``Z``. O ``isoformat()`` puro divergiria (``+00:00``
    e microssegundos), então formatamos à mão (mesma convenção dos irmãos migrados).
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"
    )


# ══════════════════════════════════════════════════════════════════════════════
# Validações de domínio (réplica dos schemas Zod de cofre/validations.ts)
# ══════════════════════════════════════════════════════════════════════════════

_CATEGORIAS = (
    "JURIDICA",
    "FISCAL",
    "ECONOMICA",
    "TECNICA",
    "QUALIFICACAO_PESSOAL",
    "DECLARACAO",
)

_SUBCATEGORIAS = (
    # FISCAL
    "CND_FEDERAL", "FGTS", "CNDT", "CND_ESTADUAL", "CND_MUNICIPAL", "FALENCIA",
    # ECONOMICA
    "BALANCO", "INDICES_FINANCEIROS",
    # JURIDICA
    "CONTRATO_SOCIAL", "CNPJ", "ATO_CONSTITUTIVO", "PROCURACAO",
    # TECNICA
    "ATESTADO_ACT", "ISO_9001", "ISO_14001", "ISO_45001",
    "NR_10", "NR_13", "NR_35", "ASME", "API_Q1", "API_6D", "PED", "OUTROS_TECNICOS",
    # QUALIFICACAO PESSOAL
    "CREA_PJ", "CREA_PF", "ART_CAT", "CTPS", "FORMACAO",
    # DECLARACOES
    "DECL_MENOR_NAO_EMPREGA", "DECL_IDONEIDADE", "DECL_ME_EPP", "DECL_OUTRA",
    # OUTROS
    "OUTRO",
)

_STATUS_DOC = ("VIGENTE", "EM_RENOVACAO", "VENCIDO", "SUBSTITUIDO")

# Papel da prova NA operação (CHECK de documentos_habilitacao.papel, 0033).
# A ORDEM é a da tupla PAPEIS_DOCUMENTO de src/lib/conformidade/operacoes.ts —
# ela entra na mensagem de enum do Zod, então não pode ser reordenada.
_PAPEIS = (
    "ATESTADO",
    "CAT_ART",
    "CONTRATO",
    "ADITIVO",
    "NOTA_FISCAL",
    "DECLARACAO",
    "OUTRO",
)

# Tuplas da 0034 (espelham TIPOS_DOCUMENTO/SITUACOES_PROVA/DETENTORAS de
# src/lib/conformidade/operacoes.ts). A ORDEM entra na mensagem de enum do Zod.
_TIPOS_DOCUMENTO = (
    "ART", "CAT", "ATESTADO", "CONTRATO", "ADITIVO", "ANEXO_CONTRATO",
    "CREA_PJ", "ISO", "DECLARACAO", "PROPOSTA", "ANEXO_ET", "DOC_PROJETO",
    "PEDIDO", "NF", "CARTA", "RELATORIO", "PESSOAL", "CAPA_OP",
    "COMPACTADO", "OUTRO",
)
_SITUACOES_PROVA = ("RASCUNHO", "ASSINADA_PROPONENTE", "ASSINADA_CLIENTE",
                    "SUPERADA", "CANCELADA", "MODELO", "INDEFINIDA")
_DETENTORAS = ("PROPONENTE", "COLIGADA", "PARCEIRO")

_ORDER_COLS = ("titulo", "categoria", "status", "validade", "criado_em")
_DIRS = ("asc", "desc")

_UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# Regex LITERAL do ``z.string().uuid()`` do Zod v4.4.3 (lida do schema real):
# exige versão 1..8 e variante 8/9/a/b, e admite os dois uuids especiais (nil e
# max). Vale só para os campos NOVOS da 0033 (``operacaoId``); ``familiaId``
# segue com o ``_UUID_REGEX`` acima, que é mais frouxo — trocar a validação de
# um filtro que já está em produção não é assunto desta entrega.
_UUID_ZOD_REGEX = re.compile(
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}"
    r"-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000"
    r"|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)

# Mensagem Zod do ``.datetime()`` (mesma string usada no dateTimeSchema).
_MSG_DATETIME = "Data e hora inválidas. Use o formato ISO 8601."

# Regex ISO 8601 do Zod ``.datetime()`` (sem offset; aceita Z e fração opcional).
# Réplica funcional: data-T-hora obrigatórias; ms opcional; 'Z' opcional.
_ZOD_DATETIME_REGEX = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z)?$"
)


# Sentinela: entrada numericamente válida porém NÃO-INTEIRA (ex.: "1.5").
# No Zod v4 ``z.coerce.number().int()`` o refinamento ``.int()`` dispara ANTES de
# ``.min()/.max()`` e produz "Invalid input: expected int, received number"
# (code invalid_type), independentemente de a parte inteira estar dentro/fora do
# range. Distinguimos esse caso do não-numérico (NaN) para casar a mensagem.
_NOT_INT = object()


def _coerce_int(value: str | None):
    """Espelha ``z.coerce.number()`` para os filtros numéricos do GET.

    ``z.coerce.number()`` faz ``Number(x)`` (NÃO ``parseInt``): string vazia/espaços
    → 0; ``Infinity``/non-finito e não-numérico → falha. Devolve:
      • ``None``      quando ``value is None`` (param ausente);
      • ``math.nan``  quando ``Number(x)`` é ``NaN``/não-finito (não-numérico) →
                      "Invalid input: expected number, received NaN";
      • ``_NOT_INT``  quando o número é finito mas não-inteiro (ex.: 1.5) →
                      "Invalid input: expected int, received number" (o ``.int()``
                      do Zod v4 dispara antes de ``.min()/.max()``);
      • ``int``       quando é um inteiro (inclui floats inteiro-valorados: 5.0).
    """
    if value is None:
        return None
    s = value.strip()
    if s == "":
        # Number("") === 0 (inteiro) → segue para .min()/.max().
        return 0
    try:
        f = float(s)
    except ValueError:
        return math.nan
    if math.isnan(f) or math.isinf(f):
        return math.nan
    # z.coerce.number().int() rejeita não-inteiros com a mensagem de tipo int.
    if f != math.floor(f):
        return _NOT_INT
    return int(f)


# ══════════════════════════════════════════════════════════════════════════════
# GET — listagem com filtros (== handler GET do route.ts + listDocumentos)
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/api/conformidade/cofre/documentos")
async def get_documentos(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
):
    """Lista documentos do cofre com filtros (paridade 1:1 com o Next).

    Guard: ``require_visualizar`` (espelha ``requireVisualizar()`` → todos exceto
    EXTERNO; 401 sem sessão, 403 EXTERNO). Em seguida valida os filtros
    (FiltrosDocumentoSchema): falha → 400 ``{"error":"Parâmetros inválidos",
    "detalhes":{...}}``. Sucesso → o objeto de ``listDocumentos``.
    """
    sp = request.query_params

    # FiltrosDocumentoSchema.safeParse({... ?? undefined / defaults ...})
    #
    # PARIDADE CRÍTICA com o Next (searchParams.get(x) ?? <default>):
    # ``searchParams.get(x)`` devolve a STRING vazia ('') quando o param está
    # PRESENTE-mas-vazio (?categoria=) e ``null`` só quando AUSENTE. O ``??`` só
    # substitui ``null``/``undefined`` — logo '' é REPASSADO ao Zod (não vira
    # default). Por isso NÃO usamos truthiness Python (``or None``/``or '1'``):
    # distinguimos ausente (None) de presente-vazio (''), repassando '' aos
    # validadores exatamente como o Zod recebe.
    detalhes: dict[str, str] = {}

    def _qp_opt(k: str) -> str | None:
        """``searchParams.get(k) ?? undefined`` — None se ausente, '' se vazio."""
        return sp.get(k)  # Starlette devolve None p/ ausente, '' p/ presente-vazio.

    def _qp_def(k: str, default: str) -> str:
        """``searchParams.get(k) ?? '<default>'`` — default SÓ quando ausente."""
        v = sp.get(k)
        return default if v is None else v  # '' presente-vazio NÃO vira default.

    # categoria/subcategoria/status: z.enum(...).optional()  (?? undefined)
    categoria = _qp_opt("categoria")
    if categoria is not None and categoria not in _CATEGORIAS:
        detalhes["categoria"] = _zod_enum_msg(_CATEGORIAS)

    subcategoria = _qp_opt("subcategoria")
    if subcategoria is not None and subcategoria not in _SUBCATEGORIAS:
        detalhes["subcategoria"] = _zod_enum_msg(_SUBCATEGORIAS)

    status_f = _qp_opt("status")
    if status_f is not None and status_f not in _STATUS_DOC:
        detalhes["status"] = _zod_enum_msg(_STATUS_DOC)

    # familiaId: z.string().uuid("ID inválido").optional()  ('' falha o uuid)
    familia_id = _qp_opt("familiaId")
    if familia_id is not None and not _UUID_REGEX.match(familia_id):
        detalhes["familiaId"] = "ID inválido"

    # operacaoId (0033): z.string().uuid("ID inválido").optional() — mesmo
    # tratamento do familiaId. É o filtro que a tela do cofre usa para abrir o
    # grupo de uma operação sem recarregar a lista inteira.
    operacao_id = _qp_opt("operacaoId")
    if operacao_id is not None and not _UUID_ZOD_REGEX.match(operacao_id):
        detalhes["operacaoId"] = "ID inválido"

    # semOperacao (0034/R6): flag "1"/"true" resolvida FORA do zod (padrão do
    # comProva de R1) → ``operacao_id IS NULL``. Nunca gera 400. Combinada com
    # operacaoId NÃO é erro: os dois predicados se aplicam e o resultado é
    # vazio (decisão declarada — nenhum 4xx especial).
    sem_operacao_raw = _qp_opt("semOperacao")
    sem_operacao = sem_operacao_raw == "1" or sem_operacao_raw == "true"

    # tipoDocumento (0034/R6): z.enum(TIPOS_DOCUMENTO).optional().
    tipo_documento = _qp_opt("tipoDocumento")
    if tipo_documento is not None and tipo_documento not in _TIPOS_DOCUMENTO:
        detalhes["tipoDocumento"] = _zod_enum_msg(_TIPOS_DOCUMENTO)

    # disciplinaId (0043): z.string().uuid("ID inválido").optional() — MESMO
    # tratamento de familiaId/operacaoId. É uuid e não código porque disciplina
    # é linha de catálogo, não enum: o ``<select>`` da tela é populado pelo
    # próprio catálogo (spec ONDA-4 §1g).
    disciplina_id = _qp_opt("disciplinaId")
    if disciplina_id is not None and not _UUID_ZOD_REGEX.match(disciplina_id):
        detalhes["disciplinaId"] = "ID inválido"

    # profissionalId (0043): idem — "documentos deste RT". O recorte por papel
    # NÃO sai daqui (ver ``_list_documentos``): a pré-seleção só junta ids.
    profissional_id = _qp_opt("profissionalId")
    if profissional_id is not None and not _UUID_ZOD_REGEX.match(profissional_id):
        detalhes["profissionalId"] = "ID inválido"

    # busca: z.string().max(200).optional()  ('' é válido — len 0 <= 200)
    busca = _qp_opt("busca")
    if busca is not None and len(busca) > 200:
        detalhes["busca"] = "Too big: expected string to have <=200 characters"

    # vencendoEm: z.coerce.number().int().min(1).max(365).optional()
    # '' presente-vazio → Number('')=0 → passa .int() → falha .min(1).
    vencendo_em_raw = _qp_opt("vencendoEm")
    vencendo_em: int | None = None
    if vencendo_em_raw is not None:
        v = _coerce_int(vencendo_em_raw)
        if isinstance(v, float) and math.isnan(v):
            detalhes["vencendoEm"] = "Invalid input: expected number, received NaN"
        elif v is _NOT_INT:
            detalhes["vencendoEm"] = "Invalid input: expected int, received number"
        elif v < 1:
            detalhes["vencendoEm"] = "Too small: expected number to be >=1"
        elif v > 365:
            detalhes["vencendoEm"] = "Too big: expected number to be <=365"
        else:
            vencendo_em = v

    # page: z.coerce.number().int().min(1).default(1)  (default só se AUSENTE)
    page_v = _coerce_int(_qp_def("page", "1"))
    page = 1
    if isinstance(page_v, float) and math.isnan(page_v):
        detalhes["page"] = "Invalid input: expected number, received NaN"
    elif page_v is _NOT_INT:
        detalhes["page"] = "Invalid input: expected int, received number"
    elif page_v < 1:
        detalhes["page"] = "Too small: expected number to be >=1"
    else:
        page = page_v

    # limit: z.coerce.number().int().min(1).max(500).default(50)  (default só ausente)
    limit_v = _coerce_int(_qp_def("limit", "50"))
    limit = 50
    if isinstance(limit_v, float) and math.isnan(limit_v):
        detalhes["limit"] = "Invalid input: expected number, received NaN"
    elif limit_v is _NOT_INT:
        detalhes["limit"] = "Invalid input: expected int, received number"
    elif limit_v < 1:
        detalhes["limit"] = "Too small: expected number to be >=1"
    elif limit_v > 500:
        detalhes["limit"] = "Too big: expected number to be <=500"
    else:
        limit = limit_v

    # order: z.enum([...]).default("validade")  (default só quando AUSENTE)
    order = _qp_def("order", "validade")
    if order not in _ORDER_COLS:
        detalhes["order"] = _zod_enum_msg(_ORDER_COLS)

    # dir: z.enum(["asc","desc"]).default("asc")  (default só quando AUSENTE)
    dir_f = _qp_def("dir", "asc")
    if dir_f not in _DIRS:
        detalhes["dir"] = _zod_enum_msg(_DIRS)

    if detalhes:
        return JSONResponse(
            status_code=400,
            content={"error": "Parâmetros inválidos", "detalhes": detalhes},
        )

    result = await _list_documentos(
        db,
        categoria=categoria,
        subcategoria=subcategoria,
        status=status_f,
        familia_id=familia_id,
        operacao_id=operacao_id,
        sem_operacao=sem_operacao,
        tipo_documento=tipo_documento,
        disciplina_id=disciplina_id,
        profissional_id=profissional_id,
        busca=busca,
        vencendo_em=vencendo_em,
        page=page,
        limit=limit,
        order=order,
        dir_=dir_f,
        role=user.role,
    )
    return JSONResponse(content=result)


def _zod_enum_msg(valores: tuple[str, ...]) -> str:
    """Mensagem do Zod v4 (4.4.3) p/ ``z.enum`` inválido/ausente.

    Formato EXATO observado no safeParse: ``Invalid option: expected one of
    "A"|"B"|"C"`` (aspas DUPLAS, sem espaço ao redor do ``|``, SEM sufixo
    ``, received X``). Idêntico p/ valor ausente (null/undefined), '' e string
    inválida — o code é ``invalid_value`` em todos os casos.
    """
    return "Invalid option: expected one of " + "|".join(f'"{v}"' for v in valores)


# 0043 (onda 4) — os dois filtros novos e o LEFT JOIN da disciplina, em
# constantes para o teste gêmeo poder conferi-los sem subir banco.
#
# ``CAST(:x AS uuid)`` e NUNCA ``:x::uuid``: o ``::`` colado no bind não compila
# no ``text()`` do SQLAlchemy (a nota já existe no filtro de operação).
_COND_DISCIPLINA_SQL = "d.disciplina_id = CAST(:disciplina_id AS uuid)"

# Pré-seleção de "documentos deste RT". NÃO leva predicado de restrito de
# propósito: ela só junta ids. Quem recorta é o ``restricao_visivel_sql`` que já
# é a PRIMEIRA condição do WHERE e vale nas DUAS queries (linhas e contagem) —
# sem isso o ``total`` denunciaria documento oculto.
_SQL_DOCS_DO_PROFISSIONAL = (
    "SELECT documento_id FROM profissional_documentos "
    "WHERE profissional_id = CAST(:profissional_id AS uuid)"
)

# LEFT (documento sem disciplina é a maioria; INNER faria sumir exatamente as
# linhas que a tela existe para completar) e 1:1 por FK — não multiplica linha,
# logo ``total`` não muda.
_DISCIPLINA_JOIN_SQL = "LEFT JOIN disciplinas disc ON disc.id = d.disciplina_id"
_DISCIPLINA_COLS_SQL = (
    "d.disciplina_id           AS disciplina_id,\n"
    "          disc.codigo              AS disciplina_codigo,\n"
    "          disc.nome                AS disciplina_nome"
)


def _disciplina_aninhada(
    disciplina_id, codigo, nome
) -> dict[str, str] | None:
    """As três colunas achatadas -> objeto aninhado ou ``None``.

    Mesmo desmonte que o ``map`` do Next faz para ``operacao``: documento sem
    disciplina sai com ``disciplina: null``, NÃO com um objeto de campos nulos.
    """
    if disciplina_id is None or codigo is None or nome is None:
        return None
    return {"id": str(disciplina_id), "codigo": codigo, "nome": nome}


async def _list_documentos(
    db,
    *,
    categoria: str | None,
    subcategoria: str | None,
    status: str | None,
    familia_id: str | None,
    operacao_id: str | None,
    sem_operacao: bool,
    tipo_documento: str | None,
    disciplina_id: str | None,
    profissional_id: str | None,
    busca: str | None,
    vencendo_em: int | None,
    page: int,
    limit: int,
    order: str,
    dir_: str,
    role: str,
) -> dict:
    """Réplica de ``listDocumentos`` (src/lib/conformidade/cofre/queries.ts).

    Mesmas condições (categoria/subcategoria/status/busca ilike/vencendoEm/familia/
    operacao), mesma coluna de ordenação, mesma paginação, e o MESMO objeto de
    retorno ``{data, total, page, limit, pages}``. ``data`` projeta os MESMOS
    aliases camelCase do ``.select({...})`` do Drizzle, incluindo
    ``uploadadoPorNome`` (LEFT JOIN users.nome) e o objeto aninhado ``operacao``
    (LEFT JOIN operacoes; ``null`` quando o documento não é de obra — é assim que
    o Drizzle devolve um objeto aninhado cujo join não casou).
    """
    conditions: list[str] = []
    params: dict[str, object] = {}

    # Predicado restrito (0034/S1 — regra única §3.2): SEMPRE presente, nas
    # DUAS queries (rows e count), para ``total``/``pages`` refletirem só o
    # visível — contagem nenhuma denuncia o oculto.
    conditions.append(restricao_visivel_sql("d"))
    params["is_conformidade"] = is_conformidade(role)

    if categoria:
        conditions.append("d.categoria = :categoria")
        params["categoria"] = categoria

    if subcategoria:
        conditions.append("d.subcategoria = :subcategoria")
        params["subcategoria"] = subcategoria

    if status:
        conditions.append("d.status = :status")
        params["status"] = status

    if operacao_id:
        # CAST(:x AS uuid) e não ``:x::uuid`` — o ``::`` colado no bind não
        # compila no text() do SQLAlchemy. O id já veio validado pelo regex de
        # uuid no handler, então o cast não pode explodir aqui.
        conditions.append("d.operacao_id = CAST(:operacao_id AS uuid)")
        params["operacao_id"] = operacao_id

    # 0034/R6 — fila de classificação: só os órfãos.
    if sem_operacao:
        conditions.append("d.operacao_id IS NULL")

    # 0034/R6 — filtro por tipo do dossiê.
    if tipo_documento:
        conditions.append("d.tipo_documento = :tipo_documento")
        params["tipo_documento"] = tipo_documento

    # 0043 — disciplina é coluna do PRÓPRIO documento (não da operação): entra
    # como igualdade simples e, por estar no WHERE compartilhado, vale nas duas
    # queries (linhas e contagem) sem nenhum cuidado extra.
    if disciplina_id:
        conditions.append(_COND_DISCIPLINA_SQL)
        params["disciplina_id"] = disciplina_id

    if busca:
        # ilike(titulo) OR ilike(descricao) OR ilike(numeroDocumento)
        params["busca"] = f"%{busca}%"
        conditions.append(
            "(d.titulo ILIKE :busca OR d.descricao ILIKE :busca "
            "OR d.numero_documento ILIKE :busca)"
        )

    if vencendo_em:
        # gte(validadeFim, now()) AND lt(validadeFim, now()+vencendoEm dias).
        # No Next o "agora" é new Date() (instante da request); usamos o mesmo
        # cálculo no app (não NOW() do banco) para paridade do limite superior.
        agora = datetime.now(tz=timezone.utc)
        limite = agora + timedelta(days=vencendo_em)
        params["venc_agora"] = agora
        params["venc_limite"] = limite
        conditions.append(
            "(d.validade_fim >= :venc_agora AND d.validade_fim < :venc_limite)"
        )

    # Filtro por família (N:N) — réplica do pré-select de documentos_familias.
    if familia_id:
        ids_rows = (
            await db.execute(
                text(
                    "SELECT documento_id FROM documentos_familias "
                    "WHERE familia_id = :familia_id"
                ),
                {"familia_id": familia_id},
            )
        ).mappings().all()
        ids = [str(r["documento_id"]) for r in ids_rows]
        if len(ids) == 0:
            # Early-return idêntico ao Next (lista vazia, pages 0).
            return {"data": [], "total": 0, "page": page, "limit": limit, "pages": 0}
        # inArray(documentosHabilitacao.id, ids) — expande em named params.
        ph = []
        for i, _id in enumerate(ids):
            key = f"famdoc_{i}"
            ph.append(f":{key}")
            params[key] = _id
        conditions.append(f"d.id IN ({', '.join(ph)})")

    # 0043 — "documentos deste RT": molde LITERAL do bloco de família acima,
    # inclusive o early-return de lista vazia (``pages`` 0). Combinado com
    # ``familiaId`` dá a INTERSEÇÃO: os dois ``IN`` são AND, e é esse o
    # comportamento certo.
    if profissional_id:
        prof_rows = (
            await db.execute(
                text(_SQL_DOCS_DO_PROFISSIONAL),
                {"profissional_id": profissional_id},
            )
        ).mappings().all()
        ids_prof = [str(r["documento_id"]) for r in prof_rows]
        if len(ids_prof) == 0:
            return {"data": [], "total": 0, "page": page, "limit": limit, "pages": 0}
        ph_prof = []
        for i, _id in enumerate(ids_prof):
            key = f"profdoc_{i}"
            ph_prof.append(f":{key}")
            params[key] = _id
        conditions.append(f"d.id IN ({', '.join(ph_prof)})")

    where_sql = (" WHERE " + " AND ".join(conditions)) if conditions else ""

    # orderCol: titulo|categoria|status|criado_em → senão validade_fim.
    order_col = {
        "titulo": "d.titulo",
        "categoria": "d.categoria",
        "status": "d.status",
        "criado_em": "d.criado_em",
    }.get(order, "d.validade_fim")
    order_dir = "DESC" if dir_ == "desc" else "ASC"
    offset = (page - 1) * limit

    lista_sql = text(
        f"""
        SELECT
          d.id                       AS id,
          d.categoria                AS categoria,
          d.subcategoria             AS subcategoria,
          d.titulo                   AS titulo,
          d.descricao                AS descricao,
          d.nome_arquivo             AS nome_arquivo,
          d.blob_url                 AS blob_url,
          d.content_type             AS content_type,
          d.tamanho_bytes            AS tamanho_bytes,
          d.numero_documento         AS numero_documento,
          d.emitido_em               AS emitido_em,
          d.validade_fim             AS validade_fim,
          d.validade_indeterminada   AS validade_indeterminada,
          d.status                   AS status,
          d.versao                   AS versao,
          -- 0044 (B6): a revisão da engenharia ("R0", "R1", "02A"), entre
          -- ``versao`` e ``tags`` — a posição do select do Drizzle
          -- (cofre/queries.ts:213). NÃO é ``versao`` (spec ONDA-5 §1h).
          d.revisao                  AS revisao,
          d.tags                     AS tags,
          d.ocr_confianca            AS ocr_confianca,
          d.uploadado_por            AS uploadado_por,
          u.nome                     AS uploadado_por_nome,
          d.criado_em                AS criado_em,
          d.atualizado_em            AS atualizado_em,
          d.operacao_id              AS operacao_id,
          d.papel                    AS papel,
          d.tipo_documento           AS tipo_documento,
          d.situacao_prova           AS situacao_prova,
          d.detentora                AS detentora,
          d.restrito                 AS restrito,
          d.import_job_id            AS import_job_id,
          o.id                       AS operacao_ref_id,
          o.codigo                   AS operacao_codigo,
          o.cliente_nome             AS operacao_cliente_nome,
          {_DISCIPLINA_COLS_SQL}
        FROM documentos_habilitacao d
        LEFT JOIN users u ON d.uploadado_por = u.id
        LEFT JOIN operacoes o ON o.id = d.operacao_id
        {_DISCIPLINA_JOIN_SQL}
        {where_sql}
        -- 0044 (D8): DESEMPATE por chave primária. O default é
        -- ``order=validade`` e ``validade_fim`` é NULL na maioria dos atestados
        -- — o critério empata em milhares de linhas e, com LIMIT/OFFSET, o
        -- Postgres não promete a mesma ordem entre duas execuções: a página 2
        -- repete linha da 1 e pula outra. Invisível com paginação numerada,
        -- evidente com a rolagem infinita da tela. ESPELHO OBRIGATÓRIO do
        -- ``.orderBy(orderFn(orderCol), asc(id))`` do Drizzle (cofre/queries.ts
        -- :254) — sem ele produção (BFF) e dev (Next) paginam DIFERENTE, e o bug
        -- que o D8 existe para matar volta onde ninguém olha (spec ONDA-5 §1b).
        -- Sem ``NULLS FIRST/LAST`` em lugar nenhum: os dois lados são Postgres e
        -- é o default (ASC → NULLS LAST) que os mantém iguais.
        ORDER BY {order_col} {order_dir}, d.id ASC
        LIMIT :limit OFFSET :offset
        """
    )
    lista_params = {**params, "limit": limit, "offset": offset}
    rows = (await db.execute(lista_sql, lista_params)).mappings().all()

    total_sql = text(
        f"SELECT count(*)::int AS total FROM documentos_habilitacao d {where_sql}"
    )
    total_row = (await db.execute(total_sql, params)).mappings().first()
    total = total_row["total"] if total_row and total_row["total"] is not None else 0

    data = [
        {
            "id": str(r["id"]),
            "categoria": r["categoria"],
            "subcategoria": r["subcategoria"],
            "titulo": r["titulo"],
            "descricao": r["descricao"],
            "nomeArquivo": r["nome_arquivo"],
            "blobUrl": r["blob_url"],
            "contentType": r["content_type"],
            "tamanhoBytes": r["tamanho_bytes"],
            "numeroDocumento": r["numero_documento"],
            "emitidoEm": _js_to_iso_string(r["emitido_em"]),
            "validadeFim": _js_to_iso_string(r["validade_fim"]),
            "validadeIndeterminada": r["validade_indeterminada"],
            "status": r["status"],
            "versao": r["versao"],
            # 0044 (B6): chave nova ENTRE ``versao`` e ``tags``, a MESMA posição
            # do select do Drizzle. ``null`` quando o documento não tem revisão.
            "revisao": r["revisao"],
            "tags": r["tags"],
            "ocrConfianca": r["ocr_confianca"],
            "uploadadoPor": str(r["uploadado_por"]) if r["uploadado_por"] is not None else None,
            "uploadadoPorNome": r["uploadado_por_nome"],
            "criadoEm": _js_to_iso_string(r["criado_em"]),
            "atualizadoEm": _js_to_iso_string(r["atualizado_em"]),
            # ── 0033: campos NOVOS (nada acima foi removido ou renomeado) ────
            "operacaoId": str(r["operacao_id"]) if r["operacao_id"] is not None else None,
            "papel": r["papel"],
            # Objeto aninhado montado no app (o Next também acha os três campos
            # no SELECT e aninha no map): documento sem operação sai com
            # ``operacao: null``, não com um objeto de campos nulos.
            "operacao": {
                "id": str(r["operacao_ref_id"]),
                "codigo": r["operacao_codigo"],
                "clienteNome": r["operacao_cliente_nome"],
            }
            if r["operacao_ref_id"] is not None
            else None,
            # ── 0034/R6: 5 chaves novas por item (depois de ``operacao``) ────
            "tipoDocumento": r["tipo_documento"],
            "situacaoProva": r["situacao_prova"],
            "detentora": r["detentora"],
            "restrito": r["restrito"],
            "importJobId": str(r["import_job_id"])
            if r["import_job_id"] is not None
            else None,
            # ── 0043: 2 chaves novas por item, no FIM (a mesma posição do
            # ``select`` do Drizzle: o id fica no topo do item e o objeto
            # aninhado é acrescentado pelo ``map``).
            "disciplinaId": str(r["disciplina_id"])
            if r["disciplina_id"] is not None
            else None,
            "disciplina": _disciplina_aninhada(
                r["disciplina_id"], r["disciplina_codigo"], r["disciplina_nome"]
            ),
        }
        for r in rows
    ]

    return {
        "data": data,
        "total": total,
        "page": page,
        "limit": limit,
        "pages": math.ceil(total / limit) if limit else 0,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Validações de arquivo (réplica de src/lib/storage/upload.ts)
# ══════════════════════════════════════════════════════════════════════════════

_TIPOS_PERMITIDOS = (
    "application/pdf",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/octet-stream",
)
_EXTENSOES_PERMITIDAS = (".pdf", ".xls", ".xlsx", ".doc", ".docx")


def _validar_tipo_arquivo(nome: str, content_type: str) -> tuple[bool, str | None]:
    """``validarTipoArquivo`` — MIME permitido OU extensão permitida."""
    partes = nome.split(".")
    ext = "." + (partes[-1].lower() if len(partes) > 1 else "")
    if content_type not in _TIPOS_PERMITIDOS and ext not in _EXTENSOES_PERMITIDAS:
        return False, "Tipo de arquivo não permitido. Use: PDF, XLS, XLSX, DOC ou DOCX."
    return True, None


def _validar_tamanho_arquivo(tamanho: int, max_mb: int = 50) -> tuple[bool, str | None]:
    """``validarTamanhoArquivo`` — limite em MB (default 50)."""
    max_bytes = max_mb * 1024 * 1024
    if tamanho > max_bytes:
        atual = tamanho / 1024 / 1024
        return (
            False,
            f"Arquivo muito grande. Máximo: {max_mb} MB. "
            f"Tamanho atual: {atual:.1f} MB.",
        )
    return True, None


def _validar_magic_bytes(buf: bytes) -> tuple[bool, str | None]:
    """``validarMagicBytes`` — assinatura PDF (%PDF) / ZIP (PK..) / OLE2."""
    b = buf[:8]
    is_pdf = len(b) >= 4 and b[0] == 0x25 and b[1] == 0x50 and b[2] == 0x44 and b[3] == 0x46
    is_zip = len(b) >= 4 and b[0] == 0x50 and b[1] == 0x4B and b[2] == 0x03 and b[3] == 0x04
    is_ole2 = len(b) >= 4 and b[0] == 0xD0 and b[1] == 0xCF and b[2] == 0x11 and b[3] == 0xE0
    if is_pdf or is_zip or is_ole2:
        return True, None
    return (
        False,
        "O conteúdo do arquivo não corresponde ao tipo declarado. "
        "Apenas PDF, XLS, XLSX, DOC e DOCX são permitidos.",
    )


def _sanitize_name(nome: str) -> str:
    """``sanitizeName`` de upload.ts (NFD, remove diacríticos, '..' → '_', etc.)."""
    import unicodedata

    n = unicodedata.normalize("NFD", nome)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    n = n.replace("..", "_")
    n = re.sub(r"[^a-zA-Z0-9._-]", "_", n)
    return n


# ══════════════════════════════════════════════════════════════════════════════
# Storage S3/MinIO (réplica de uploadHabilitacao / deleteDocumento via aioboto3)
# ══════════════════════════════════════════════════════════════════════════════


def _s3_object_url(key: str) -> str:
    """URL canônica path-style ``<endpoint>/<bucket>/<key>`` (getR2ObjectUrl)."""
    return f"{settings.s3_endpoint}/{settings.s3_bucket}/{key}"


async def _upload_habilitacao(
    body: bytes, categoria: str, subcategoria: str, nome_original: str, content_type: str
) -> dict:
    """Réplica de ``uploadHabilitacao`` — PUT no S3/MinIO (path-style).

    Key: ``habilitacao/<categoria>/<subcategoria>/<timestamp_ms>_<nome>``.
    Retorna ``{url, key, contentType, size}`` (mesmo UploadResult do Next).
    """
    import aioboto3

    nome_sanitizado = _sanitize_name(nome_original)
    timestamp = int(datetime.now(tz=timezone.utc).timestamp() * 1000)  # Date.now()
    key = f"habilitacao/{categoria}/{subcategoria}/{timestamp}_{nome_sanitizado}"
    ct = content_type or "application/octet-stream"

    session = aioboto3.Session()
    async with session.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="auto",
    ) as s3:
        await s3.put_object(
            Bucket=settings.s3_bucket, Key=key, Body=body, ContentType=ct
        )

    return {"url": _s3_object_url(key), "key": key, "contentType": ct, "size": len(body)}


async def _delete_documento(key_or_url: str) -> None:
    """Réplica de ``deleteDocumento`` — DELETE no S3/MinIO.

    Tolera key OU URL S3 completa (extrai a key da URL ``.../<bucket>/<key>``).
    """
    key = key_or_url
    m = re.search(r"r2\.cloudflarestorage\.com/[^/]+/(.+)$", key_or_url)
    if m:
        key = m.group(1)

    import aioboto3

    session = aioboto3.Session()
    async with session.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="auto",
    ) as s3:
        await s3.delete_object(Bucket=settings.s3_bucket, Key=key)


# ══════════════════════════════════════════════════════════════════════════════
# OCR (réplica de src/lib/conformidade/ocr.ts via app.services.anthropic)
# ══════════════════════════════════════════════════════════════════════════════

_SYSTEM_OCR = """Você é um especialista em documentos de habilitação para licitações da Petrobras no Brasil.

Examine o PDF anexo e extraia os metadados estruturados.

Responda EXATAMENTE em JSON válido (sem markdown, sem ```):
{
  "numero_documento": "número/código do documento ou null",
  "emitido_em": "YYYY-MM-DD ou null",
  "validade_fim": "YYYY-MM-DD ou null (data de vencimento/validade)",
  "validade_indeterminada": true ou false (true se o documento não tem prazo formal — ex: contrato social, CREA-PJ vitalício),
  "texto_resumo": "1-2 frases descrevendo o conteúdo do documento",
  "confianca": 0.0 a 1.0 (sua confiança nos dados extraídos)
}

REGRAS:
- "validade_fim" é a data até quando o documento é válido. Para CNDs e certidões, geralmente é 6 meses após emissão.
- Para ISO/NRs, é a data de fim de vigência do certificado.
- Se for um contrato social ou ato constitutivo SEM prazo, marque "validade_indeterminada": true e deixe "validade_fim": null.
- Se não conseguir identificar, retorne null no campo (não invente).
- Datas devem estar no formato ISO YYYY-MM-DD (ex: "2026-08-12")."""


# ── Redação de PII (LGPD) ─────────────────────────────────────────────────────
# ocr_texto é um RESUMO de exibição; antes de gravar (e mesmo antes de ser exposto
# na resposta) removemos CPF (formatado ou 11 dígitos “nus”) e e-mails. Espelha a
# redação aplicada ao legado pela migration 0016.
# ⚠️ A VERSÃO ANTERIOR DESTE REDATOR ESTRAGAVA NÚMERO DE ART (já corrigido).
# Ela usava `(?<!\d)\d{11}(?!\d)`, cujo lookbehind exclui só DÍGITO — então
# "ART BA12345678901" virava "ART BA[CPF-REMOVIDO]". ART é um tipo de documento
# muito frequente e o número é justamente o que se busca numa habilitação.
# O módulo _pii exige fronteira ALFANUMÉRICA e valida o dígito verificador,
# o que evita essa classe de falso positivo.
_redigir_pii = redigir_pii


def _parse_ocr_date(v) -> datetime | None:
    """``parseDate`` do ocr.ts: aceita só 'YYYY-MM-DD', interpreta como meia-noite UTC."""
    if not v or not isinstance(v, str):
        return None
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", v)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc)
    except ValueError:
        return None


async def _extrair_metadados_documento(
    pdf_bytes: bytes, categoria: str, subcategoria: str
) -> dict:
    """Réplica de ``extrairMetadadosDocumento`` (Haiku via vision/document).

    Mesmo system cacheável, mesma message (document base64 + texto de contexto),
    parse tolerante de JSON, mesmas chaves de saída camelCase. Lança em truncamento
    (``stop_reason == "max_tokens"``), como o Next.
    """
    import base64

    from app.services.anthropic import get_client

    # Trava de IA (services/anthropic.py): "ocr-conformidade" está BLOQUEADO e NÃO tem
    # fallback — get_client() LANÇA aqui, igual ao ocr.ts do Next. Intencional: sem IA
    # não há metadados extraídos, então a feature falha alto em vez de inventar dados.
    client = get_client("ocr-conformidade")
    b64 = base64.b64encode(pdf_bytes).decode("ascii")

    message = await client.messages.create(
        model=settings.anthropic_model_haiku,
        max_tokens=1024,
        system=[
            {"type": "text", "text": _SYSTEM_OCR, "cache_control": {"type": "ephemeral"}}
        ],
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            f"Contexto do documento — categoria: {categoria}, "
                            f"subcategoria: {subcategoria}. Extraia os metadados do "
                            "PDF acima conforme as instruções."
                        ),
                    },
                ],
            }
        ],
    )

    if message.stop_reason == "max_tokens":
        raise RuntimeError("Resposta de OCR truncada (max_tokens).")

    texto = ""
    for b in message.content:
        if getattr(b, "type", None) == "text":
            texto = b.text
            break

    cleaned = texto.replace("```json", "").rstrip()
    if cleaned.endswith("```"):
        cleaned = cleaned[: -3]
    cleaned = cleaned.strip()
    parsed: dict = {}
    try:
        parsed = json.loads(cleaned)
    except Exception:
        start2 = cleaned.find("{")
        if start2 >= 0:
            depth = 0
            for i in range(start2, len(cleaned)):
                if cleaned[i] == "{":
                    depth += 1
                elif cleaned[i] == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            parsed = json.loads(cleaned[start2 : i + 1])
                        except Exception:
                            pass
                        break
    if not isinstance(parsed, dict):
        parsed = {}

    nd = parsed.get("numero_documento")
    tr = parsed.get("texto_resumo")
    conf = parsed.get("confianca")
    return {
        "numeroDocumento": nd if isinstance(nd, str) else None,
        "emitidoEm": _parse_ocr_date(parsed.get("emitido_em")),
        "validadeFim": _parse_ocr_date(parsed.get("validade_fim")),
        "validadeIndeterminada": parsed.get("validade_indeterminada") is True,
        "textoResumo": tr if isinstance(tr, str) else "",
        "ocrConfianca": conf if isinstance(conf, (int, float)) and not isinstance(conf, bool) else 0.5,
    }


# ══════════════════════════════════════════════════════════════════════════════
# POST — upload multipart + criação do registro (== handler POST do route.ts)
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/api/conformidade/cofre/documentos")
async def post_documento(
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
):
    """Upload (multipart/form-data) + criação do registro (paridade 1:1).

    Ordem das checagens (igual ao Next):
      1. requireAuth() → 401 sem sessão (via get_current_user).
      2. podeGerenciarDocumentosHabilitacao(role) → 403 ``Permissão negada``.
      3. parse multipart → 400 ``Esperado multipart/form-data`` se falhar.
      4. file obrigatório → 422 ``Arquivo é obrigatório``.
      5. tipo/tamanho(50MB)/magic-bytes → 422 com a mensagem do validador.
      6. CriarDocumentoSchema → 422 ``Dados inválidos`` + detalhes.
      7. sha256 do conteúdo → duplicata no cofre e ``permitirDuplicata != "true"``
         → 409 ``{"error":"Arquivo já está no cofre","documentoId","titulo"}``
         (ANTES do OCR e do upload: recusar depois deixaria blob órfão no MinIO
         e ainda pagaria a chamada de OCR por um arquivo repetido).
      8. OCR opt-in (best-effort) → upload S3 → INSERT → audit_log.
      9. 201 com o REGISTRO inserido cru.
    """
    # (2) Gate de papel — após auth, com a MENSAGEM e o status do Next.
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # (3) multipart/form-data.
    try:
        form = await request.form()
    except Exception:
        return JSONResponse(
            status_code=400, content={"error": "Esperado multipart/form-data"}
        )

    # (3b/0034 — gate 4 do R7) restrito é flag de multipart ("true"/"1", mesmo
    # padrão de validadeIndeterminada — NÃO passa pelo zod) e só Conformidade
    # pode marcá-la. O gate vem ANTES das validações de arquivo DE PROPÓSITO:
    # permissão antes de validação (a paridade compara qual erro sai quando os
    # dois defeitos coexistem). 403 SEM ``code`` (checagem inline).
    restrito_raw = form.get("restrito")
    restrito = restrito_raw == "true" or restrito_raw == "1"
    if restrito and not _is_conformidade(user.role):
        return JSONResponse(
            status_code=403,
            content={"error": "Apenas Conformidade pode alterar a restrição de acesso"},
        )

    # (4) file obrigatório (deve ser um arquivo, não um campo de texto).
    file = form.get("file")
    # Starlette: UploadFile p/ arquivos; str p/ campos de texto.
    if file is None or not hasattr(file, "read") or not hasattr(file, "filename"):
        return JSONResponse(status_code=422, content={"error": "Arquivo é obrigatório"})

    file_name = file.filename or ""
    content_type = file.content_type or ""
    file_bytes = await file.read()
    file_size = len(file_bytes)

    # (5a) tipo de arquivo.
    ok, erro = _validar_tipo_arquivo(file_name, content_type)
    if not ok:
        return JSONResponse(status_code=422, content={"error": erro})

    # (5b) tamanho (50 MB).
    ok, erro = _validar_tamanho_arquivo(file_size, 50)
    if not ok:
        return JSONResponse(status_code=422, content={"error": erro})

    # (5c) magic bytes (primeiros 8 do conteúdo).
    ok, erro = _validar_magic_bytes(file_bytes)
    if not ok:
        return JSONResponse(status_code=422, content={"error": erro})

    # ── tags: JSON-stringified de string[] (filtra não-strings, ignora erro) ──
    tags_raw = form.get("tags")
    tags: list[str] | None = None
    if isinstance(tags_raw, str) and len(tags_raw) > 0:
        try:
            parsed_tags = json.loads(tags_raw)
            if isinstance(parsed_tags, list):
                tags = [t for t in parsed_tags if isinstance(t, str)]
        except Exception:
            pass

    # validadeIndeterminada: "true" | "1" → True.
    vi_raw = form.get("validadeIndeterminada")
    validade_indeterminada = vi_raw == "true" or vi_raw == "1"

    # ── CriarDocumentoSchema.safeParse({...}) ────────────────────────────────
    detalhes: dict[str, str] = {}

    def _form_str(k: str):
        """``formData.get(k)`` (str ou None); '' permanece '' (não vira None)."""
        v = form.get(k)
        return v if isinstance(v, str) else None

    # categoria/subcategoria: z.enum(...). No multipart, formData.get(k) devolve
    # null quando a chave falta; o Zod v4 reporta o MESMO "Invalid option:
    # expected one of ..." (code invalid_value) p/ ausente (null), undefined e
    # string inválida — sem distinguir o valor recebido na mensagem.
    categoria = _form_str("categoria")
    if categoria is None or categoria not in _CATEGORIAS:
        detalhes["categoria"] = _zod_enum_msg(_CATEGORIAS)

    subcategoria = _form_str("subcategoria")
    if subcategoria is None or subcategoria not in _SUBCATEGORIAS:
        detalhes["subcategoria"] = _zod_enum_msg(_SUBCATEGORIAS)

    titulo = _form_str("titulo")
    if titulo is None:
        # z.string() ausente: "Invalid input: expected string, received undefined".
        detalhes["titulo"] = "Invalid input: expected string, received undefined"
    elif len(titulo) < 2:
        detalhes["titulo"] = "Título muito curto"
    elif len(titulo) > 200:
        detalhes["titulo"] = "Título muito longo"

    # descricao: formData.get('descricao') || undefined  (string vazia → undefined)
    descricao = _form_str("descricao") or None
    if descricao is not None and len(descricao) > 2000:
        detalhes["descricao"] = "Too big: expected string to have <=2000 characters"

    numero_documento = _form_str("numeroDocumento") or None
    if numero_documento is not None and len(numero_documento) > 100:
        detalhes["numeroDocumento"] = "Too big: expected string to have <=100 characters"

    # 0044 (B6) — revisao: ``formData.get("revisao") || undefined`` + zod
    # ``z.string().trim().max(20, "Revisão muito longa")``. Três detalhes que
    # mudam a resposta e foram medidos executando o schema real (zod v4.4.3):
    #   1. o ``.trim()`` roda ANTES do ``.max()`` — quem decide o 422 é o tamanho
    #      JÁ aparado, e " R1 " (4 caracteres) passa;
    #   2. o valor que segue para o INSERT é o APARADO ("R1"), não o do form;
    #   3. a mensagem é CUSTOM em pt-BR, diferente dos irmãos acima.
    # O campo ENTRA no INSERT (``revisao: data.revisao ?? null`` do Next): sem
    # isso a revisão digitada no upload seria validada e jogada fora, e o 201
    # sairia com ``revisao: null`` mesmo com o carimbo preenchido. O OCR NÃO a
    # preenche — revisão é carimbo de engenharia, não metadado de certidão.
    revisao_form = _form_str("revisao") or None
    revisao_final = revisao_form.strip() if revisao_form is not None else None
    if revisao_final is not None and len(revisao_final) > 20:
        detalhes["revisao"] = "Revisão muito longa"

    emitido_em = _form_str("emitidoEm") or None
    if emitido_em is not None and not _ZOD_DATETIME_REGEX.match(emitido_em):
        detalhes["emitidoEm"] = _MSG_DATETIME

    validade_fim = _form_str("validadeFim") or None
    if validade_fim is not None and not _ZOD_DATETIME_REGEX.match(validade_fim):
        detalhes["validadeFim"] = _MSG_DATETIME

    # status: formData.get('status') || "VIGENTE"  (default literal)
    status_v = _form_str("status") or "VIGENTE"
    if status_v not in _STATUS_DOC:
        detalhes["status"] = _zod_enum_msg(_STATUS_DOC)

    # tags: z.array(z.string().max(50)).max(50).optional()
    if tags is not None:
        if len(tags) > 50:
            detalhes["tags"] = "Too big: expected array to have <=50 items"
        else:
            for i, t in enumerate(tags):
                if len(t) > 50:
                    detalhes[f"tags.{i}"] = "Too big: expected string to have <=50 characters"

    # ── Campos do cofre por operação (0033), todos OPCIONAIS ─────────────────
    # operacaoId: formData.get('operacaoId') || undefined → '' vira undefined
    # (campo vazio no form NÃO é erro de uuid, é ausência).
    operacao_id = _form_str("operacaoId") or None
    if operacao_id is not None and not _UUID_ZOD_REGEX.match(operacao_id):
        detalhes["operacaoId"] = "ID inválido"

    # papel: formData.get('papel') || undefined → z.enum(PAPEIS_DOCUMENTO).optional()
    papel = _form_str("papel") or None
    if papel is not None and papel not in _PAPEIS:
        detalhes["papel"] = _zod_enum_msg(_PAPEIS)

    # ── Campos do dossiê (0034/R7), todos OPCIONAIS — '' vira ausência, como
    # nos irmãos do 0033 (formData.get(...) || undefined). ────────────────────
    tipo_documento = _form_str("tipoDocumento") or None
    if tipo_documento is not None and tipo_documento not in _TIPOS_DOCUMENTO:
        detalhes["tipoDocumento"] = _zod_enum_msg(_TIPOS_DOCUMENTO)

    situacao_prova = _form_str("situacaoProva") or None
    if situacao_prova is not None and situacao_prova not in _SITUACOES_PROVA:
        detalhes["situacaoProva"] = _zod_enum_msg(_SITUACOES_PROVA)

    detentora = _form_str("detentora") or None
    if detentora is not None and detentora not in _DETENTORAS:
        detalhes["detentora"] = _zod_enum_msg(_DETENTORAS)

    # 0043 — disciplinaId: formData.get('disciplinaId') || undefined → '' vira
    # ausência (campo vazio no form NÃO é uuid inválido), e a FORMA é uuid.
    disciplina_id = _form_str("disciplinaId") or None
    if disciplina_id is not None and not _UUID_ZOD_REGEX.match(disciplina_id):
        detalhes["disciplinaId"] = "ID inválido"

    if detalhes:
        return JSONResponse(
            status_code=422, content={"error": "Dados inválidos", "detalhes": detalhes}
        )

    # ── A operação precisa EXISTIR (0033) ────────────────────────────────────
    # Espelha o mesmo gate do Next (documentos/route.ts): o regex de uuid acima
    # só diz que o formato é válido. Um uuid bem formado que não está em
    # ``operacoes`` — operação apagada entre abrir o seletor e enviar, ou id
    # colado à mão — estouraria a FK ``fk_doch_operacao`` lá no INSERT, com o
    # blob JÁ no MinIO (órfão) e um 500 no lugar de um 422 explicável.
    # 0034/R7: o SELECT traz a ``detentora`` da operação — sem detentora
    # explícita no form, o documento HERDA a da operação resolvida (§7.3).
    operacao_detentora: str | None = None
    if operacao_id:
        op_row = (
            await db.execute(
                text(
                    "SELECT detentora FROM operacoes "
                    "WHERE id = CAST(:operacao_id AS uuid)"
                ),
                {"operacao_id": operacao_id},
            )
        ).mappings().first()
        if op_row is None:
            return JSONResponse(
                status_code=422,
                content={
                    "error": "Dados inválidos",
                    "detalhes": {"operacaoId": "Operação não encontrada"},
                },
            )
        operacao_detentora = op_row["detentora"]

    # ── A disciplina precisa EXISTIR (0043) ──────────────────────────────────
    # Espelha ``conferirDisciplina(data.disciplinaId)`` do Next, no MESMO ponto:
    # depois do gate da operação e ANTES do sha256/OCR/upload. Com a FK
    # ``fk_doch_disciplina`` da 0043, um uuid bem formado que não está em
    # ``disciplinas`` estouraria 23503 no INSERT — 500, e com o blob já órfão no
    # MinIO. 422 no campo é a resposta honesta (spec ONDA-4 §1a).
    if disciplina_id:
        disc_row = (
            await db.execute(
                text(
                    "SELECT id FROM disciplinas "
                    "WHERE id = CAST(:disciplina_id AS uuid) LIMIT 1"
                ),
                {"disciplina_id": disciplina_id},
            )
        ).mappings().first()
        if disc_row is None:
            return JSONResponse(
                status_code=422,
                content={
                    "error": "Dados inválidos",
                    "detalhes": {"disciplinaId": "Disciplina não encontrada"},
                },
            )

    # ── SHA-256 do conteúdo + recusa de duplicata (0033) ─────────────────────
    # O hash sai daqui de cima (antes era calculado só depois do upload) porque
    # é ele que decide se o arquivo entra: subir o blob e só então recusar
    # deixaria lixo órfão no MinIO. ``permitirDuplicata`` é o escape consciente
    # do usuário ("é a mesma prova, quero as duas cópias mesmo assim"), lido como
    # flag de multipart igual ao ``validadeIndeterminada``: "true" ou "1".
    sha256 = hashlib.sha256(file_bytes).hexdigest()
    permitir_duplicata_raw = form.get("permitirDuplicata")
    permitir_duplicata = (
        permitir_duplicata_raw == "true" or permitir_duplicata_raw == "1"
    )

    if not permitir_duplicata:
        # ORDER BY criado_em, id (== getDocumentoPorSha256): com o mesmo arquivo
        # subido duas vezes, quem responde é sempre o MAIS ANTIGO — é o registro
        # que o usuário deve reaproveitar, e o ``id`` torna a ordem total.
        dup = (
            await db.execute(
                text(
                    "SELECT id, titulo, restrito FROM documentos_habilitacao "
                    "WHERE sha256 = :sha256 "
                    "ORDER BY criado_em ASC, id ASC LIMIT 1"
                ),
                {"sha256": sha256},
            )
        ).mappings().first()
        if dup is not None:
            # 0034 (§3.2): duplicata de documento RESTRITO não vaza o título a
            # papel fora de Conformidade — ``documentoId`` fica (o uploader
            # precisa saber que é duplicata, como no R5/verificar), ``titulo``
            # sai cego (null). Espelho exato do route.ts.
            cegar = dup["restrito"] and not _is_conformidade(user.role)
            return JSONResponse(
                status_code=409,
                content={
                    "error": "Arquivo já está no cofre",
                    "documentoId": str(dup["id"]),
                    "titulo": None if cegar else dup["titulo"],
                },
            )

    # ── OCR opt-in (best-effort; não derruba o upload se falhar) ─────────────
    # LGPD/DPIA: o envio do PDF à Anthropic só ocorre se o gate
    # ORGANIZACIONAL settings.ocr_ia_enabled (env OCR_IA_ENABLED) estiver ligado.
    # Default conservador = desligado -> não vaza PII à Anthropic sem DPA/DPO. Com
    # a flag desligada o upload segue SEM metadados de OCR (degrade gracioso).
    ocr_flag = form.get("ocr") == "true" or form.get("ocr") == "1"
    ocr_meta: dict = {}
    if ocr_flag and content_type == "application/pdf":
        if not settings.ocr_ia_enabled:
            print(
                "[upload-cofre] OCR solicitado mas OCR_IA_ENABLED=0 (LGPD/DPIA): "
                "upload segue sem enviar o PDF à Anthropic."
            )
        else:
            try:
                r = await _extrair_metadados_documento(file_bytes, categoria, subcategoria)
                # Só sobrescreve campos que o usuário NÃO preencheu (?? do Next).
                ocr_meta = {
                    "numeroDocumento": numero_documento
                    if numero_documento is not None
                    else r["numeroDocumento"],
                    "emitidoEm": _parse_iso_dt(emitido_em) if emitido_em else r["emitidoEm"],
                    "validadeFim": _parse_iso_dt(validade_fim)
                    if validade_fim
                    else r["validadeFim"],
                    "validadeIndeterminada": validade_indeterminada or r["validadeIndeterminada"],
                    # Redige CPF/e-mail do resumo antes de gravar/expor (LGPD).
                    "ocrTexto": _redigir_pii(r["textoResumo"]),
                    "ocrConfianca": r["ocrConfianca"],
                }
            except Exception as e:  # noqa: BLE001 — segue sem meta (igual ao Next)
                print(f"[upload-cofre] OCR falhou (segue sem meta): {e}")

    # ── Upload S3/MinIO (path habilitacao/<cat>/<sub>/<ts>_<nome>) ───────────
    upload = await _upload_habilitacao(
        file_bytes, categoria, subcategoria, file_name, content_type
    )

    # ── Valores finais (réplica EXATA do .values({...}) do Drizzle) ──────────
    # ocrMeta.X ?? data.X ?? null  /  ocrMeta.X ?? (data.X ? new Date : null)
    final_numero = ocr_meta.get("numeroDocumento")
    if final_numero is None:
        final_numero = numero_documento  # já é None se vazio

    final_emitido = ocr_meta.get("emitidoEm")
    if final_emitido is None:
        final_emitido = _parse_iso_dt(emitido_em) if emitido_em else None

    final_validade = ocr_meta.get("validadeFim")
    if final_validade is None:
        final_validade = _parse_iso_dt(validade_fim) if validade_fim else None

    # validadeIndeterminada: ocrMeta.validadeIndeterminada ?? data.validadeIndeterminada
    final_vi = ocr_meta.get("validadeIndeterminada")
    if final_vi is None:
        final_vi = validade_indeterminada

    final_ocr_texto = ocr_meta.get("ocrTexto")  # ?? null
    final_ocr_conf = ocr_meta.get("ocrConfianca")  # ?? null

    insert_sql = text(
        """
        INSERT INTO documentos_habilitacao (
          categoria, subcategoria, titulo, descricao, operacao_id, papel,
          tipo_documento, situacao_prova, detentora, restrito, disciplina_id,
          nome_arquivo, blob_url, blob_key, tamanho_bytes, content_type, sha256,
          numero_documento, revisao, emitido_em, validade_fim, validade_indeterminada,
          status, tags, ocr_texto, ocr_confianca,
          uploadado_por, atualizado_por
        ) VALUES (
          :categoria, :subcategoria, :titulo, :descricao,
          CAST(:operacao_id AS uuid), :papel,
          :tipo_documento, :situacao_prova, :detentora, :restrito,
          CAST(:disciplina_id AS uuid),
          :nome_arquivo, :blob_url, :blob_key, :tamanho_bytes, :content_type, :sha256,
          :numero_documento, :revisao, :emitido_em, :validade_fim, :validade_indeterminada,
          :status, CAST(:tags AS jsonb), :ocr_texto, :ocr_confianca,
          :uploadado_por, :atualizado_por
        )
        RETURNING
          id, categoria, subcategoria, titulo, descricao, operacao_id, papel,
          tipo_documento, situacao_prova, detentora, restrito,
          import_job_id, disciplina_id, origem_path,
          nome_arquivo, blob_url, blob_key, tamanho_bytes, content_type, sha256,
          numero_documento, emitido_em, validade_fim, validade_indeterminada,
          status, versao, revisao, documento_anterior_id,
          ocr_texto, ocr_metadata, ocr_confianca, tags,
          uploadado_por, atualizado_por, criado_em, atualizado_em
        """
    )
    insert_params = {
        "categoria": categoria,
        "subcategoria": subcategoria,
        "titulo": titulo,
        "descricao": descricao or None,
        # CAST(:x AS uuid) e não ``:x::uuid`` (o ``::`` colado no bind não
        # compila no text()); None permanece NULL = prova solta, sem obra.
        "operacao_id": operacao_id,
        "papel": papel,
        # ── 0034/R7 ─────────────────────────────────────────────────────────
        "tipo_documento": tipo_documento,
        "situacao_prova": situacao_prova,
        # sem detentora explícita, herda a da operação resolvida; senão NULL.
        "detentora": detentora if detentora is not None else operacao_detentora,
        "restrito": restrito,
        # 0043: NULL quando o upload não declara disciplina.
        "disciplina_id": disciplina_id,
        # import_job_id e origem_path: NULL no upload de tela (são do pipeline,
        # R13) — nem entram no INSERT; o RETURNING os devolve como NULL.
        "nome_arquivo": file_name,
        "blob_url": upload["url"],
        "blob_key": upload["key"],
        "tamanho_bytes": upload["size"],
        "content_type": upload["contentType"],
        "sha256": sha256,
        "numero_documento": final_numero,
        # 0044 (B6): o valor já APARADO pelo trim do zod; None quando o campo
        # veio vazio (o ``|| undefined`` do Next faz string vazia virar ausência).
        "revisao": revisao_final,
        "emitido_em": final_emitido,
        "validade_fim": final_validade,
        "validade_indeterminada": final_vi,
        "status": status_v,
        "tags": json.dumps(tags) if tags is not None else None,
        "ocr_texto": final_ocr_texto,
        "ocr_confianca": final_ocr_conf,
        "uploadado_por": user.id,
        "atualizado_por": user.id,
    }
    novo = (await db.execute(insert_sql, insert_params)).mappings().first()

    # ── audit_log (mesmo payload de detalhes do Next) ────────────────────────
    # No Next: db.insert(auditLog).values({ userId, acao:
    # "UPLOAD_DOCUMENTO_HABILITACAO", entidade: "documento_habilitacao",
    # entidadeId: novo.id, detalhes: { categoria, subcategoria, titulo,
    # validadeFim } }). Mesma sessão 'db' (acompanha a transação); commit é do
    # handler (registrar_audit é best-effort e NÃO faz commit próprio).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="UPLOAD_DOCUMENTO_HABILITACAO",
        entidade="documento_habilitacao",
        entidade_id=str(novo["id"]),
        detalhes={
            "categoria": novo["categoria"],
            "subcategoria": novo["subcategoria"],
            "titulo": novo["titulo"],
            # No Next, novo.validadeFim é Date|null → serializado
            # .toISOString()|null no JSONB. Mesma representação string ISO/null.
            "validadeFim": _js_to_iso_string(novo["validade_fim"]),
            # 0033: sem isto a auditoria não responde "quem ligou esta prova a
            # esta obra".
            "operacaoId": str(novo["operacao_id"])
            if novo["operacao_id"] is not None
            else None,
            "papel": novo["papel"],
            # 0034/R7 (§7.5): o dossiê entra na trilha. Proibido: ocrTexto.
            "tipoDocumento": novo["tipo_documento"],
            "situacaoProva": novo["situacao_prova"],
            "detentora": novo["detentora"],
            "restrito": novo["restrito"],
        },
    )

    await db.commit()

    # ── 201 com o REGISTRO inserido cru (NextResponse.json(novo, {status:201})) ─
    body = {
        "id": str(novo["id"]),
        "categoria": novo["categoria"],
        "subcategoria": novo["subcategoria"],
        "titulo": novo["titulo"],
        "descricao": novo["descricao"],
        # 0033: o ``.returning()`` do Drizzle devolve TODAS as colunas da tabela,
        # então as duas novas entram no corpo do 201 na posição que ocupam no
        # pgTable (logo depois de descricao).
        "operacaoId": str(novo["operacao_id"]) if novo["operacao_id"] is not None else None,
        "papel": novo["papel"],
        # 0034: as 6 colunas do dossiê vêm logo depois de ``papel`` no pgTable
        # (schema.ts:1113-1121) — mesma posição no corpo do 201.
        "tipoDocumento": novo["tipo_documento"],
        "situacaoProva": novo["situacao_prova"],
        "detentora": novo["detentora"],
        "restrito": novo["restrito"],
        "importJobId": str(novo["import_job_id"]) if novo["import_job_id"] is not None else None,
        # 0043: a coluna nova fica ENTRE import_job_id e origem_path no pgTable
        # (schema.ts:1182-1187), e o ``.returning()`` do Drizzle devolve nessa
        # ordem — o corpo do 201 repete a posição.
        "disciplinaId": str(novo["disciplina_id"]) if novo["disciplina_id"] is not None else None,
        "origemPath": novo["origem_path"],
        "nomeArquivo": novo["nome_arquivo"],
        "blobUrl": novo["blob_url"],
        "blobKey": novo["blob_key"],
        "tamanhoBytes": novo["tamanho_bytes"],
        "contentType": novo["content_type"],
        "sha256": novo["sha256"],
        "numeroDocumento": novo["numero_documento"],
        "emitidoEm": _js_to_iso_string(novo["emitido_em"]),
        "validadeFim": _js_to_iso_string(novo["validade_fim"]),
        "validadeIndeterminada": novo["validade_indeterminada"],
        "status": novo["status"],
        "versao": novo["versao"],
        # 0044 (B6): o ``.returning()`` do Drizzle devolve TODAS as colunas, e
        # ``revisao`` fica ENTRE ``versao`` e ``documento_anterior_id`` no
        # pgTable (schema.ts:1217) — mesma posição no corpo do 201.
        "revisao": novo["revisao"],
        "documentoAnteriorId": str(novo["documento_anterior_id"])
        if novo["documento_anterior_id"] is not None
        else None,
        "ocrTexto": novo["ocr_texto"],
        "ocrMetadata": novo["ocr_metadata"],
        "ocrConfianca": novo["ocr_confianca"],
        "tags": novo["tags"],
        "uploadadoPor": str(novo["uploadado_por"]) if novo["uploadado_por"] is not None else None,
        "atualizadoPor": str(novo["atualizado_por"]) if novo["atualizado_por"] is not None else None,
        "criadoEm": _js_to_iso_string(novo["criado_em"]),
        "atualizadoEm": _js_to_iso_string(novo["atualizado_em"]),
    }
    return JSONResponse(status_code=201, content=body)


def _parse_iso_dt(value: str) -> datetime | None:
    """Réplica de ``new Date(isoString)`` (Drizzle grava como timestamptz).

    O Next constrói o ``Date`` a partir da string ISO 8601 já validada pelo Zod
    (``.datetime()``). Convertemos para ``datetime`` aware (UTC) para o INSERT.
    """
    if not value:
        return None
    s = value
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ══════════════════════════════════════════════════════════════════════════════
# DELETE — exclusão em massa (somente ADMIN) (== handler DELETE do route.ts)
# ══════════════════════════════════════════════════════════════════════════════


@router.delete("/api/conformidade/cofre/documentos")
async def delete_documentos(
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
):
    """Exclusão em massa de documentos (somente ADMIN) — paridade 1:1.

    Ordem:
      1. requireAuth() → 401 sem sessão.
      2. podeExcluirDocumentoHabilitacao(role) → 403 ``Somente administradores...``.
      3. body ``{ids: string[]}`` (parse tolerante; default {}). ids filtra
         não-strings; vazio → 400; > 100 → 400.
      4. SELECT (id, blob_key, titulo) IN ids → apaga blobs best-effort (allSettled)
         → DELETE ... RETURNING id (cascata no DB) → audit_log.
      5. 200 ``{ok:true, apagados, blobsApagados}``.
    """
    # (2) Gate ADMIN.
    if not _pode_excluir_documento_habilitacao(user.role):
        return JSONResponse(
            status_code=403,
            content={"error": "Somente administradores podem excluir documentos"},
        )

    # (3) body tolerante: try { body = await request.json() } catch {}.
    body: dict = {}
    try:
        parsed = await request.json()
        if isinstance(parsed, dict):
            body = parsed
    except Exception:
        pass

    raw_ids = body.get("ids")
    ids = [x for x in raw_ids if isinstance(x, str)] if isinstance(raw_ids, list) else []
    if len(ids) == 0:
        return JSONResponse(status_code=400, content={"error": "Body deve ter ids: string[]"})
    if len(ids) > 100:
        return JSONResponse(status_code=400, content={"error": "Máximo 100 IDs por chamada"})

    # (4a) Busca docs (id, blob_key, titulo) IN ids — captura keys antes de apagar.
    ph = []
    sel_params: dict[str, object] = {}
    for i, _id in enumerate(ids):
        key = f"id_{i}"
        ph.append(f":{key}")
        sel_params[key] = _id
    in_clause = ", ".join(ph)

    docs = (
        await db.execute(
            text(
                f"SELECT id, blob_key, titulo FROM documentos_habilitacao "
                f"WHERE id IN ({in_clause})"
            ),
            sel_params,
        )
    ).mappings().all()

    # (4b) Apaga blobs em paralelo, best-effort (Promise.allSettled).
    import asyncio

    resultados = await asyncio.gather(
        *[_delete_documento(d["blob_key"]) for d in docs], return_exceptions=True
    )
    blobs_apagados = sum(1 for r in resultados if not isinstance(r, Exception))

    # (4c) Apaga registros (cascata em vínculos/projetos/alertas) RETURNING id.
    apagados_rows = (
        await db.execute(
            text(
                f"DELETE FROM documentos_habilitacao WHERE id IN ({in_clause}) "
                f"RETURNING id"
            ),
            sel_params,
        )
    ).mappings().all()
    apagados_ids = [str(r["id"]) for r in apagados_rows]

    # (4d) audit_log (entidadeId NULL; detalhes com ids/titulos/blobsApagados).
    # No Next: db.insert(auditLog).values({ userId, acao:
    # "BULK_DELETE_DOCUMENTOS_HABILITACAO", entidade: "documento_habilitacao",
    # entidadeId: null, detalhes: { ids, titulos, blobsApagados } }). Mesma
    # sessão 'db'; commit é do handler (registrar_audit é best-effort, sem commit).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="BULK_DELETE_DOCUMENTOS_HABILITACAO",
        entidade="documento_habilitacao",
        entidade_id=None,
        detalhes={
            "ids": apagados_ids,
            "titulos": [d["titulo"] for d in docs],
            "blobsApagados": blobs_apagados,
        },
    )

    await db.commit()

    return JSONResponse(
        content={
            "ok": True,
            "apagados": len(apagados_ids),
            "blobsApagados": blobs_apagados,
        }
    )
