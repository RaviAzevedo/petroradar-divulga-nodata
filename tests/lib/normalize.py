"""
WP12 §1.3 — Normalização da comparação on-prem × prod.

Antes do diff, zera/ordena/mascara o que é volátil POR DESIGN, sem mascarar o que
é paridade real (shape, papéis, status, contagens, valores de negócio, citações).

NÃO normaliza: chaves do objeto, RBAC, status HTTP, contagens, scores/decisões
heurísticas determinísticas, conteúdo das citações do RAG.
"""
from __future__ import annotations

from typing import Any

VOLATILE_KEYS = {
    "criado_em", "atualizado_em", "enviado_em", "notificado_em",
    "notificado_perfil_em", "classificado_ia_em", "data", "timestamp",
    "custo", "tokens", "custo_usd", "input_tokens", "output_tokens",
    "expires", "exp", "iat", "jti",
    # Espelhos camelCase (o JSON do Next/Drizzle expõe camelCase; a lista acima
    # era só snake_case e deixava criadoEm/atualizadoEm sem normalizar — os
    # goldens self-golden quebrariam num banco re-semeado do zero).
    "criadoEm", "atualizadoEm", "enviadoEm", "notificadoEm",
    "notificadoPerfilEm", "classificadoIaEm", "custoUsd",
    "inputTokens", "outputTokens", "atualizadoEmMs", "geradoEm",
    # Lock de edição de participação: o seed NÃO semeia editando_desde — quem o
    # grava é a própria suíte e2e ao adquirir o lock (now()). Ficava de fora da
    # lista e drifava a CADA execução ("editandoDesde: 2026-07-02… != <hoje>"),
    # derrubando test-parity-self por um volátil de runtime, não por paridade.
    "editando_desde", "editandoDesde",
}
# ids autoincrementais voláteis (mantemos ids de NEGÓCIO como 'numero')
VOLATILE_ID_KEYS = {"id", "uuid", "_id"}


def normalize(obj: Any) -> Any:
    """Normalização completa (modo NORM): zera voláteis, ordena arrays, mascara URLs."""
    return _walk(obj, drop_volatile=True)


def shape_only(obj: Any) -> Any:
    """Modo EXACT: NÃO zera valores de negócio; só ordena arrays e mascara URLs
    assinadas (R2 vs MinIO). Tudo o mais deve bater 1:1."""
    return _walk(obj, drop_volatile=False)


def _walk(obj: Any, drop_volatile: bool) -> Any:
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if drop_volatile and k in VOLATILE_KEYS:
                out[k] = "<volatile>"
            elif drop_volatile and k in VOLATILE_ID_KEYS:
                out[k] = "<id>"
            elif isinstance(v, str) and _is_signed_url(v):
                out[k] = _mask_url(v)
            else:
                out[k] = _walk(v, drop_volatile)
        return out
    if isinstance(obj, list):
        items = [_walk(x, drop_volatile) for x in obj]
        return _stable_sort(items)
    return obj


def _stable_sort(items: list) -> list:
    try:
        return sorted(items, key=lambda x: json_key(x))
    except Exception:  # pragma: no cover
        return items


def json_key(x: Any) -> str:
    if isinstance(x, dict):
        for k in ("numero", "id", "codigo", "key", "origem"):
            if k in x:
                return f"{k}:{x[k]}"
    return repr(x)


def _is_signed_url(s: str) -> bool:
    return s.startswith(("http://minio", "https://", "http://")) and (
        "X-Amz-" in s or "Signature" in s or "/petro-radar/" in s
    )


def _mask_url(s: str) -> str:
    # mantém só o path/key, descarta host + querystring de assinatura (R2≠MinIO por design)
    path = s.split("?")[0]
    if "/petro-radar/" in path:
        return "<key>" + path.split("/petro-radar/", 1)[1]
    return "<url>"


def first_diff(a: Any, b: Any, path: str = "$") -> str:
    if type(a) is not type(b):
        return f"{path}: tipo {type(a).__name__} != {type(b).__name__}"
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                return f"{path}.{k}: ausente em prod"
            if k not in b:
                return f"{path}.{k}: ausente em onprem"
            d = first_diff(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return ""
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: len {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_diff(x, y, f"{path}[{i}]")
            if d:
                return d
        return ""
    return "" if a == b else f"{path}: {a!r} != {b!r}"


# ── helpers de modos SHAPE / RECALL (WP12 §5.1) ──────────────────────────────
def keys_match(prod: dict, onprem: dict) -> bool:
    pj, oj = prod.get("json", {}), onprem.get("json", {})
    return isinstance(pj, dict) and isinstance(oj, dict) and set(pj.keys()) == set(oj.keys())


def effect_persisted(onprem: dict) -> bool:
    """IA: confere que custo/tokens foram persistidos (>0) — paridade de efeito."""
    j = onprem.get("json", {})
    a = j.get("analise") or j.get("minuta") or j
    custo = (a or {}).get("custo")
    return custo is None or float(custo) >= 0  # TODO: checar no DB analises_ia (+1 linha)


def dim_is(onprem: dict, dim: int) -> bool:
    j = onprem.get("json", {})
    return j.get("dimensao") in (dim, None)  # dim vem do serviço de embeddings; default None tolera


def recall_superset(prod: dict, onprem: dict) -> bool:
    """RAG: o conjunto de ORIGENS citadas no on-prem deve conter as do golden-âncora."""
    def origens(o):
        cit = (o.get("json") or {}).get("citacoes") or []
        return {c.get("origem") for c in cit if isinstance(c, dict)}
    p, o = origens(prod), origens(onprem)
    return p.issubset(o) if p else bool(o)
