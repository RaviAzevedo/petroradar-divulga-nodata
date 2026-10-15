"""Rota MIGRADA (estrangulador / strangler-fig):
    /api/conformidade/import/scan

Espelho 1:1 de
``src/app/api/conformidade/import/scan/route.ts`` — endpoint que recebe arquivos
da rede SGI (1 a 1), enviados pelo CLI de sincronização. O ``pathRelativo`` do
body decide o destino (família / cofre / ACT / contrato). Replica o ÚNICO handler
do Next (POST) com a MESMA ordem de checagens, MESMAS validações, MESMAS operações
de banco, MESMO upload pro S3/MinIO e MESMO shape de resposta.

──────────────────────────────────────────────────────────────────────────────
AUTENTICAÇÃO (réplica de ``autenticar(request)`` — DUAL, NÃO um require_* puro)
──────────────────────────────────────────────────────────────────────────────
O Next NÃO usa um guard padrão aqui. Ele tem uma função ``autenticar`` própria:

  (a) Se ``Authorization: Bearer <token>`` → é um IMPORT-TOKEN (JWT HS256 próprio,
      ``kind: "import_cli"``, emitido por /api/conformidade/import/token via
      ``gerarImportToken``). Valida com ``verificarImportToken`` (HS256 + AUTH_SECRET):
        - token inválido/expirado/kind errado     → 401 {"error":"Token de importação inválido ou expirado"}
        - válido mas role sem permissão de import  → 403 {"error":"Token sem permissão de importação"}
      ``podeImportarConformidade(role)`` = ``isConformidade(role)`` = role ∈ {ADMIN, LIDER, SGI}.

  (b) Senão → sessão NextAuth (``auth()``):
        - sem sessão       → 401 {"error":"Não autenticado"}
        - role sem permissão → 403 {"error":"Permissão negada"}

  CUIDADO: o import-token e a sessão NextAuth são tokens DIFERENTES, ambos
  chegando via ``Authorization: Bearer`` ou cookie. O import-token é um JWS HS256
  de 3 segmentos com ``kind: "import_cli"``; a sessão NextAuth v5 é um JWE de 5
  segmentos (ou JWS HS256 de teste SEM ``kind``). Para reproduzir o Next à risca
  (que SEMPRE tenta o import-token primeiro quando há header Bearer), tentamos
  primeiro decodificar como import-token (HS256 + kind=="import_cli"); só caímos
  no ``get_current_user`` (sessão) se NÃO houver header Bearer — exatamente como
  o Next, que só chama ``auth()`` quando o header NÃO começa com "Bearer ".

──────────────────────────────────────────────────────────────────────────────
ORDEM DAS CHECAGENS — SCAN v2 (0034/R13, correções A–D do 02-APIS §12)
──────────────────────────────────────────────────────────────────────────────
  1.  autenticar() → 401/403 (acima)
  2.  parse multipart/form-data           → 400 {"error":"Esperado multipart/form-data"}
  3.  file instanceof File                → 422 {"error":"Arquivo é obrigatório"}
  4.  pathRelativo não-vazio              → 422 {"error":"pathRelativo é obrigatório"}
  5.  sha256 hex de 64 chars              → 422 {"error":"sha256 inválido"}
  6.  file.size <= 50 MB                  → 422 {"error":"Arquivo excede 50 MB"}
  7.  validarTipoArquivo                  → 422
  8.  validarMagicBytes                   → 422
  9.  inferirDestino = DESCONHECIDO (SÓ quando categoria+subcategoria não
      sobrepõem — precedência §12.4)      → 422 {"error":"Path não reconhecido: ..."}
  9b. enums novos inválidos               → 422 com ``code`` (UM erro por
      resposta, na ordem papel → tipoDocumento → situacaoProva → detentora →
      categoria → subcategoria → emitidoEm)
  9c. operacaoCodigo não resolve          → 422 OPERACAO_NAO_ENCONTRADA
  9d. FAMILIA_ANEXO: família não existe (MOVIDO p/ antes do upload — correção
      A: era pós-upload e deixava blob órfão no MinIO a cada 422)  → 422
 10.  dedupe SHA-256 + ADOÇÃO DE ÓRFÃO (correção D) → conta ANTES de retornar
      (correção C) e retorna SEM subir blob
 11.  upload pro S3/MinIO (só chega aqui quem vai gravar — correção A)
 12.  INSERT com operacao_id/papel/tipo_documento/situacao_prova/detentora/
      restrito/emitido_em/numero_documento/import_job_id/origem_path
 13.  contadores do import_job ATÔMICOS (correção B: UPDATE x = x + 1, nunca
      read-modify-write), nos DOIS caminhos; ``erros`` conta TODO 4xx/5xx
      pós-autenticação quando o multipart entregou um jobId que resolve
 14.  resposta 200 (shape unificado v2 — §12.9)

RETROCOMPAT: todos os campos novos do multipart são OPCIONAIS — a chamada
antiga (file+pathRelativo+sha256[+jobId]) segue válida, com os 422
pré-existentes SEM ``code`` e as MESMAS strings. O shape 200 só GANHA chaves.
``documentoId``/``familiaAnexoId`` saem ``null`` quando não preenchidos;
``jobId`` = string recebida ou ``null``.

──────────────────────────────────────────────────────────────────────────────
SERIALIZAÇÃO
──────────────────────────────────────────────────────────────────────────────
A resposta deste endpoint carrega só strings/bool/null (ids como string, flags).
``documentoId``/``familiaAnexoId`` são UUIDs vindos do ``RETURNING id`` →
convertidos via ``str()``. Datas (validade_fim) só vão pro banco, não pra resposta.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json as _json
import re
import time
import unicodedata
from datetime import date as _date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import (
    CurrentUser,
    get_current_user,
    is_conformidade,
)
from app.db.session import get_db
from app.services.audit import registrar_audit

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Tuplas de domínio do scan v2 (0034) — espelham src/lib/conformidade/operacoes.ts
# e cofre/validations.ts. A ORDEM importa só para leitura; os 422 do scan citam
# o VALOR recebido, não a lista.
# ══════════════════════════════════════════════════════════════════════════════
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

_DATA_YMD_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_UUID_SOLTO_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


# ══════════════════════════════════════════════════════════════════════════════
# Permissão de importação (espelha podeImportarConformidade de permissions.ts)
# ══════════════════════════════════════════════════════════════════════════════
# podeImportarConformidade(role) = isConformidade(role) = role ∈ {ADMIN, LIDER, SGI}
def _pode_importar_conformidade(role: str) -> bool:
    return is_conformidade(role)


# ══════════════════════════════════════════════════════════════════════════════
# verificarImportToken — réplica de src/lib/conformidade/import-tokens.ts
# ══════════════════════════════════════════════════════════════════════════════
# JWT HS256 assinado com AUTH_SECRET (ou NEXTAUTH_SECRET). Payload mínimo:
#   { sub, role, kind: "import_cli", jti, iat, exp }
# Validação: assinatura HS256 OK + kind == "import_cli" + exp >= now. Senão → None.
def _b64url_decode(s: str) -> bytes:
    # Restaura o padding que o base64url do JWT omite (igual ao decode do Next).
    pad = "===" [: (4 - len(s) % 4) % 4]
    b64 = s.replace("-", "+").replace("_", "/") + pad
    return base64.b64decode(b64)


def _verificar_import_token(token: str) -> dict | None:
    """Réplica de ``verificarImportToken``: valida JWS HS256 + kind + exp.

    Retorna o payload (dict) se válido, ou ``None`` em QUALQUER falha (assinatura,
    formato, kind != "import_cli", expirado) — exatamente como o Next, que devolve
    ``null`` e o handler converte em 401.
    """
    secret = settings.jwt_secret
    if not secret:
        # getKey() do Next lança se não houver segredo; aqui tratamos como falha.
        return None

    partes = token.split(".")
    if len(partes) != 3:
        return None
    header_b64, payload_b64, sig_b64 = partes

    try:
        # Assinatura HMAC-SHA256 sobre "<header>.<payload>" (comparação constante).
        esperado = hmac.new(
            secret.encode("utf-8"),
            f"{header_b64}.{payload_b64}".encode("utf-8"),
            hashlib.sha256,
        ).digest()
        recebido = _b64url_decode(sig_b64)
        if not hmac.compare_digest(esperado, recebido):
            return None

        payload = _json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        if payload.get("kind") != "import_cli":
            return None
        # PARIDADE 1:1 com o Next (``if (payload.exp < now) return null``): no JS
        # ``undefined < number`` é ``false``, então um token SEM ``exp`` (ou com
        # ``exp`` não-numérico) NÃO é rejeitado por expiração — passa, desde que
        # kind/assinatura estejam OK. Só rejeitamos quando ``exp`` EXISTE e já
        # passou. (Tokens reais sempre carregam ``exp`` via ``gerarImportToken``;
        # isto só afeta tokens forjados/malformados sem ``exp``.)
        exp = payload.get("exp")
        if isinstance(exp, (int, float)) and exp < int(time.time()):
            return None
        return payload
    except Exception:  # noqa: BLE001 — qualquer erro de decode = token inválido
        return None


# ══════════════════════════════════════════════════════════════════════════════
# autenticar — réplica de autenticar(request) do Next (dual: import-token | sessão)
# ══════════════════════════════════════════════════════════════════════════════
class _AuthInfo:
    """Espelha ``AuthInfo { userId, role }`` do Next."""

    __slots__ = ("user_id", "role")

    def __init__(self, user_id: str, role: str) -> None:
        self.user_id = user_id
        self.role = role


class _AuthErro:
    """Espelha ``{ erro, status }`` do Next."""

    __slots__ = ("erro", "status")

    def __init__(self, erro: str, status: int) -> None:
        self.erro = erro
        self.status = status


def _request_sem_authorization(request: Request) -> Request:
    """Cópia rasa do Request com o header ``Authorization`` REMOVIDO.

    PARIDADE 1:1 com ``auth()`` do NextAuth: a sessão (``session.strategy="jwt"``)
    é lida EXCLUSIVAMENTE do COOKIE — ``auth()`` nunca olha o header
    ``Authorization``. Já o ``get_current_user`` do BFF, via ``_extrair_token``,
    daria preferência a um header ``bearer <token>`` minúsculo (que NÃO casa com
    ``"Bearer "`` e por isso cai neste fallback de sessão). Para o fallback ser
    cookie-only — como o Next — entregamos ao ``get_current_user`` um Request sem
    o header ``Authorization``, forçando-o a ler o token de sessão do cookie.
    O header ``cookie`` é preservado, então ``request.cookies`` continua íntegro.
    """
    from starlette.requests import Request as _StarletteRequest

    scope = dict(request.scope)
    scope["headers"] = [
        (nome, valor)
        for (nome, valor) in request.scope.get("headers", [])
        if nome.lower() != b"authorization"
    ]
    return _StarletteRequest(scope, receive=request._receive)


async def _autenticar(request: Request) -> _AuthInfo | _AuthErro:
    auth_header = request.headers.get("authorization") or ""
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        payload = _verificar_import_token(token)
        if not payload:
            return _AuthErro("Token de importação inválido ou expirado", 401)
        if not _pode_importar_conformidade(payload.get("role")):
            return _AuthErro("Token sem permissão de importação", 403)
        return _AuthInfo(str(payload.get("sub")), payload.get("role"))

    # Sem header "Bearer " (com B maiúsculo) → sessão NextAuth (auth()). O auth()
    # do NextAuth lê o token de sessão SOMENTE do cookie; nunca do Authorization.
    # Por isso passamos um Request SEM o header Authorization para get_current_user
    # (cookie-only), evitando que um `Authorization: bearer <jwt-de-sessão>`
    # minúsculo autentique aqui — o Next o ignoraria e responderia 401.
    try:
        user = await get_current_user(_request_sem_authorization(request))
    except Exception:  # noqa: BLE001 — sessão ausente/inválida = não autenticado
        return _AuthErro("Não autenticado", 401)

    if not _pode_importar_conformidade(user.role):
        return _AuthErro("Permissão negada", 403)
    return _AuthInfo(user.id, user.role)


# ══════════════════════════════════════════════════════════════════════════════
# sanitizarNome — réplica de sanitizarNome do route.ts
# ══════════════════════════════════════════════════════════════════════════════
# .normalize("NFD") → remove combining marks → ".." → "_" → [^a-zA-Z0-9._-] → "_"
_COMBINING_RE = re.compile(r"[̀-ͯ]")
_NAO_PERMITIDO_RE = re.compile(r"[^a-zA-Z0-9._-]")


def _sanitizar_nome(s: str) -> str:
    nfd = unicodedata.normalize("NFD", s)
    nfd = _COMBINING_RE.sub("", nfd)
    nfd = nfd.replace("..", "_")
    return _NAO_PERMITIDO_RE.sub("_", nfd)


# ══════════════════════════════════════════════════════════════════════════════
# validarTipoArquivo / validarMagicBytes — réplica de lib/storage/upload.ts
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
    partes = nome.split(".")
    ext = "." + (partes[-1].lower() if len(partes) > 1 and partes[-1] else "")
    if content_type not in _TIPOS_PERMITIDOS and ext not in _EXTENSOES_PERMITIDAS:
        return False, "Tipo de arquivo não permitido. Use: PDF, XLS, XLSX, DOC ou DOCX."
    return True, None


def _is_pdf(b: bytes) -> bool:
    return len(b) >= 4 and b[0] == 0x25 and b[1] == 0x50 and b[2] == 0x44 and b[3] == 0x46


def _is_zip(b: bytes) -> bool:
    return len(b) >= 4 and b[0] == 0x50 and b[1] == 0x4B and b[2] == 0x03 and b[3] == 0x04


def _is_ole2(b: bytes) -> bool:
    return len(b) >= 4 and b[0] == 0xD0 and b[1] == 0xCF and b[2] == 0x11 and b[3] == 0xE0


def _validar_magic_bytes(conteudo: bytes) -> tuple[bool, str | None]:
    try:
        head = conteudo[:8]
        if _is_pdf(head) or _is_zip(head) or _is_ole2(head):
            return True, None
        return (
            False,
            "O conteúdo do arquivo não corresponde ao tipo declarado. "
            "Apenas PDF, XLS, XLSX, DOC e DOCX são permitidos.",
        )
    except Exception:  # noqa: BLE001
        return False, "Não foi possível verificar o conteúdo do arquivo."


# ══════════════════════════════════════════════════════════════════════════════
# normalizarCodigoCrc — réplica de familias/validations.ts
# ══════════════════════════════════════════════════════════════════════════════
_NAO_ALNUM_RE = re.compile(r"[^a-zA-Z0-9]")


def _normalizar_codigo_crc(codigo: str) -> str:
    nfd = unicodedata.normalize("NFD", codigo)
    nfd = _COMBINING_RE.sub("", nfd)
    return _NAO_ALNUM_RE.sub("", nfd).upper()


# ══════════════════════════════════════════════════════════════════════════════
# inferirDestino / extrairValidadeDoNome / tituloDoNome — réplica de
# lib/conformidade/inferir-categoria.ts
# ══════════════════════════════════════════════════════════════════════════════
_NOME_TO_CATEGORIA: dict[str, dict[str, str]] = {
    "01_juridica": {"categoria": "JURIDICA", "defaultSub": "CONTRATO_SOCIAL"},
    "02_fiscal": {"categoria": "FISCAL", "defaultSub": "CND_FEDERAL"},
    "03_economica": {"categoria": "ECONOMICA", "defaultSub": "BALANCO"},
    "04_tecnica": {"categoria": "TECNICA", "defaultSub": "OUTROS_TECNICOS"},
    "05_pessoal": {"categoria": "QUALIFICACAO_PESSOAL", "defaultSub": "CREA_PJ"},
    "06_declaracoes": {"categoria": "DECLARACAO", "defaultSub": "DECL_OUTRA"},
}

# Mapeamento de palavras-chave no nome do arquivo → subcategoria (ORDEM importa:
# primeiro match vence, igual ao for-of com break do Next).
_KEYWORDS_SUBCATEGORIA: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"cnd[_-]?federal|pgfn|receita", re.I), "CND_FEDERAL"),
    (re.compile(r"fgts|crf", re.I), "FGTS"),
    (re.compile(r"cndt", re.I), "CNDT"),
    (re.compile(r"cnd[_-]?estadual|sefaz", re.I), "CND_ESTADUAL"),
    (re.compile(r"cnd[_-]?municipal", re.I), "CND_MUNICIPAL"),
    (re.compile(r"falencia|concordata", re.I), "FALENCIA"),
    (re.compile(r"balanco|dre|dfc", re.I), "BALANCO"),
    (re.compile(r"indices|liquidez", re.I), "INDICES_FINANCEIROS"),
    (re.compile(r"contrato[_-]?social", re.I), "CONTRATO_SOCIAL"),
    (re.compile(r"cartao[_-]?cnpj|cnpj", re.I), "CNPJ"),
    (re.compile(r"ato[_-]?constitutivo", re.I), "ATO_CONSTITUTIVO"),
    (re.compile(r"procuracao", re.I), "PROCURACAO"),
    (re.compile(r"act|atestado", re.I), "ATESTADO_ACT"),
    (re.compile(r"iso[_-]?9001", re.I), "ISO_9001"),
    (re.compile(r"iso[_-]?14001", re.I), "ISO_14001"),
    (re.compile(r"iso[_-]?45001", re.I), "ISO_45001"),
    (re.compile(r"nr[_-]?10", re.I), "NR_10"),
    (re.compile(r"nr[_-]?13", re.I), "NR_13"),
    (re.compile(r"nr[_-]?35", re.I), "NR_35"),
    (re.compile(r"asme", re.I), "ASME"),
    (re.compile(r"api[_-]?q1", re.I), "API_Q1"),
    (re.compile(r"api[_-]?6d", re.I), "API_6D"),
    (re.compile(r"\bped\b", re.I), "PED"),
    (re.compile(r"crea[_-]?pj", re.I), "CREA_PJ"),
    (re.compile(r"crea[_-]?pf", re.I), "CREA_PF"),
    (re.compile(r"\bart\b|\bcat\b", re.I), "ART_CAT"),
    (re.compile(r"ctps", re.I), "CTPS"),
    (re.compile(r"formacao|diploma", re.I), "FORMACAO"),
    (re.compile(r"menor[_-]?nao[_-]?emprega", re.I), "DECL_MENOR_NAO_EMPREGA"),
    (re.compile(r"idoneidade", re.I), "DECL_IDONEIDADE"),
    (re.compile(r"me[_-]?epp", re.I), "DECL_ME_EPP"),
)


def _normalizar_segmento(s: str) -> str:
    nfd = unicodedata.normalize("NFD", s)
    nfd = _COMBINING_RE.sub("", nfd)
    return nfd.lower()


def _inferir_destino(path_relativo: str) -> dict[str, Any]:
    """Réplica de ``inferirDestino``. Devolve dict com chave ``tipo`` e campos.

    Tipos: FAMILIA_ANEXO / DOCUMENTO_HABILITACAO / ACT / CONTRATO_ANEXO /
    DESCONHECIDO. Mantém os MESMOS campos do Next por tipo.
    """
    # Normaliza separadores e tira leading slashes (igual ao regex do Next).
    normalizado = re.sub(r"^/+", "", path_relativo.replace("\\", "/"))
    partes = normalizado.split("/")
    if len(partes) < 2:
        return {"tipo": "DESCONHECIDO", "motivo": "Path muito curto pra inferir"}

    top = _normalizar_segmento(partes[0])
    arquivo = partes[-1]

    # 01_Familias/<codigo>_<nome>/<arquivo>
    if top.startswith("01_familias") or top == "familias":
        familia_seg = partes[1] if len(partes) > 1 else ""
        m = re.match(r"^([A-Za-z0-9.\-]+)", familia_seg)
        codigo = m.group(1) if m else familia_seg
        return {"tipo": "FAMILIA_ANEXO", "codigoFamilia": codigo}

    # 02_Habilitacao/<categoria>/<arquivo>
    if top.startswith("02_habilitacao") or top == "habilitacao":
        cat_seg = _normalizar_segmento(partes[1] if len(partes) > 1 else "")
        meta = _NOME_TO_CATEGORIA.get(cat_seg)
        if not meta:
            return {"tipo": "DESCONHECIDO", "motivo": f"Categoria desconhecida: {cat_seg}"}
        sub = meta["defaultSub"]
        for regex, kw_sub in _KEYWORDS_SUBCATEGORIA:
            if regex.search(arquivo):
                sub = kw_sub
                break
        return {
            "tipo": "DOCUMENTO_HABILITACAO",
            "categoria": meta["categoria"],
            "subcategoria": sub,
        }

    # 03_Atestados_ACT/<arquivo>
    if top.startswith("03_atestados") or top == "atestados_act" or top == "act":
        return {"tipo": "ACT", "categoria": "TECNICA", "subcategoria": "ATESTADO_ACT"}

    # 04_Contratos/<numero>_<descricao>/<arquivo>
    if top.startswith("04_contratos") or top == "contratos":
        contrato_seg = partes[1] if len(partes) > 1 else ""
        m = re.match(r"^([0-9A-Za-z\-]+)", contrato_seg)
        numero = m.group(1) if m else contrato_seg
        return {"tipo": "CONTRATO_ANEXO", "numeroContrato": numero}

    return {"tipo": "DESCONHECIDO", "motivo": f'Top-level "{top}" não reconhecido'}


_VALIDADE_RE = re.compile(r"[_\-](\d{4}-\d{2}-\d{2})(?:\.[a-z]+)?$", re.I)


def _extrair_validade_do_nome(nome: str) -> datetime | None:
    """Réplica de ``extrairValidadeDoNome``: `_YYYY-MM-DD.pdf` → datetime UTC.

    PARIDADE 1:1 com o Next (``new Date("YYYY-MM-DDT00:00:00Z")`` + ``isNaN``):
    o ``Date`` do JS faz ROLL-OVER de datas calendário-inválidas mas digitalmente
    bem-formadas (ex.: ``2026-02-30`` → ``2026-03-02``; ``2026-04-31`` → ``2026-05-01``)
    e só vira ``NaN`` (→ ``None``) quando mês ∉ 1..12 ou dia ∉ 1..31. Por isso NÃO
    usamos ``strptime`` estrito (que rejeitaria Fev 30 como ValueError e gravaria
    ``validade_fim=NULL`` + ``validade_indeterminada=TRUE`` — divergente do Next).
    Em vez disso replicamos o mesmo rollover: ``datetime(ano, mes, 1) + (dia-1)``,
    equivalente a ``Date.UTC(ano, mes-1, dia)``.
    """
    m = _VALIDADE_RE.search(nome)
    if not m:
        return None
    ano_s, mes_s, dia_s = m.group(1).split("-")
    ano, mes, dia = int(ano_s), int(mes_s), int(dia_s)
    # Limites que o JS Date rejeita como NaN (mês 00/>12, dia 00/>31) → None.
    if not (1 <= mes <= 12) or not (1 <= dia <= 31):
        return None
    try:
        # Rollover idêntico ao new Date: parte do 1º dia do mês e soma (dia-1).
        # (ex.: Fev 30 = 1º Fev + 29 dias = 2 Mar — mesmo que o JS.)
        return datetime(ano, mes, 1, tzinfo=timezone.utc) + timedelta(days=dia - 1)
    except (ValueError, OverflowError):
        # Anos fora do range representável pelo datetime do Python (ex.: 0000),
        # que o JS aceitaria — sub-edge raro; tratamos como inválido (None).
        return None


def _titulo_do_nome(nome: str) -> str:
    """Réplica de ``tituloDoNome``: remove extensão, timestamp prefixo e separadores."""
    s = re.sub(r"\.[a-z]+$", "", nome, flags=re.I)
    s = re.sub(r"^\d+_", "", s)
    s = re.sub(r"[_\-]", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


# ══════════════════════════════════════════════════════════════════════════════
# uploadByKey — réplica de uploadKey/uploadByKey (lib/storage/upload.ts) via boto3
# ══════════════════════════════════════════════════════════════════════════════
def _upload_by_key(key: str, conteudo: bytes, content_type: str | None) -> dict[str, Any]:
    """Sobe o objeto no S3/MinIO (PutObject) e devolve {url, key, contentType, size}.

    Espelha ``uploadKey``: ContentType cai pra ``application/octet-stream`` quando
    ausente; ``size`` é o length do corpo; ``url`` é a URL canônica do objeto.
    O Next usa ``file.type`` como content-type (mesmo valor passado aqui).
    """
    import boto3  # import tardio: storage fora do caminho quente quando dedupe.

    ct = content_type or "application/octet-stream"

    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint or None,
        aws_access_key_id=settings.s3_access_key or None,
        aws_secret_access_key=settings.s3_secret_key or None,
    )
    client.put_object(
        Bucket=settings.s3_bucket,
        Key=key,
        Body=conteudo,
        ContentType=ct,
    )

    endpoint = (settings.s3_endpoint or "").rstrip("/")
    url = f"{endpoint}/{settings.s3_bucket}/{key}" if endpoint else f"{settings.s3_bucket}/{key}"

    return {"url": url, "key": key, "contentType": ct, "size": len(conteudo)}


def _uuid_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    return str(value)


# ══════════════════════════════════════════════════════════════════════════════
# Contadores atômicos do import_job (correção B — nunca read-modify-write)
# ══════════════════════════════════════════════════════════════════════════════

# desfecho → colunas incrementadas. ``processados`` conta só desfechos de
# sucesso (um 422 não processou arquivo); ``erros`` conta os 4xx/5xx.
_INCREMENTO_SQL = {
    "INSERIDO": "processados = processados + 1, novos = novos + 1",
    "DEDUPE": "processados = processados + 1, ignorados = ignorados + 1",
    "DEDUPE_ADOTADO": "processados = processados + 1, atualizados = atualizados + 1",
    "ERRO": "erros = erros + 1",
}


async def _resolver_job(db, job_id_param: str) -> str | None:
    """jobId do multipart → uuid canônico SE existir em ``import_jobs``.

    jobId que não é UUID ou não existe: ``None`` (contadores pulados e
    ``import_job_id = NULL`` — mantém o best-effort atual, decisão declarada
    do §12.7). O regex evita o DataError do asyncpg no cast.
    """
    if not job_id_param or not _UUID_SOLTO_RE.match(job_id_param):
        return None
    row = (
        await db.execute(
            text("SELECT id FROM import_jobs WHERE id = CAST(:id AS uuid) LIMIT 1"),
            {"id": job_id_param},
        )
    ).first()
    return str(row[0]) if row is not None else None


async def _incrementar_job(db, job_uuid: str | None, desfecho: str) -> None:
    """UM UPDATE atômico por resultado (correção B), best-effort com commit
    próprio — o contador nunca derruba o scan (catch vazio do Next)."""
    if not job_uuid:
        return
    try:
        await db.execute(
            text(
                f"UPDATE import_jobs SET {_INCREMENTO_SQL[desfecho]} "
                f"WHERE id = CAST(:job AS uuid)"
            ),
            {"job": job_uuid},
        )
        await db.commit()
    except Exception:  # noqa: BLE001 — best-effort
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/conformidade/import/scan  (v2 — retrocompatível, sem /v2: ADR-08)
# ══════════════════════════════════════════════════════════════════════════════
@router.post("/api/conformidade/import/scan")
async def post_scan(request: Request, db=Depends(get_db)) -> JSONResponse:
    """Wrapper fino: garante que TODO 5xx pós-autenticação conte em ``erros``
    (§12.8) antes de o middleware global responder 500. O jobId resolvido é
    comunicado pela implementação via ``ctx`` (só conta quando o multipart
    entregou um jobId que resolve)."""
    ctx: dict[str, str | None] = {"job_uuid": None}
    try:
        return await _post_scan_impl(request, db, ctx)
    except Exception:
        # A transação pode ter morrido no meio — rollback antes do contador.
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        await _incrementar_job(db, ctx["job_uuid"], "ERRO")
        raise


async def _post_scan_impl(
    request: Request, db, ctx: dict[str, str | None]
) -> JSONResponse:
    # ── 1. Autenticação (dual: import-token | sessão) ─────────────────────────
    a = await _autenticar(request)
    if isinstance(a, _AuthErro):
        return JSONResponse({"error": a.erro}, status_code=a.status)

    # ── 2. Parse do multipart/form-data ───────────────────────────────────────
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001 — body não-multipart
        return JSONResponse(
            {"error": "Esperado multipart/form-data"}, status_code=400
        )

    file = form.get("file")
    path_relativo = str(form.get("pathRelativo") or "").strip()
    sha256 = str(form.get("sha256") or "").strip()
    job_id_param = str(form.get("jobId") or "").strip()

    # Campos NOVOS do multipart (0034/R13) — TODOS opcionais; '' vira ausência
    # (formData.get(k) || undefined, padrão dos irmãos).
    def _form_opt(k: str) -> str | None:
        v = form.get(k)
        return v if isinstance(v, str) and v != "" else None

    operacao_codigo = _form_opt("operacaoCodigo")
    papel = _form_opt("papel")
    tipo_documento = _form_opt("tipoDocumento")
    situacao_prova = _form_opt("situacaoProva")
    detentora = _form_opt("detentora")
    restrito_raw = form.get("restrito")
    # flag: "true"/"1" → true; QUALQUER outra coisa (inclusive ausente) → false.
    restrito = restrito_raw == "true" or restrito_raw == "1"
    categoria_over = _form_opt("categoria")
    subcategoria_over = _form_opt("subcategoria")
    emitido_em_raw = _form_opt("emitidoEm")
    numero_documento = _form_opt("numeroDocumento")
    origem_path_param = _form_opt("origemPath")

    # jobId resolvido CEDO: a partir daqui todo 4xx/5xx conta em ``erros``
    # (correção B/§12.8 — só quando o multipart entregou um jobId que resolve).
    job_uuid = await _resolver_job(db, job_id_param)
    ctx["job_uuid"] = job_uuid  # o wrapper usa no try/catch de 5xx

    async def _erro(resp: JSONResponse) -> JSONResponse:
        """4xx pós-autenticação: incrementa ``erros`` (atômico) e devolve."""
        await _incrementar_job(db, job_uuid, "ERRO")
        return resp

    # ── 3. file é um arquivo (instanceof File) ────────────────────────────────
    # Em Starlette, uploads de arquivo são UploadFile (têm .filename/.read).
    if file is None or not hasattr(file, "filename") or not hasattr(file, "read"):
        return await _erro(
            JSONResponse({"error": "Arquivo é obrigatório"}, status_code=422)
        )

    # ── 4. pathRelativo obrigatório ───────────────────────────────────────────
    if not path_relativo:
        return await _erro(
            JSONResponse({"error": "pathRelativo é obrigatório"}, status_code=422)
        )

    # ── 5. sha256 hex 64 chars ────────────────────────────────────────────────
    if not re.fullmatch(r"[0-9a-f]{64}", sha256, re.I):
        return await _erro(
            JSONResponse({"error": "sha256 inválido"}, status_code=422)
        )

    # Lê o conteúdo (precisamos do tamanho, magic-bytes e corpo pro upload).
    conteudo: bytes = await file.read()
    file_name: str = file.filename or ""
    file_type: str = file.content_type or ""
    file_size: int = len(conteudo)

    # ── 6. file.size <= 50 MB ─────────────────────────────────────────────────
    if file_size > 50 * 1024 * 1024:
        return await _erro(
            JSONResponse({"error": "Arquivo excede 50 MB"}, status_code=422)
        )

    # ── 7. validarTipoArquivo (ext + content-type) ────────────────────────────
    tipo_ok, tipo_erro = _validar_tipo_arquivo(file_name, file_type)
    if not tipo_ok:
        return await _erro(
            JSONResponse(
                {"error": tipo_erro or "Tipo de arquivo não permitido"},
                status_code=422,
            )
        )

    # ── 8. validarMagicBytes (1ºs bytes) ──────────────────────────────────────
    magic_ok, magic_erro = _validar_magic_bytes(conteudo)
    if not magic_ok:
        return await _erro(
            JSONResponse(
                {
                    "error": magic_erro
                    or "Conteúdo do arquivo não corresponde ao tipo declarado"
                },
                status_code=422,
            )
        )

    # ── 9. Destino: precedência única (§12.4) ─────────────────────────────────
    # ``categoria`` E ``subcategoria`` AMBAS presentes e válidas → destino
    # DOCUMENTO_HABILITACAO com esse par; ``inferirDestino`` NEM RODA
    # (pathRelativo vira só procedência). Caso contrário → inferirDestino como
    # hoje (e o 422 de path desconhecido MANTÉM a string antiga, sem code).
    sobrepoe = (
        categoria_over is not None
        and categoria_over in _CATEGORIAS
        and subcategoria_over is not None
        and subcategoria_over in _SUBCATEGORIAS
    )
    if sobrepoe:
        destino = {
            "tipo": "DOCUMENTO_HABILITACAO",
            "categoria": categoria_over,
            "subcategoria": subcategoria_over,
        }
    else:
        destino = _inferir_destino(path_relativo)
        if destino["tipo"] == "DESCONHECIDO":
            return await _erro(
                JSONResponse(
                    {
                        "error": f'Path não reconhecido: {destino["motivo"]}',
                        "pathRelativo": path_relativo,
                    },
                    status_code=422,
                )
            )

    # ── 9b. Enums novos (0034) — UM erro por resposta, nesta ordem (§12.5) ────
    # Nada foi escrito, nenhum blob subiu: 422 com ``code`` estável.
    erro_9b: tuple[str, str] | None = None  # (mensagem, code)
    if papel is not None and papel not in _PAPEIS:
        erro_9b = (f"papel inválido: {papel}", "PAPEL_INVALIDO")
    elif tipo_documento is not None and tipo_documento not in _TIPOS_DOCUMENTO:
        erro_9b = (f"tipoDocumento inválido: {tipo_documento}", "TIPO_DOCUMENTO_INVALIDO")
    elif situacao_prova is not None and situacao_prova not in _SITUACOES_PROVA:
        erro_9b = (f"situacaoProva inválida: {situacao_prova}", "SITUACAO_PROVA_INVALIDA")
    elif detentora is not None and detentora not in _DETENTORAS:
        erro_9b = (f"detentora inválida: {detentora}", "DETENTORA_INVALIDA")
    elif categoria_over is not None and categoria_over not in _CATEGORIAS:
        erro_9b = (f"categoria inválida: {categoria_over}", "CATEGORIA_INVALIDA")
    elif subcategoria_over is not None and subcategoria_over not in _SUBCATEGORIAS:
        erro_9b = (f"subcategoria inválida: {subcategoria_over}", "SUBCATEGORIA_INVALIDA")
    elif emitido_em_raw is not None:
        # ehDataIso: regex + calendário (date.fromisoformat recusa 2019-02-31).
        if not _DATA_YMD_RE.match(emitido_em_raw):
            erro_9b = ("emitidoEm inválido: use YYYY-MM-DD", "EMITIDO_EM_INVALIDO")
        else:
            try:
                _date.fromisoformat(emitido_em_raw)
            except ValueError:
                erro_9b = ("emitidoEm inválido: use YYYY-MM-DD", "EMITIDO_EM_INVALIDO")
    if erro_9b is not None:
        return await _erro(
            JSONResponse(
                {"error": erro_9b[0], "code": erro_9b[1]}, status_code=422
            )
        )

    # emitido_em: meia-noite UTC ("new Date('AAAA-MM-DD')" no Next = 00:00:00Z;
    # aqui datetime aware — bind datetime, coluna timestamptz).
    emitido_em_dt: datetime | None = None
    if emitido_em_raw is not None:
        d = _date.fromisoformat(emitido_em_raw)
        emitido_em_dt = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)

    # ── 9c. operacaoCodigo → operacao_id (chave de negócio, não uuid: ADR-09) ─
    # O scan NUNCA cria operação — o conserto de um código órfão é seed
    # aprovado (P4), nunca criação automática.
    operacao_id: str | None = None
    operacao_detentora: str | None = None
    if operacao_codigo is not None:
        op = (
            await db.execute(
                text(
                    "SELECT id, detentora FROM operacoes "
                    "WHERE codigo = :codigo LIMIT 1"
                ),
                {"codigo": operacao_codigo},
            )
        ).mappings().first()
        if op is None:
            return await _erro(
                JSONResponse(
                    {
                        "error": (
                            f'Operação "{operacao_codigo}" não cadastrada — '
                            "semeie o catálogo antes de importar"
                        ),
                        "code": "OPERACAO_NAO_ENCONTRADA",
                        "operacaoCodigo": operacao_codigo,
                    },
                    status_code=422,
                )
            )
        operacao_id = str(op["id"])
        operacao_detentora = op["detentora"]

    # detentora efetiva: explícita > herdada da operação resolvida > NULL (§12.2).
    detentora_efetiva = detentora if detentora is not None else (
        operacao_detentora if operacao_id is not None else None
    )

    # ── 9d. FAMILIA_ANEXO: família tem de existir ANTES do upload (correção A) ─
    familia_row = None
    if destino["tipo"] == "FAMILIA_ANEXO":
        norm = _normalizar_codigo_crc(destino["codigoFamilia"])
        familia_row = (
            await db.execute(
                text(
                    "SELECT id FROM familias "
                    "WHERE codigo_normalizado = :norm AND deletado_em IS NULL "
                    "LIMIT 1"
                ),
                {"norm": norm},
            )
        ).first()
        if familia_row is None:
            return await _erro(
                JSONResponse(
                    {
                        "ok": False,
                        "tipo": destino["tipo"],
                        "error": (
                            f'Família com código "{destino["codigoFamilia"]}" não '
                            "encontrada — importe o catálogo (planilha) primeiro"
                        ),
                    },
                    status_code=422,
                )
            )

    def _resposta_v2(
        *,
        tipo: str,
        documento_id: str | None,
        familia_anexo_id: str | None,
        dedupe: bool,
        acao: str,
        operacao_id_resp: str | None,
        operacao_codigo_resp: str | None,
        papel_resp: str | None,
        tipo_documento_resp: str | None,
        situacao_prova_resp: str | None,
        detentora_resp: str | None,
        restrito_resp: bool,
        categoria_resp: str | None,
        subcategoria_resp: str | None,
        campos_preenchidos: dict | None = None,
    ) -> JSONResponse:
        """Shape unificado v2 (§12.9): SEMPRE as mesmas chaves; o chamador
        antigo só ganha chaves novas. ``camposPreenchidos`` só no
        DEDUPE_ADOTADO."""
        corpo: dict = {
            "ok": True,
            "tipo": tipo,
            "documentoId": documento_id,
            "familiaAnexoId": familia_anexo_id,
            "jobId": job_id_param or None,
            "dedupe": dedupe,
            "acao": acao,
            "operacaoId": operacao_id_resp,
            "operacaoCodigo": operacao_codigo_resp,
            "papel": papel_resp,
            "tipoDocumento": tipo_documento_resp,
            "situacaoProva": situacao_prova_resp,
            "detentora": detentora_resp,
            "restrito": restrito_resp,
            "categoria": categoria_resp,
            "subcategoria": subcategoria_resp,
        }
        if campos_preenchidos is not None:
            corpo["camposPreenchidos"] = campos_preenchidos
        return JSONResponse(corpo)

    # ── 10. Dedupe SHA-256 + ADOÇÃO DE ÓRFÃO (correção D) ─────────────────────
    # O SELECT traz os campos adotáveis (hoje só trazia id), o codigo da
    # operação existente E restrito/categoria/subcategoria — a resposta ecoa
    # os campos DO EXISTENTE (§12.9), nunca os do request/destino inferido.
    if destino["tipo"] in ("DOCUMENTO_HABILITACAO", "ACT"):
        row = (
            await db.execute(
                text(
                    "SELECT d.id, d.operacao_id, d.papel, d.tipo_documento, "
                    "       d.situacao_prova, d.detentora, "
                    "       d.restrito, d.categoria, d.subcategoria, "
                    "       o.codigo AS operacao_codigo "
                    "FROM documentos_habilitacao d "
                    "LEFT JOIN operacoes o ON o.id = d.operacao_id "
                    "WHERE d.sha256 = :sha "
                    # "O mais antigo vence" — a mesma regra de desempate do
                    # /verificar, para a escolha ser determinística nos dois
                    # lados quando o cofre tem sha duplicado (permitirDuplicata).
                    "ORDER BY d.criado_em ASC, d.id ASC LIMIT 1"
                ),
                {"sha": sha256},
            )
        ).mappings().first()
        if row is not None:
            # camposPreenchidos = campo em que o EXISTENTE é NULL e o request
            # traz valor (a detentora herdada conta). NUNCA sobrescreve valor
            # não-nulo. restrito/origem_path/import_job_id NÃO participam (o
            # doc pertence ao job que o criou).
            campos: dict[str, str] = {}
            if operacao_id is not None and row["operacao_id"] is None:
                campos["operacaoId"] = operacao_id
            if papel is not None and row["papel"] is None:
                campos["papel"] = papel
            if tipo_documento is not None and row["tipo_documento"] is None:
                campos["tipoDocumento"] = tipo_documento
            if situacao_prova is not None and row["situacao_prova"] is None:
                campos["situacaoProva"] = situacao_prova
            if detentora_efetiva is not None and row["detentora"] is None:
                campos["detentora"] = detentora_efetiva

            doc_id = _uuid_str(row["id"])

            if not campos:
                # DEDUPE puro: nada escrito no documento — mas SÓ retorna
                # DEPOIS de contar (correção C).
                await _incrementar_job(db, job_uuid, "DEDUPE")
                return _resposta_v2(
                    tipo=destino["tipo"],
                    documento_id=doc_id,
                    familia_anexo_id=None,
                    dedupe=True,
                    acao="DEDUPE",
                    operacao_id_resp=_uuid_str(row["operacao_id"]),
                    operacao_codigo_resp=row["operacao_codigo"],
                    papel_resp=row["papel"],
                    tipo_documento_resp=row["tipo_documento"],
                    situacao_prova_resp=row["situacao_prova"],
                    detentora_resp=row["detentora"],
                    # Eco do EXISTENTE (route.ts): re-scan de doc já restrito
                    # sem a flag responde restrito:true — o ledger do CLI
                    # ancora nesta resposta e registraria sigilo errado.
                    restrito_resp=row["restrito"],
                    categoria_resp=row["categoria"],
                    subcategoria_resp=row["subcategoria"],
                )

            # DEDUPE_ADOTADO: UPDATE condicional (o guard IS NULL repete a
            # regra no banco — corrida entre duas adoções: a 2ª afeta 0 linhas).
            set_parts: list[str] = []
            guard_parts: list[str] = []
            upd_params: dict = {"id": doc_id, "user_id": a.user_id}
            col_por_campo = {
                "operacaoId": ("operacao_id", "CAST(:operacao_id AS uuid)"),
                "papel": ("papel", ":papel"),
                "tipoDocumento": ("tipo_documento", ":tipo_documento"),
                "situacaoProva": ("situacao_prova", ":situacao_prova"),
                "detentora": ("detentora", ":detentora"),
            }
            for campo, valor in campos.items():
                col, bind = col_por_campo[campo]
                set_parts.append(f"{col} = {bind}")
                guard_parts.append(f"{col} IS NULL")
                upd_params[col] = valor
            resultado_upd = await db.execute(
                text(
                    f"UPDATE documentos_habilitacao "
                    f"SET {', '.join(set_parts)}, atualizado_em = now(), "
                    f"    atualizado_por = CAST(:user_id AS uuid) "
                    f"WHERE id = CAST(:id AS uuid) AND {' AND '.join(guard_parts)}"
                ),
                upd_params,
            )

            # A 2ª adoção da corrida afeta 0 linhas e cai no DEDUPE puro —
            # sem audit (nada foi escrito, nada há a desfazer) e contando
            # `ignorados`, como o `adotado = linhas.length > 0` do route.ts.
            if (resultado_upd.rowcount or 0) == 0:
                await _incrementar_job(db, job_uuid, "DEDUPE")
                return _resposta_v2(
                    tipo=destino["tipo"],
                    documento_id=doc_id,
                    familia_anexo_id=None,
                    dedupe=True,
                    acao="DEDUPE",
                    operacao_id_resp=_uuid_str(row["operacao_id"]),
                    operacao_codigo_resp=row["operacao_codigo"],
                    papel_resp=row["papel"],
                    tipo_documento_resp=row["tipo_documento"],
                    situacao_prova_resp=row["situacao_prova"],
                    detentora_resp=row["detentora"],
                    restrito_resp=row["restrito"],
                    categoria_resp=row["categoria"],
                    subcategoria_resp=row["subcategoria"],
                )

            # audit IMPORT_ADOCAO — é DAQUI que o desfazer (R15) reverte
            # adoções sem depender do ledger do CLI (ADR-10).
            await registrar_audit(
                db,
                user_id=a.user_id,
                acao="IMPORT_ADOCAO",
                entidade="documento_habilitacao",
                entidade_id=doc_id,
                detalhes={
                    "jobId": job_uuid or (job_id_param or None),
                    "documentoId": doc_id,
                    "camposPreenchidos": campos,
                },
            )
            await db.commit()

            await _incrementar_job(db, job_uuid, "DEDUPE_ADOTADO")

            return _resposta_v2(
                tipo=destino["tipo"],
                documento_id=doc_id,
                familia_anexo_id=None,
                dedupe=True,
                acao="DEDUPE_ADOTADO",
                # pós-adoção: valor existente OU o recém-preenchido.
                operacao_id_resp=_uuid_str(row["operacao_id"])
                or campos.get("operacaoId"),
                operacao_codigo_resp=row["operacao_codigo"]
                or (operacao_codigo if "operacaoId" in campos else None),
                papel_resp=row["papel"] or campos.get("papel"),
                tipo_documento_resp=row["tipo_documento"]
                or campos.get("tipoDocumento"),
                situacao_prova_resp=row["situacao_prova"]
                or campos.get("situacaoProva"),
                detentora_resp=row["detentora"] or campos.get("detentora"),
                # restrito NÃO participa da adoção — o eco é sempre o do
                # EXISTENTE (route.ts), idem categoria/subcategoria.
                restrito_resp=row["restrito"],
                categoria_resp=row["categoria"],
                subcategoria_resp=row["subcategoria"],
                campos_preenchidos=campos,
            )

    # ── 11. Upload pro S3/MinIO (só chega aqui quem vai gravar) ───────────────
    # Chave de blob INALTERADA (conformidade/cofre/<CAT>/<SUBCAT>/<ts>_<nome> —
    # §1.5 da arquitetura: a árvore "bonita" é do ZIP, não do bucket).
    nome_sanitizado = _sanitizar_nome(file_name)
    timestamp = int(time.time() * 1000)  # Date.now() (ms)

    if destino["tipo"] == "FAMILIA_ANEXO":
        blob_path = (
            f"conformidade/familias/"
            f"{_normalizar_codigo_crc(destino['codigoFamilia'])}/"
            f"{timestamp}_{nome_sanitizado}"
        )
    elif destino["tipo"] in ("DOCUMENTO_HABILITACAO", "ACT"):
        blob_path = (
            f"conformidade/cofre/{destino['categoria']}/"
            f"{destino['subcategoria']}/{timestamp}_{nome_sanitizado}"
        )
    else:  # CONTRATO_ANEXO
        blob_path = (
            f"conformidade/contratos/"
            f"{_sanitizar_nome(destino['numeroContrato'])}/"
            f"{timestamp}_{nome_sanitizado}"
        )

    blob = _upload_by_key(blob_path, conteudo, file_type)

    validade_fim = _extrair_validade_do_nome(file_name)
    titulo = _titulo_do_nome(file_name)

    documento_id: str | None = None
    familia_anexo_id: str | None = None

    # ── 12. INSERT conforme destino ───────────────────────────────────────────
    if destino["tipo"] == "FAMILIA_ANEXO":
        # A família JÁ foi resolvida no 9d (antes do upload — correção A).
        # Tipo do anexo: certificado/crc → CERTIFICADO_CRC; ata/auditoria →
        # ATA_AUDITORIA; senão OUTRO (mesma cascata de regex do Next).
        if re.search(r"certificado|crc", file_name, re.I):
            tipo_anexo = "CERTIFICADO_CRC"
        elif re.search(r"ata|auditoria", file_name, re.I):
            tipo_anexo = "ATA_AUDITORIA"
        else:
            tipo_anexo = "OUTRO"

        novo = (
            await db.execute(
                text(
                    "INSERT INTO familias_anexos "
                    "(familia_id, tipo, nome_arquivo, blob_url, blob_key, "
                    " tamanho_bytes, content_type, validade_fim, uploadado_por) "
                    "VALUES "
                    "(:familia_id, :tipo, :nome_arquivo, :blob_url, :blob_key, "
                    " :tamanho_bytes, :content_type, :validade_fim, :uploadado_por) "
                    "RETURNING id"
                ),
                {
                    "familia_id": familia_row[0],
                    "tipo": tipo_anexo,
                    "nome_arquivo": file_name,
                    "blob_url": blob["url"],
                    "blob_key": blob["key"],
                    "tamanho_bytes": file_size,
                    "content_type": blob["contentType"],
                    "validade_fim": validade_fim,
                    "uploadado_por": a.user_id,
                },
            )
        ).first()
        await db.commit()

        familia_anexo_id = _uuid_str(novo[0])

    elif destino["tipo"] in ("DOCUMENTO_HABILITACAO", "ACT"):
        novo = (
            await db.execute(
                text(
                    "INSERT INTO documentos_habilitacao "
                    "(categoria, subcategoria, titulo, descricao, "
                    " operacao_id, papel, tipo_documento, situacao_prova, "
                    " detentora, restrito, import_job_id, origem_path, "
                    " nome_arquivo, blob_url, blob_key, tamanho_bytes, "
                    " content_type, sha256, numero_documento, emitido_em, "
                    " validade_fim, validade_indeterminada, status, "
                    " uploadado_por, atualizado_por) "
                    "VALUES "
                    "(:categoria, :subcategoria, :titulo, :descricao, "
                    " CAST(:operacao_id AS uuid), :papel, :tipo_documento, "
                    " :situacao_prova, :detentora, :restrito, "
                    " CAST(:import_job_id AS uuid), :origem_path, "
                    " :nome_arquivo, :blob_url, :blob_key, :tamanho_bytes, "
                    " :content_type, :sha256, :numero_documento, :emitido_em, "
                    " :validade_fim, :validade_indeterminada, :status, "
                    " :uploadado_por, :atualizado_por) "
                    "RETURNING id"
                ),
                {
                    "categoria": destino["categoria"],
                    "subcategoria": destino["subcategoria"],
                    "titulo": titulo,
                    "descricao": None,
                    # ── 0034 (§12.7) ─────────────────────────────────────────
                    "operacao_id": operacao_id,
                    "papel": papel,
                    "tipo_documento": tipo_documento,
                    "situacao_prova": situacao_prova,
                    "detentora": detentora_efetiva,
                    "restrito": restrito,
                    "import_job_id": job_uuid,  # N5 — NULL se jobId não resolve
                    "origem_path": origem_path_param or path_relativo,  # N6
                    "numero_documento": numero_documento,
                    "emitido_em": emitido_em_dt,
                    # ─────────────────────────────────────────────────────────
                    "nome_arquivo": file_name,
                    "blob_url": blob["url"],
                    "blob_key": blob["key"],
                    "tamanho_bytes": file_size,
                    "content_type": blob["contentType"],
                    "sha256": sha256,
                    "validade_fim": validade_fim,
                    "validade_indeterminada": validade_fim is None,
                    "status": "VIGENTE",
                    "uploadado_por": a.user_id,
                    "atualizado_por": a.user_id,
                },
            )
        ).first()
        await db.commit()

        documento_id = _uuid_str(novo[0])
    # CONTRATO_ANEXO: nada (Sprint 2) — nenhum INSERT, ambos os ids ficam null.

    # ── 13. Contador atômico (correção B) — desfecho INSERIDO ─────────────────
    await _incrementar_job(db, job_uuid, "INSERIDO")

    # ── 14. Resposta final (shape unificado v2) ───────────────────────────────
    if destino["tipo"] == "FAMILIA_ANEXO":
        # Campos de operação não se aplicam a anexo de família (§12.9).
        return _resposta_v2(
            tipo=destino["tipo"],
            documento_id=None,
            familia_anexo_id=familia_anexo_id,
            dedupe=False,
            acao="INSERIDO",
            operacao_id_resp=None,
            operacao_codigo_resp=None,
            papel_resp=None,
            tipo_documento_resp=None,
            situacao_prova_resp=None,
            detentora_resp=None,
            # Anexo de família não tem sigilo de documento: o Next responde
            # `restrito: false` fixo (parDocumento null), não o eco da flag.
            restrito_resp=False,
            categoria_resp=None,
            subcategoria_resp=None,
        )

    return _resposta_v2(
        tipo=destino["tipo"],
        documento_id=documento_id,
        familia_anexo_id=familia_anexo_id,
        dedupe=False,
        acao="INSERIDO",
        operacao_id_resp=operacao_id,
        operacao_codigo_resp=operacao_codigo,
        papel_resp=papel,
        tipo_documento_resp=tipo_documento,
        situacao_prova_resp=situacao_prova,
        detentora_resp=detentora_efetiva,
        restrito_resp=restrito,
        categoria_resp=destino.get("categoria"),
        subcategoria_resp=destino.get("subcategoria"),
    )
