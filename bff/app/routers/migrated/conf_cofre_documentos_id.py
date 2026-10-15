"""Rota MIGRADA (estrangulador / strangler-fig):
    /api/conformidade/cofre/documentos/{id}

Espelho 1:1 de
``src/app/api/conformidade/cofre/documentos/[id]/route.ts`` — Cofre de Documentos
de Habilitação. Replica os TRÊS handlers do Next (GET / PATCH / DELETE) com a
MESMA ordem de checagens, MESMAS validações, MESMAS operações de banco e MESMO
shape de resposta (objetivo: ``JSON.parse(resp_bff) == JSON.parse(resp_next)``).

──────────────────────────────────────────────────────────────────────────────
GUARDS (mapeamento requireX do Next → require_X / get_current_user do BFF)
──────────────────────────────────────────────────────────────────────────────
GET    → ``requireVisualizar()``  ==  sessão + ``podeVisualizar(role)``
         role ∈ {ADMIN, LIDER, ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR}; barra
         EXTERNO. Equivalente no BFF: ``require_visualizar`` (Depends).
         401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}`` (sem sessão)
         403 ``{"error":"Permissão negada","code":"FORBIDDEN"}`` (papel barrado).

PATCH  → ``requireAuth()`` (SÓ 401, qualquer papel autenticado) e DEPOIS uma
         checagem MANUAL de papel → 403:
           ``podeGerenciarDocumentosHabilitacao(role)`` =
              isConformidade(role) || role == ORCAMENTISTA || role == TECNICO
           = role ∈ {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}.
         NENHUM ``require_*`` do BFF cobre EXATAMENTE esse conjunto (o
         ``require_propor`` exclui SGI; o ``require_conformidade`` exclui
         ORCAMENTISTA/TECNICO), então usamos ``Depends(get_current_user)`` para o
         401 e fazemos a checagem de papel à mão para reproduzir o 403 com a MESMA
         mensagem do Next: ``{"error":"Permissão negada"}`` (SEM ``code`` — o Next
         devolve um ``NextResponse.json`` cru aqui, não via ApiError/guard).

DELETE → ``requireAuth()`` (SÓ 401) e DEPOIS:
           ``podeExcluirDocumentoHabilitacao(role)`` = isAdmin(role) (só ADMIN).
         403 ``{"error":"Somente administradores podem excluir documentos"}``
         (mensagem própria do handler, SEM ``code``). Usamos
         ``Depends(get_current_user)`` + checagem manual de ADMIN.

ORDEM das checagens (preservada do Next; gates 0034 marcados):
  GET   : guard(401/403) → 404 (documento) → 404 (restrito invisível, R17)
          → resposta (com as 6 colunas 0034 + objeto ``operacao`` por último).
  PATCH : guard(401) → 403(papel) → 404(documento) → 404(restrito invisível,
          gate 3b) → 400(JSON inválido) → 422(zod, B1 estendido) →
          403("Apenas Conformidade pode alterar a restrição de acesso", gate 6,
          SEM code) → 422(OPERACAO_NAO_ENCONTRADA, gate 7, COM code) → UPDATE
          (+ DELETE de acervo_chunks/acervo_index_log quando restrito
          false→true, MESMA transação) → 404(linha sumiu) → audit → resposta.
  DELETE: guard(401) → 403(papel) → 404(documento) → delete blob (best-effort)
          → DELETE → audit (detalhes + operacaoId/importJobId/origemPath/
          restrito) → resposta.

──────────────────────────────────────────────────────────────────────────────
SERIALIZAÇÃO (paridade de WIRE com ``NextResponse.json`` + Drizzle/pg)
──────────────────────────────────────────────────────────────────────────────
- timestamptz → ``new Date(...).toISOString()`` do JS: SEMPRE UTC, MILISSEGUNDOS
  e sufixo ``Z`` (ex.: ``2026-06-08T12:34:56.000Z``). Usamos
  :func:`_js_to_iso_string` (NÃO ``isoformat()`` puro, que daria ``+00:00`` e
  microssegundos) — convenção dos irmãos migrados.
- uuid → ``str()``.
- numeric → o Drizzle entrega ``numeric`` como STRING ("1234.56"); o asyncpg
  entrega ``Decimal``. Para paridade de WIRE com o Drizzle, convertemos
  numeric → ``str(Decimal)`` (ver ``documentos_projetos.valor_contrato``).
- jsonb (``tags``, ``ocr_metadata``, ``detalhes``) → dict/list/None nativo
  (asyncpg já parseia).
- boolean/int/text → nativo.

──────────────────────────────────────────────────────────────────────────────
VALIDAÇÃO DO BODY (PATCH) — réplica de ``EditarDocumentoSchema`` (zod)
──────────────────────────────────────────────────────────────────────────────
Todos os campos são OPCIONAIS. Em erro → 422
``{"error":"Dados inválidos","detalhes": { "<campo>": "<msg>" } }`` (o
``formatZodErrors`` do Next produz um dict path→mensagem; o ``path`` é o nome do
campo, e para arrays como ``tags`` vira ``"tags.<i>"``). Replicamos as MESMAS
mensagens do zod por campo. JSON malformado (body não-JSON) → 400
``{"error":"JSON inválido"}`` (ANTES da validação zod).

Campos / regras (espelham validations.ts):
  categoria             enum categoriaSchema (6 valores)
  subcategoria          enum subcategoriaSchema (31 valores)
  titulo                string min(2) max(200)
  descricao             string max(2000)  (nullable)
  numeroDocumento       string max(100)   (nullable)
  revisao               string trim + max(20) "Revisão muito longa" (nullable)
                        — 0044/B6: a revisão da ENGENHARIA, que NÃO é ``versao``
                        (esta é o versionamento de certidão do cofre); null
                        limpa, valor troca, ausente não mexe
  emitidoEm             string datetime ISO-8601 (nullable)
  validadeFim           string datetime ISO-8601 (nullable)
  validadeIndeterminada boolean
  status                enum statusDocSchema (4 valores)
  tags                  array de string max(50), no máx 50 itens
  disciplinaId          string uuid "ID inválido" (nullable) — 0043: null limpa,
                        uuid troca, ausente não mexe; a EXISTÊNCIA é conferida
                        antes do UPDATE (gate 7b) e devolve 422 no campo, para o
                        23503 da FK nova nunca virar 500

Mensagens de erro do zod (literais, p/ paridade do ``detalhes``) — ZOD v4
(instalado: 4.4.3; confirmadas executando o ``EditarDocumentoSchema`` real):
  - enum inválido: "Invalid option: expected one of \"<a>\"|\"<b>\"|...". Os
    valores vêm entre ASPAS DUPLAS, juntos por ``|`` SEM espaços, e SEM o sufixo
    ``, received '<x>'``. categoria/subcategoria/status têm a sua própria lista.
  - titulo curto: "Too small: expected string to have >=2 characters".
  - max length: "Too big: expected string to have <=<N> characters".
  - emitidoEm/validadeFim formato: "Data e hora inválidas. Use o formato ISO 8601."
    (mensagem custom do ``datetime({message})``; só dispara quando o valor É
    string mas NÃO casa o formato ``...Z``; se NÃO for string, dispara antes o
    erro de tipo abaixo).
  - tipo errado (ex.: titulo number): "Invalid input: expected string, received number".
  - validadeIndeterminada não-bool: "Invalid input: expected boolean, received <tipo>".
  - tags não-array (ou null): "Invalid input: expected array, received <tipo>".
  - tags item não-string: "Invalid input: expected string, received <tipo>" (path "tags.<i>").
  - tags com >50 itens: "Too big: expected array to have <=50 items".
  - tags item >50 chars: "Too big: expected string to have <=50 characters".
  - body não-objeto: "Invalid input: expected object, received <tipo>".

NOTA: o set de campos aplicados no UPDATE é construído por ``data.X !== undefined``
(presença da chave no body parseado). Réplica fiel: só aplicamos um campo quando a
chave ESTAVA presente no JSON do request (mesmo que com valor ``null``).

──────────────────────────────────────────────────────────────────────────────
404 (existência) — espelha ``getDocumentoById(id)``
──────────────────────────────────────────────────────────────────────────────
``SELECT * FROM documentos_habilitacao WHERE id = :id LIMIT 1`` (sem soft-delete:
a tabela ``documentos_habilitacao`` NÃO tem coluna ``deletado_em``). Se vazio →
404 ``{"error":"Documento não encontrado"}`` (função ``notFound()`` do Next).

NOTA SOBRE ``id`` INVÁLIDO: o Next NÃO valida o ``id`` como UUID na rota (passa
``id`` direto pro ``eq(...)``). Se ``id`` não for um UUID, o Postgres lança no
WHERE (uuid = text). Para reproduzir o 404 do Next quando o id "não existe"
(e evitar um 500 por cast inválido em ``WHERE id = :id``), comparamos com cast
TEXTUAL (``id::text = :id``) — assim ids não-uuid simplesmente não casam → 404,
que é o resultado observável do Next quando o documento não é encontrado.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import (
    CurrentUser,
    get_current_user,
    is_admin,
    require_visualizar,
)
from app.routers.migrated._pii import redigir_pii
from app.db.session import get_db
from app.routers.migrated._restrito import is_conformidade
from app.services.audit import registrar_audit

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Permissão do PATCH (espelha podeGerenciarDocumentosHabilitacao de permissions.ts)
# ══════════════════════════════════════════════════════════════════════════════
# isConformidade(role) || role == ORCAMENTISTA || role == TECNICO
#   isConformidade = role ∈ {ADMIN, LIDER, SGI}
# ⇒ conjunto efetivo: {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}
def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    return role in ("ADMIN", "LIDER", "SGI", "ORCAMENTISTA", "TECNICO")


# ── Enums (espelham validations.ts) ───────────────────────────────────────────
_CATEGORIAS = ("JURIDICA", "FISCAL", "ECONOMICA", "TECNICA",
               "QUALIFICACAO_PESSOAL", "DECLARACAO")
_SUBCATEGORIAS = (
    "CND_FEDERAL", "FGTS", "CNDT", "CND_ESTADUAL", "CND_MUNICIPAL", "FALENCIA",
    "BALANCO", "INDICES_FINANCEIROS",
    "CONTRATO_SOCIAL", "CNPJ", "ATO_CONSTITUTIVO", "PROCURACAO",
    "ATESTADO_ACT", "ISO_9001", "ISO_14001", "ISO_45001",
    "NR_10", "NR_13", "NR_35", "ASME", "API_Q1", "API_6D", "PED",
    "OUTROS_TECNICOS",
    "CREA_PJ", "CREA_PF", "ART_CAT", "CTPS", "FORMACAO",
    "DECL_MENOR_NAO_EMPREGA", "DECL_IDONEIDADE", "DECL_ME_EPP", "DECL_OUTRA",
    "OUTRO",
)
_STATUS = ("VIGENTE", "EM_RENOVACAO", "VENCIDO", "SUBSTITUIDO")

# ── Tuplas da 0033/0034 (espelham src/lib/conformidade/operacoes.ts) ──────────
# A ORDEM entra na mensagem de enum do Zod — não reordenar.
_PAPEIS = ("ATESTADO", "CAT_ART", "CONTRATO", "ADITIVO",
           "NOTA_FISCAL", "DECLARACAO", "OUTRO")
_TIPOS_DOCUMENTO = (
    "ART", "CAT", "ATESTADO", "CONTRATO", "ADITIVO", "ANEXO_CONTRATO",
    "CREA_PJ", "ISO", "DECLARACAO", "PROPOSTA", "ANEXO_ET", "DOC_PROJETO",
    "PEDIDO", "NF", "CARTA", "RELATORIO", "PESSOAL", "CAPA_OP",
    "COMPACTADO", "OUTRO",
)
_SITUACOES_PROVA = ("RASCUNHO", "ASSINADA_PROPONENTE", "ASSINADA_CLIENTE",
                    "SUPERADA", "CANCELADA", "MODELO", "INDEFINIDA")
_DETENTORAS = ("PROPONENTE", "COLIGADA", "PARCEIRO")

# Regex LITERAL do ``z.string().uuid()`` do Zod v4.4.3 — usada nos campos NOVOS
# da 0033/0034 (``operacaoId`` do PATCH), como nos irmãos migrados.
_UUID_ZOD_REGEX = re.compile(
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}"
    r"-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000"
    r"|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)


# ══════════════════════════════════════════════════════════════════════════════
# Serialização (paridade com Drizzle/NextResponse.json)
# ══════════════════════════════════════════════════════════════════════════════
def _js_to_iso_string(dt: Any) -> str | None:
    """Replica ``new Date(dt).toISOString()`` do JS (UTC, ms, sufixo 'Z').

    timestamptz → asyncpg devolve ``datetime`` tz-aware; o JS serializa SEMPRE em
    UTC, precisão de MILISSEGUNDOS e sufixo ``Z``. Naive é tratado como UTC.
    """
    if dt is None:
        return None
    if not isinstance(dt, datetime):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"
    )


def _numeric_str(value: Any) -> str | None:
    """numeric → STRING (igual ao Drizzle, que entrega ``numeric`` como string).

    asyncpg devolve ``numeric`` como ``Decimal``; o Drizzle o expõe como a string
    crua do banco. Para paridade de WIRE convertemos ``Decimal`` → ``str``.
    """
    if value is None:
        return None
    if isinstance(value, Decimal):
        return str(value)
    return str(value)


def _uuid_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    return str(value)


def _doc_to_json(r: Any) -> dict[str, Any]:
    """Serializa uma linha de ``documentos_habilitacao`` no shape camelCase do
    Drizzle (``db.select().from(documentosHabilitacao)`` = TODAS as colunas)."""
    return {
        "id": _uuid_str(r["id"]),
        "categoria": r["categoria"],
        "subcategoria": r["subcategoria"],
        "titulo": r["titulo"],
        "descricao": r["descricao"],
        # 0033: o Next NÃO projeta colunas nem no GET (``db.select()`` cru em
        # getDocumentoById) nem no PATCH (``.returning()`` sem projeção), então
        # as duas colunas novas entram automaticamente nas duas respostas — na
        # posição que ocupam no pgTable (logo depois de descricao). Mesma
        # redação do 201 do POST (conf_cofre_documentos.py:1248-1252).
        "operacaoId": _uuid_str(r["operacao_id"]),
        "papel": r["papel"],
        # 0034: as 6 colunas do dossiê vêm logo depois de ``papel`` no pgTable
        # (schema.ts:1113-1121) — o ``SELECT *``/``.returning()`` as entrega
        # nesta posição nos dois lados. Serialização: import_job_id → str|null;
        # o resto é text/bool cru.
        "tipoDocumento": r["tipo_documento"],
        "situacaoProva": r["situacao_prova"],
        "detentora": r["detentora"],
        # 0043 (item B4): o Next devolve `{...documento}` (SELECT * do Drizzle),
        # entao a chave existe la desde a onda 1 — o espelho precisa dela.
        "detentoraCnpj": r["detentora_cnpj"],
        "restrito": r["restrito"],
        "importJobId": _uuid_str(r["import_job_id"]),
        # 0043: a coluna nova fica ENTRE import_job_id e origem_path no pgTable
        # (schema.ts:1182-1187); o ``SELECT *``/``.returning()`` a entrega nessa
        # posição nos dois lados, no GET e no PATCH.
        "disciplinaId": _uuid_str(r["disciplina_id"]),
        "origemPath": r["origem_path"],
        "nomeArquivo": r["nome_arquivo"],
        "blobUrl": r["blob_url"],
        "blobKey": r["blob_key"],
        "tamanhoBytes": r["tamanho_bytes"],
        "contentType": r["content_type"],
        "sha256": r["sha256"],
        "numeroDocumento": r["numero_documento"],
        "emitidoEm": _js_to_iso_string(r["emitido_em"]),
        "validadeFim": _js_to_iso_string(r["validade_fim"]),
        "validadeIndeterminada": r["validade_indeterminada"],
        "status": r["status"],
        "versao": r["versao"],
        # 0044 (B6): a revisão carimbada pela ENGENHARIA ("R0", "R1", "02A").
        # Fica ENTRE ``versao`` e ``documento_anterior_id`` no pgTable
        # (schema.ts:1217) e o ``SELECT *``/``.returning()`` a entrega nessa
        # posição nos dois lados, no GET e no PATCH. NÃO é ``versao``: aquela é
        # o versionamento de certidão do cofre (spec ONDA-5 §1h).
        "revisao": r["revisao"],
        "documentoAnteriorId": _uuid_str(r["documento_anterior_id"]),
        # Redigido na LEITURA. O `ocr_texto` gravado pode conter PII (CPF ou
        # e-mail): cargas de OCR em lote podem entrar por fora da redação
        # aplicada no upload. Redigir aqui fecha a exposição SEM tocar na
        # fonte da verdade, então a decisão sobre sanear o legado segue aberta.
        "ocrTexto": redigir_pii(r["ocr_texto"]),
        "ocrMetadata": r["ocr_metadata"],
        "ocrConfianca": r["ocr_confianca"],
        "tags": r["tags"],
        "uploadadoPor": _uuid_str(r["uploadado_por"]),
        "atualizadoPor": _uuid_str(r["atualizado_por"]),
        "criadoEm": _js_to_iso_string(r["criado_em"]),
        "atualizadoEm": _js_to_iso_string(r["atualizado_em"]),
    }


# ── SELECT * de documentos_habilitacao (espelha getDocumentoById). ────────────
# Cast textual no WHERE para tolerar ids não-uuid (Next não valida o id) → 404.
_SELECT_DOC = text(
    "SELECT * FROM documentos_habilitacao WHERE id::text = :id LIMIT 1"
)


async def _get_documento(db, id: str):
    """``getDocumentoById(id)``: SELECT * ... LIMIT 1 → mapping ou None."""
    res = await db.execute(_SELECT_DOC, {"id": id})
    return res.mappings().first()


# ══════════════════════════════════════════════════════════════════════════════
# Validação do body do PATCH (réplica de EditarDocumentoSchema / zod)
# ══════════════════════════════════════════════════════════════════════════════
_TIPO_JS = {
    type(None): "null",
    bool: "boolean",
    int: "number",
    float: "number",
    str: "string",
    list: "array",
    dict: "object",
}


def _js_typeof(v: Any) -> str:
    """Nome de tipo no estilo do zod ('string'/'number'/'boolean'/...)."""
    # bool é subclasse de int — checar antes.
    if isinstance(v, bool):
        return "boolean"
    return _TIPO_JS.get(type(v), "object")


def _enum_msg(valores: tuple[str, ...], recebido: Any) -> str:
    """Mensagem do zod para enum inválido (v4, 4.4.3):
    'Invalid option: expected one of "a"|"b"|...'.

    Os valores vêm entre ASPAS DUPLAS, juntos por ``|`` SEM espaços, e SEM o
    sufixo ``, received '<x>'`` que existia no zod v3 (``recebido`` é ignorado,
    mantido só para compat. de assinatura)."""
    esperados = "|".join(f'"{v}"' for v in valores)
    return f"Invalid option: expected one of {esperados}"


def _valida_enum(valor: Any, valores: tuple[str, ...], erros: dict, campo: str) -> None:
    if not isinstance(valor, str) or valor not in valores:
        erros[campo] = _enum_msg(valores, valor)


def _valida_string(
    valor: Any, erros: dict, campo: str,
    minimo: int | None = None, maximo: int | None = None,
    nullable: bool = False,
) -> None:
    if valor is None:
        if nullable:
            return
        erros[campo] = f"Invalid input: expected string, received {_js_typeof(valor)}"
        return
    if not isinstance(valor, str) or isinstance(valor, bool):
        erros[campo] = f"Invalid input: expected string, received {_js_typeof(valor)}"
        return
    if minimo is not None and len(valor) < minimo:
        erros[campo] = f"Too small: expected string to have >={minimo} characters"
        return
    if maximo is not None and len(valor) > maximo:
        erros[campo] = f"Too big: expected string to have <={maximo} characters"


# Regex do ``z.string().datetime()`` (zod v4, SEM ``offset:true``): exige uma
# data ISO-8601 completa cujo timezone seja o literal ``Z`` (UTC). Rejeita offset
# numérico (+hh:mm), ausência de timezone, date-only e separador por espaço — o
# zod aceita SOMENTE o sufixo ``Z`` (com frações de segundo opcionais).
_ZOD_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$"
)


def _parse_iso_datetime(valor: str) -> datetime | None:
    """Converte uma string ISO-8601 ``...Z`` (já validada por ``_valida_datetime``)
    para ``datetime`` tz-aware, p/ o UPDATE.

    Espelha ``new Date(data.emitidoEm)`` do Next: a string aqui SEMPRE termina em
    ``Z`` (passou pelo ``_ZOD_DATETIME_RE``). ``datetime.fromisoformat`` (3.11+)
    aceita o sufixo ``Z`` diretamente. Retorna ``None`` se inválida (defensivo).
    """
    if not isinstance(valor, str):
        return None
    try:
        return datetime.fromisoformat(valor)
    except ValueError:
        return None


def _valida_datetime(valor: Any, erros: dict, campo: str) -> None:
    # nullable: emitidoEm/validadeFim podem ser null (não erro).
    if valor is None:
        return
    # Tipo errado (ex.: number/boolean): no zod o erro de TIPO da string dispara
    # ANTES do refinamento ``datetime()`` → "Invalid input: expected string,
    # received <tipo>" (NÃO a mensagem custom do datetime).
    if not isinstance(valor, str) or isinstance(valor, bool):
        erros[campo] = f"Invalid input: expected string, received {_js_typeof(valor)}"
        return
    # É string, mas não casa o formato ``...Z`` exigido pelo zod v4 → mensagem
    # custom do ``datetime({message})``. (fromisoformat do Python é MAIS
    # permissivo — aceita offset/sem-tz/date-only/espaço — então NÃO o usamos
    # para a validação, só para a conversão posterior no UPDATE.)
    if not _ZOD_DATETIME_RE.match(valor):
        erros[campo] = "Data e hora inválidas. Use o formato ISO 8601."


def _valida_tags(valor: Any, erros: dict) -> None:
    if valor is None:
        # tags é .optional() (sem .nullable()): null → erro de tipo array (v4).
        erros["tags"] = "Invalid input: expected array, received null"
        return
    if not isinstance(valor, list):
        erros["tags"] = f"Invalid input: expected array, received {_js_typeof(valor)}"
        return
    if len(valor) > 50:
        erros["tags"] = "Too big: expected array to have <=50 items"
        return
    for i, item in enumerate(valor):
        if not isinstance(item, str) or isinstance(item, bool):
            erros[f"tags.{i}"] = (
                f"Invalid input: expected string, received {_js_typeof(item)}"
            )
        elif len(item) > 50:
            erros[f"tags.{i}"] = "Too big: expected string to have <=50 characters"


def _validar_editar(body: Any) -> tuple[dict | None, dict | None]:
    """Réplica de ``EditarDocumentoSchema.safeParse(body)``.

    Retorna ``(data, None)`` em sucesso (``data`` = dict só com as chaves
    presentes no body, valores já normalizados) ou ``(None, erros)`` em falha,
    onde ``erros`` é o dict path→mensagem do ``formatZodErrors``.
    """
    erros: dict[str, str] = {}

    # z.object() com body não-objeto → "Invalid input: expected object, received
    # <tipo>" (zod v4). Para array/null o ``received`` é "array"/"null".
    if not isinstance(body, dict):
        # zod reporta no path raiz "" — formatZodErrors usa path.join(".") = "".
        return None, {"": f"Invalid input: expected object, received {_js_typeof(body)}"}

    data: dict[str, Any] = {}

    if "categoria" in body:
        _valida_enum(body["categoria"], _CATEGORIAS, erros, "categoria")
        data["categoria"] = body["categoria"]
    if "subcategoria" in body:
        _valida_enum(body["subcategoria"], _SUBCATEGORIAS, erros, "subcategoria")
        data["subcategoria"] = body["subcategoria"]
    if "titulo" in body:
        _valida_string(body["titulo"], erros, "titulo", minimo=2, maximo=200)
        data["titulo"] = body["titulo"]
    if "descricao" in body:
        _valida_string(body["descricao"], erros, "descricao",
                       maximo=2000, nullable=True)
        data["descricao"] = body["descricao"]
    if "numeroDocumento" in body:
        _valida_string(body["numeroDocumento"], erros, "numeroDocumento",
                       maximo=100, nullable=True)
        data["numeroDocumento"] = body["numeroDocumento"]
    # 0044 (B6) — revisao: z.string().trim().max(20, "Revisão muito longa")
    # .optional().nullable(). ``null`` LIMPA, valor troca, ausente não mexe.
    # Bloco próprio (e não ``_valida_string``) por DUAS manias medidas no schema
    # real (zod v4.4.3):
    #   1. o ``.trim()`` roda ANTES do ``.max()`` — " R1 " tem 4 caracteres e
    #      passa, e o valor GRAVADO é o aparado ("R1"), não o original;
    #   2. a mensagem é CUSTOM em pt-BR ("Revisão muito longa"), não a do zod.
    # Whitespace puro vira STRING VAZIA e é válido — não vira ``null`` (quem
    # limpa é ``null`` explícito).
    if "revisao" in body:
        v_rev = body["revisao"]
        if v_rev is None:
            data["revisao"] = None
        elif not isinstance(v_rev, str) or isinstance(v_rev, bool):
            erros["revisao"] = (
                f"Invalid input: expected string, received {_js_typeof(v_rev)}"
            )
            data["revisao"] = v_rev
        else:
            aparada = v_rev.strip()
            if len(aparada) > 20:
                erros["revisao"] = "Revisão muito longa"
            data["revisao"] = aparada
    if "emitidoEm" in body:
        _valida_datetime(body["emitidoEm"], erros, "emitidoEm")
        data["emitidoEm"] = body["emitidoEm"]
    if "validadeFim" in body:
        _valida_datetime(body["validadeFim"], erros, "validadeFim")
        data["validadeFim"] = body["validadeFim"]
    if "validadeIndeterminada" in body:
        v = body["validadeIndeterminada"]
        if not isinstance(v, bool):
            erros["validadeIndeterminada"] = (
                f"Invalid input: expected boolean, received {_js_typeof(v)}"
            )
        data["validadeIndeterminada"] = v
    if "status" in body:
        _valida_enum(body["status"], _STATUS, erros, "status")
        data["status"] = body["status"]
    if "tags" in body:
        _valida_tags(body["tags"], erros)
        data["tags"] = body["tags"]

    # ── Campos 0033/0034 (B1 estendido — 02-APIS §8.1) ────────────────────────
    # Todos ``.optional().nullable()`` MENOS ``restrito`` (``.optional()`` puro):
    # ``null`` limpa a coluna nos nullable; em ``restrito`` é erro de tipo.
    if "operacaoId" in body:
        v = body["operacaoId"]
        if v is None:
            pass  # null = desvincular (NÃO limpa ``papel`` — quem quiser manda junto)
        elif not isinstance(v, str) or isinstance(v, bool):
            erros["operacaoId"] = (
                f"Invalid input: expected string, received {_js_typeof(v)}"
            )
        elif not _UUID_ZOD_REGEX.match(v):
            erros["operacaoId"] = "ID inválido"
        data["operacaoId"] = v

    # 0043 — disciplinaId: z.string().uuid("ID inválido").optional().nullable().
    # ``null`` limpa a disciplina, uuid troca, ausente não mexe — o MESMO molde
    # do ``operacaoId`` acima. A EXISTÊNCIA é conferida depois (gate 7b).
    if "disciplinaId" in body:
        v = body["disciplinaId"]
        if v is None:
            pass  # null = limpar a classificação (sempre válido)
        elif not isinstance(v, str) or isinstance(v, bool):
            erros["disciplinaId"] = (
                f"Invalid input: expected string, received {_js_typeof(v)}"
            )
        elif not _UUID_ZOD_REGEX.match(v):
            erros["disciplinaId"] = "ID inválido"
        data["disciplinaId"] = v

    def _enum_nullable(campo: str, valores: tuple[str, ...]) -> None:
        """z.enum(...).optional().nullable(): null limpa, valor troca."""
        if campo not in body:
            return
        v = body[campo]
        if v is not None and v not in valores:
            erros[campo] = _enum_msg(valores, v)
        data[campo] = v

    _enum_nullable("papel", _PAPEIS)
    _enum_nullable("tipoDocumento", _TIPOS_DOCUMENTO)
    _enum_nullable("situacaoProva", _SITUACOES_PROVA)
    _enum_nullable("detentora", _DETENTORAS)

    if "restrito" in body:
        v = body["restrito"]
        if not isinstance(v, bool):
            erros["restrito"] = (
                f"Invalid input: expected boolean, received {_js_typeof(v)}"
            )
        data["restrito"] = v

    if erros:
        return None, erros
    return data, None


# ══════════════════════════════════════════════════════════════════════════════
# Storage (S3 / MinIO) — delete best-effort do blob (espelha deleteDocumento)
# ══════════════════════════════════════════════════════════════════════════════
def _delete_blob_best_effort(key_or_url: str) -> None:
    """Apaga o objeto no S3/MinIO. Best-effort: NUNCA propaga erro.

    Espelha ``deleteDocumento(atual.blobKey)`` (lib/storage/upload.ts) chamado
    dentro de ``try {} catch {}`` no DELETE do Next — falha de storage é
    engolida (o registro de banco/auditoria é prioritário). Aceita key OU URL S3
    (extrai a key da URL, igual ao regex do Next).
    """
    from app.core.config import settings

    try:
        key = key_or_url
        # Tolera URL completa S3 (mesmo regex do Next: .../<bucket>/<key>).
        m = re.search(r"r2\.cloudflarestorage\.com/[^/]+/(.+)$", key_or_url)
        if m:
            key = m.group(1)

        import boto3  # import tardio: storage não está no caminho quente

        client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint or None,
            aws_access_key_id=settings.s3_access_key or None,
            aws_secret_access_key=settings.s3_secret_key or None,
        )
        client.delete_object(Bucket=settings.s3_bucket, Key=key)
    except Exception:  # noqa: BLE001 — best-effort (igual ao catch vazio do Next)
        pass


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/conformidade/cofre/documentos/{id} — Detalhe (famílias e projetos)
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/conformidade/cofre/documentos/{id}")
async def get_documento(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    # ── 404: documento existe? (getDocumentoById) ─────────────────────────────
    documento = await _get_documento(db, id)
    if documento is None:
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── Barreira restrito (0034/R17): 404 IDÊNTICO ao de inexistente ──────────
    # Para papel fora de Conformidade, documento restrito "não existe" — nunca
    # 403, que confirmaria a existência (ADR-05).
    if documento["restrito"] and not is_conformidade(user.role):
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── Famílias vinculadas (getFamiliasByDocumento) ──────────────────────────
    # innerJoin familias ON documentos_familias.familia_id = familias.id
    # WHERE documento_id = :id ORDER BY familias.codigo_crc ASC
    fam_rows = (await db.execute(
        text(
            """
            SELECT
              df.id          AS vinculo_id,
              f.id           AS familia_id,
              f.codigo_crc   AS codigo_crc,
              f.nome         AS nome,
              f.status       AS status,
              df.observacao  AS observacao,
              df.criado_em   AS vinculado_em
            FROM documentos_familias AS df
            INNER JOIN familias AS f ON df.familia_id = f.id
            WHERE df.documento_id::text = :id
            ORDER BY f.codigo_crc ASC
            """
        ),
        {"id": id},
    )).mappings().all()
    familias = [
        {
            "vinculoId": _uuid_str(r["vinculo_id"]),
            "familiaId": _uuid_str(r["familia_id"]),
            "codigoCrc": r["codigo_crc"],
            "nome": r["nome"],
            "status": r["status"],
            "observacao": r["observacao"],
            "vinculadoEm": _js_to_iso_string(r["vinculado_em"]),
        }
        for r in fam_rows
    ]

    # ── Projetos vinculados (getProjetosByDocumento) ──────────────────────────
    # db.select() (TODAS as colunas) FROM documentos_projetos
    # WHERE documento_id = :id ORDER BY periodo_fim DESC
    proj_rows = (await db.execute(
        text(
            """
            SELECT *
            FROM documentos_projetos
            WHERE documento_id::text = :id
            ORDER BY periodo_fim DESC
            """
        ),
        {"id": id},
    )).mappings().all()
    projetos = [
        {
            "id": _uuid_str(r["id"]),
            "documentoId": _uuid_str(r["documento_id"]),
            "clienteCnpj": r["cliente_cnpj"],
            "clienteNome": r["cliente_nome"],
            "projetoNome": r["projeto_nome"],
            "valorContrato": _numeric_str(r["valor_contrato"]),
            "periodoInicio": _js_to_iso_string(r["periodo_inicio"]),
            "periodoFim": _js_to_iso_string(r["periodo_fim"]),
            "descricaoServico": r["descricao_servico"],
            "engenheiroResponsavel": r["engenheiro_responsavel"],
            "registroCrea": r["registro_crea"],
            "numeroArt": r["numero_art"],
            "criadoEm": _js_to_iso_string(r["criado_em"]),
        }
        for r in proj_rows
    ]

    # ── Anexos extras (getAnexosByDocumento) ──────────────────────────────────
    # leftJoin users ON uploadado_por = users.id
    # WHERE documento_id = :id ORDER BY criado_em DESC
    anexo_rows = (await db.execute(
        text(
            """
            SELECT
              a.id            AS a_id,
              a.documento_id  AS a_documento_id,
              a.tipo          AS a_tipo,
              a.titulo        AS a_titulo,
              a.nome_arquivo  AS a_nome_arquivo,
              a.blob_url      AS a_blob_url,
              a.blob_key      AS a_blob_key,
              a.tamanho_bytes AS a_tamanho_bytes,
              a.content_type  AS a_content_type,
              a.uploadado_por AS a_uploadado_por,
              u.nome          AS u_nome,
              a.criado_em     AS a_criado_em
            FROM documentos_habilitacao_anexos AS a
            LEFT JOIN users AS u ON a.uploadado_por = u.id
            WHERE a.documento_id::text = :id
            ORDER BY a.criado_em DESC
            """
        ),
        {"id": id},
    )).mappings().all()
    anexos = [
        {
            "id": _uuid_str(r["a_id"]),
            "documentoId": _uuid_str(r["a_documento_id"]),
            "tipo": r["a_tipo"],
            "titulo": r["a_titulo"],
            "nomeArquivo": r["a_nome_arquivo"],
            "blobUrl": r["a_blob_url"],
            "blobKey": r["a_blob_key"],
            "tamanhoBytes": r["a_tamanho_bytes"],
            "contentType": r["a_content_type"],
            "uploadadoPor": _uuid_str(r["a_uploadado_por"]),
            "uploadadoPorNome": r["u_nome"],
            "criadoEm": _js_to_iso_string(r["a_criado_em"]),
        }
        for r in anexo_rows
    ]

    # ── Operação vinculada (0034/R17 — dependência D1 do front) ───────────────
    # MESMO shape do objeto aninhado que o GET da lista já devolve
    # (conf_cofre_documentos.py:603-609); ``null`` explícito para órfão (a chave
    # nunca é omitida). Query só quando há vínculo.
    operacao = None
    if documento["operacao_id"] is not None:
        op_row = (await db.execute(
            text(
                "SELECT id, codigo, cliente_nome FROM operacoes "
                "WHERE id = CAST(:operacao_id AS uuid) LIMIT 1"
            ),
            {"operacao_id": str(documento["operacao_id"])},
        )).mappings().first()
        if op_row is not None:
            operacao = {
                "id": _uuid_str(op_row["id"]),
                "codigo": op_row["codigo"],
                "clienteNome": op_row["cliente_nome"],
            }

    # ── Resposta: { ...documento, familias, projetos, anexos, operacao } ──────
    # ``operacao`` é a ÚLTIMA chave (a ordem das chaves é contrato de paridade).
    payload = _doc_to_json(documento)
    payload["familias"] = familias
    payload["projetos"] = projetos
    payload["anexos"] = anexos
    payload["operacao"] = operacao
    return JSONResponse(content=payload)


# ══════════════════════════════════════════════════════════════════════════════
# PATCH /api/conformidade/cofre/documentos/{id} — Edita metadados
# ══════════════════════════════════════════════════════════════════════════════
@router.patch("/api/conformidade/cofre/documentos/{id}")
async def patch_documento(
    id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),  # requireAuth → só 401
    db=Depends(get_db),
) -> JSONResponse:
    # ── 403: papel (podeGerenciarDocumentosHabilitacao) ───────────────────────
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(content={"error": "Permissão negada"}, status_code=403)

    # ── 404: documento existe? (getDocumentoById) ─────────────────────────────
    atual = await _get_documento(db, id)
    if atual is None:
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── Gate 3b (0034/R8): documento restrito é INVISÍVEL fora de Conformidade.
    # O MESMO 404 do detalhe (R17) — 403 confirmaria a existência (ADR-05).
    if atual["restrito"] and not is_conformidade(user.role):
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── 400: JSON inválido (body não-parseável). ──────────────────────────────
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — qualquer falha de parse = 400 (igual Next)
        return JSONResponse(content={"error": "JSON inválido"}, status_code=400)

    # ── 422: validação zod (EditarDocumentoSchema). ───────────────────────────
    data, erros = _validar_editar(body)
    if erros is not None:
        return JSONResponse(
            content={"error": "Dados inválidos", "detalhes": erros},
            status_code=422,
        )
    assert data is not None

    # ── Gate 6 (0034/R8): só Conformidade altera a restrição de acesso. ───────
    # Checagem por PRESENÇA da chave (data.restrito !== undefined) — 403 SEM
    # ``code`` (checagem inline, convenção do módulo).
    if "restrito" in data and not is_conformidade(user.role):
        return JSONResponse(
            content={"error": "Apenas Conformidade pode alterar a restrição de acesso"},
            status_code=403,
        )

    # ── Gate 7 (0034/R8): operacaoId não-nulo tem de resolver em operacoes. ───
    if data.get("operacaoId") is not None:
        existe = (
            await db.execute(
                text("SELECT 1 FROM operacoes WHERE id = CAST(:operacao_id AS uuid)"),
                {"operacao_id": data["operacaoId"]},
            )
        ).first()
        if existe is None:
            return JSONResponse(
                content={
                    "error": "Operação não encontrada",
                    "code": "OPERACAO_NAO_ENCONTRADA",
                },
                status_code=422,
            )

    # ── Gate 7b (0043): disciplinaId não-nulo tem de resolver em disciplinas. ─
    # Com a FK ``fk_doch_disciplina``, um uuid inexistente seria 23503 → 500 sem
    # dizer o campo. 422 em ``disciplinaId`` (spec ONDA-4 §1a). ``null`` limpa e
    # NÃO passa por aqui.
    if data.get("disciplinaId") is not None:
        existe_disc = (
            await db.execute(
                text(
                    "SELECT 1 FROM disciplinas "
                    "WHERE id = CAST(:disciplina_id AS uuid)"
                ),
                {"disciplina_id": data["disciplinaId"]},
            )
        ).first()
        if existe_disc is None:
            return JSONResponse(
                content={
                    "error": "Dados inválidos",
                    "detalhes": {"disciplinaId": "Disciplina não encontrada"},
                },
                status_code=422,
            )

    # ── Monta o SET do UPDATE (mesma lógica do Next: data.X !== undefined). ────
    # Sempre seta atualizadoPor + atualizadoEm = new Date().
    agora = datetime.now(tz=timezone.utc)
    set_cols: list[str] = ["atualizado_por = :atualizado_por",
                           "atualizado_em = :atualizado_em"]
    params: dict[str, Any] = {
        "atualizado_por": user.id,
        "atualizado_em": agora,
        "id": id,
    }

    if "categoria" in data:
        set_cols.append("categoria = :categoria")
        params["categoria"] = data["categoria"]
    if "subcategoria" in data:
        set_cols.append("subcategoria = :subcategoria")
        params["subcategoria"] = data["subcategoria"]
    if "titulo" in data:
        set_cols.append("titulo = :titulo")
        params["titulo"] = data["titulo"]
    if "descricao" in data:
        set_cols.append("descricao = :descricao")
        params["descricao"] = data["descricao"]
    if "numeroDocumento" in data:
        set_cols.append("numero_documento = :numero_documento")
        params["numero_documento"] = data["numeroDocumento"]
    # 0044 (B6): ``null`` limpa, valor (já aparado pelo trim do zod) troca,
    # ausente não mexe. O ``{antes, depois}`` do audit NÃO ganha a chave — o
    # detalhe é a lista fixa de campos 0033/0034 e o Next repete a mesma lista.
    if "revisao" in data:
        set_cols.append("revisao = :revisao")
        params["revisao"] = data["revisao"]
    if "validadeIndeterminada" in data:
        set_cols.append("validade_indeterminada = :validade_indeterminada")
        params["validade_indeterminada"] = data["validadeIndeterminada"]
    if "status" in data:
        set_cols.append("status = :status")
        params["status"] = data["status"]
    if "tags" in data:
        # jsonb: passa lista/None como JSON (cast ::jsonb no SQL).
        import json as _json

        set_cols.append("tags = CAST(:tags AS jsonb)")
        params["tags"] = (
            None if data["tags"] is None else _json.dumps(data["tags"])
        )
    if "emitidoEm" in data:
        # data.emitidoEm ? new Date(data.emitidoEm) : null
        set_cols.append("emitido_em = :emitido_em")
        params["emitido_em"] = (
            _parse_iso_datetime(data["emitidoEm"]) if data["emitidoEm"] else None
        )
    if "validadeFim" in data:
        set_cols.append("validade_fim = :validade_fim")
        params["validade_fim"] = (
            _parse_iso_datetime(data["validadeFim"]) if data["validadeFim"] else None
        )

    # ── Campos 0033/0034 (B1 estendido) ───────────────────────────────────────
    if "operacaoId" in data:
        # uuid|null: vincula (aqui SOBRESCREVE — revinculação consciente; a
        # adoção em lote de R11 nunca sobrescreve) ou desvincula. ``null`` NÃO
        # limpa ``papel`` (quem quiser limpar manda ``papel: null`` junto).
        set_cols.append("operacao_id = CAST(:operacao_id AS uuid)")
        params["operacao_id"] = data["operacaoId"]
    if "papel" in data:
        set_cols.append("papel = :papel")
        params["papel"] = data["papel"]
    if "tipoDocumento" in data:
        set_cols.append("tipo_documento = :tipo_documento")
        params["tipo_documento"] = data["tipoDocumento"]
    if "situacaoProva" in data:
        set_cols.append("situacao_prova = :situacao_prova")
        params["situacao_prova"] = data["situacaoProva"]
    if "detentora" in data:
        set_cols.append("detentora = :detentora")
        params["detentora"] = data["detentora"]
    if "restrito" in data:
        set_cols.append("restrito = :restrito")
        params["restrito"] = data["restrito"]
    # 0043: ``null`` limpa, uuid troca, ausente não mexe. O ``{antes, depois}``
    # do audit NÃO ganha a chave — o detalhe é a lista fixa de campos 0033/0034
    # e o Next repete a mesma lista (spec ONDA-4 §5.8c).
    if "disciplinaId" in data:
        set_cols.append("disciplina_id = CAST(:disciplina_id AS uuid)")
        params["disciplina_id"] = data["disciplinaId"]

    # ── UPDATE ... RETURNING * (espelha .update().set().where().returning()). ──
    update_sql = text(
        f"UPDATE documentos_habilitacao SET {', '.join(set_cols)} "
        "WHERE id::text = :id RETURNING *"
    )
    res = await db.execute(update_sql, params)
    atualizado = res.mappings().first()
    if atualizado is None:
        # if (!atualizado) return notFound();
        await db.rollback()
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── Efeito colateral de restrito false→true (S15-b — 02-APIS §8.3) ────────
    # Chunk já indexado não pode sobreviver à marcação; o LOG também sai, senão
    # DESMARCAR nunca re-indexaria (o cron veria o texto_hash "já indexado").
    # NA MESMA transação do UPDATE. Transições false→false, true→true e
    # true→false não disparam nada (o re-índice do desmarcado é do cron).
    chunks_removidos: int | None = None
    if data.get("restrito") is True and not atual["restrito"]:
        doc_uuid = str(atualizado["id"])
        res_chunks = await db.execute(
            text(
                "DELETE FROM acervo_chunks "
                "WHERE origem_tipo = 'DOC_HABILITACAO' "
                "AND origem_id = CAST(:doc AS uuid)"
            ),
            {"doc": doc_uuid},
        )
        chunks_removidos = res_chunks.rowcount or 0
        await db.execute(
            text(
                "DELETE FROM acervo_index_log "
                "WHERE origem_tipo = 'DOC_HABILITACAO' "
                "AND origem_id = CAST(:doc AS uuid)"
            ),
            {"doc": doc_uuid},
        )

    # ── audit_log: EDITAR_DOCUMENTO_HABILITACAO ───────────────────────────────
    # detalhes.{antes,depois} com titulo/status/validadeFim (validadeFim no
    # detalhes do Next é o Date cru → serializado no JSONB como ISO via JSON).
    # Mesma sessão 'db' / mesmo ponto lógico (após o UPDATE, antes do commit).
    # 0034: antes/depois passam a incluir os campos do dossiê — a mudança de
    # ``restrito`` SEMPRE presente quando alterada (rastro que o P9/P7 exige);
    # ``chunksRemovidos`` só quando restrito passou a true (§8.5).
    detalhes_audit: dict[str, Any] = {
        "antes": {
            "titulo": atual["titulo"],
            "status": atual["status"],
            "validadeFim": _js_to_iso_string(atual["validade_fim"]),
            "operacaoId": _uuid_str(atual["operacao_id"]),
            "papel": atual["papel"],
            "tipoDocumento": atual["tipo_documento"],
            "situacaoProva": atual["situacao_prova"],
            "detentora": atual["detentora"],
            "restrito": atual["restrito"],
        },
        "depois": {
            "titulo": atualizado["titulo"],
            "status": atualizado["status"],
            "validadeFim": _js_to_iso_string(atualizado["validade_fim"]),
            "operacaoId": _uuid_str(atualizado["operacao_id"]),
            "papel": atualizado["papel"],
            "tipoDocumento": atualizado["tipo_documento"],
            "situacaoProva": atualizado["situacao_prova"],
            "detentora": atualizado["detentora"],
            "restrito": atualizado["restrito"],
        },
    }
    if chunks_removidos is not None:
        detalhes_audit["chunksRemovidos"] = chunks_removidos

    await registrar_audit(
        db,
        user_id=user.id,
        acao="EDITAR_DOCUMENTO_HABILITACAO",
        entidade="documento_habilitacao",
        entidade_id=id,
        detalhes=detalhes_audit,
    )

    await db.commit()

    # ── Resposta: NextResponse.json(atualizado) — o registro completo. ────────
    return JSONResponse(content=_doc_to_json(atualizado))


# ══════════════════════════════════════════════════════════════════════════════
# DELETE /api/conformidade/cofre/documentos/{id} — Remove (somente ADMIN)
# ══════════════════════════════════════════════════════════════════════════════
@router.delete("/api/conformidade/cofre/documentos/{id}")
async def delete_documento(
    id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),  # requireAuth → só 401
    db=Depends(get_db),
) -> JSONResponse:
    # ── 403: papel (podeExcluirDocumentoHabilitacao = só ADMIN) ───────────────
    if not is_admin(user.role):
        return JSONResponse(
            content={"error": "Somente administradores podem excluir documentos"},
            status_code=403,
        )

    # ── 404: documento existe? (getDocumentoById) ─────────────────────────────
    atual = await _get_documento(db, id)
    if atual is None:
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── Apaga o blob no S3/MinIO (best-effort) — usa blobKey, não blobUrl. ────
    _delete_blob_best_effort(atual["blob_key"])

    # ── DELETE FROM documentos_habilitacao WHERE id. ──────────────────────────
    await db.execute(
        text("DELETE FROM documentos_habilitacao WHERE id::text = :id"),
        {"id": id},
    )

    # ── audit_log: EXCLUIR_DOCUMENTO_HABILITACAO ──────────────────────────────
    # Mesma sessão 'db' / mesmo ponto lógico (após o DELETE, antes do commit).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="EXCLUIR_DOCUMENTO_HABILITACAO",
        entidade="documento_habilitacao",
        entidade_id=id,
        detalhes={
            "titulo": atual["titulo"],
            "blobKey": atual["blob_key"],
            # 0034/R9: sem estes quatro o expurgo não é reconstituível (de que
            # operação/job a prova saiu, de que pasta veio, se era restrita).
            "operacaoId": _uuid_str(atual["operacao_id"]),
            "importJobId": _uuid_str(atual["import_job_id"]),
            "origemPath": atual["origem_path"],
            "restrito": atual["restrito"],
        },
    )

    await db.commit()

    # ── Resposta: { ok: true, message: "Documento removido com sucesso" }. ────
    return JSONResponse(
        content={"ok": True, "message": "Documento removido com sucesso"}
    )
