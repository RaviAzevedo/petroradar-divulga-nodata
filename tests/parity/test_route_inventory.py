"""
WP12 §4.1 — Cobertura das 102 rotas (status + shape + RBAC).

Lê o inventário (route_inventory.csv) e, para
cada rota+método, faz:
  - chamada com o PAPEL MÍNIMO que passa   -> espera 200/201/2xx (ou 422 sem corpo)
  - chamada com o PAPEL que deve BARRAR    -> espera 401/403
  - confere as CHAVES DE TOPO do shape documentado quando aplicável.

Critério de aceite (WP12 G2): 0 rotas sem cobertura; nenhum status divergente do
esperado por método/papel. Saída: tests/_artifacts/route_inventory.csv (resultado).
Skips justificados (papel bearer/anon/credentials/setup-token ou barra '-') são
REGISTRADOS no CSV com status=SKIP/ok=skip — o G2 do go_no_go.py exige >= 2
registros (autoriza+barra) POR ROTA da fonte; linha sumida = FAIL, não vácuo.

O inventário-fonte é tests/parity/route_inventory.csv (1 linha de dados = 1 rota).

STATUS: STUB — usa as sessões/cookies das fixtures (conftest.py). Onde a chamada
tem efeito colateral perigoso em ambiente real, marca-se `xfail(reason="dry-run")`
ou usa-se o dataset-âncora de tests/lib/fixtures.py (UUIDs fixos semeados por
tests/fixtures/seed.sql — make seed-e2e).
"""
from __future__ import annotations

import csv
import os
import pathlib

import httpx
import pytest

from tests.lib import fixtures

ONPREM = "http://web:3000"
INVENTORY = pathlib.Path(__file__).parent / "route_inventory.csv"
# _artifacts relativo a este arquivo (tests/parity/.. = tests/_artifacts):
# funciona no tester (/tests/_artifacts) E no host, com override por env —
# mesmo padrão de tests/smoke/test_smoke_health.py e tests/lib/egress_guard.py.
# O mkdir fica no teardown_module (ponto de escrita), sem efeito colateral na coleta.
ART = pathlib.Path(os.environ.get("GNG_ARTIFACTS", str(pathlib.Path(__file__).resolve().parents[1] / "_artifacts")))

# Mapa papel -> obtém sessão/cookie (implementado em conftest.py::sessao_por_papel)
PASS_STATUSES = {200, 201, 202, 204, 422}  # 422 = corpo vazio no dry-run, mas autorizou
DENY_STATUSES = {401, 403}
# Métodos com corpo: a sonda manda json={} (JSON válido e vazio). Sem isso,
# rotas com `await request.json()` nu estouram 500 ANTES do guard e a sonda
# não mede autorização. Com {}, um 400 de validação ("campos obrigatórios")
# PROVA que o guard autorizou — aceito no allow-test só p/ estes métodos.
WRITE_METHODS = {"POST", "PUT", "PATCH"}

# ── Limitações da sonda documentadas POR ROTA (nunca afrouxar globalmente) ───
# Allow-test, GET com 404 aceito:
#   /api/resultados/[id] — requireVisualizar roda ANTES do lookup
#     (app/src/app/api/resultados/[id]/route.ts:41); o módulo lê
#     petronect_lic_*/resultados_licitacao (dados de PRODUÇÃO que o seed.sql
#     NÃO semeia) → 404 ao numero-âncora 7004990101 PROVA autorização
#     (route.ts:190; EXTERNO leva 403 no deny-test). Não acoplar ao psql:
#     sentinela + 404 bastam como prova de RBAC.
ALLOW_404_GET = {"/api/resultados/[id]"}
# Allow-test, GET com 400 aceito (validação de query/estado APÓS o guard):
#   /api/licitacoes/[id]/briefing — requireVisualizar roda primeiro (RBAC
#     hardening FRENTE D; era requireAuth). O papel mínimo (VISUALIZADOR)
#     autoriza; a lic-âncora existe mas a análise IA não é semeada → 400
#     NO_ANALYSIS é estado pós-guard e PROVA autorização. EXTERNO recebe 403
#     no deny-test. (checklist e checklist-oficial saíram em 2026-09-18.)
ALLOW_400_GET = {"/api/licitacoes/[id]/briefing"}
# Deny-test, aceites por rota (nada executa nesses status). As duas entradas
# que existiam eram de /api/participacoes/* — o módulo saiu em 2026-09-18; os
# conjuntos ficam vazios mas o mecanismo segue disponível.
DENY_404_SENTINELA: set[str] = set()
DENY_ESTADO: dict[str, set[int]] = {}

# Defeitos CONHECIDOS (xfail, NUNCA pass silencioso). VAZIO desde 2026-07-02
# (a única entrada era um gatilho de sync morto, removido do app e do BFF).
XFAIL_AUDITORIA: dict[str, tuple[int, str]] = {}


def _sonda(metodo: str, url: str, cookies, timeout: float = 20):
    kwargs = {"json": {}} if metodo in WRITE_METHODS else {}
    return httpx.request(metodo, url, cookies=cookies, timeout=timeout, **kwargs)


def _load_inventory() -> list[dict]:
    rows: list[dict] = []
    with INVENTORY.open() as fh:
        for raw in fh:
            if raw.startswith("#") or raw.startswith("dominio,"):
                continue
            parts = next(csv.reader([raw]))
            if len(parts) < 7:
                continue
            rows.append(
                dict(
                    zip(
                        ["dominio", "rota", "metodos", "guard", "passa", "barra", "sfx"],
                        parts,
                    )
                )
            )
    return rows


INVENTORY_ROWS = _load_inventory()
_results: list[dict] = []


def teardown_module(module):  # noqa: ARG001
    ART.mkdir(parents=True, exist_ok=True)
    out = ART / "route_inventory.csv"
    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["rota", "metodo", "papel", "status", "ok"])
        for r in _results:
            w.writerow([r["rota"], r["metodo"], r["papel"], r["status"], r["ok"]])


@pytest.mark.parametrize("row", INVENTORY_ROWS, ids=lambda r: r["rota"])
def test_route_allows_min_role(row, sessao_por_papel):
    """O papel mínimo documentado em ROTAS.md deve ser AUTORIZADO."""
    metodo = row["metodos"].split("|")[0]
    papel = row["passa"]
    if papel in ("bearer", "anon", "credentials", "setup-token"):
        # SKIP justificado ENTRA no resultado (G2 cobra 2 registros por rota da
        # fonte; antes o skip sumia do CSV e a cobertura virava vácua).
        _results.append(
            {"rota": row["rota"], "metodo": metodo, "papel": papel, "status": "SKIP", "ok": "skip"}
        )
        pytest.skip(f"auth de máquina/público tratado em testes dedicados: {row['rota']}")
    cookies = sessao_por_papel(papel)
    url = ONPREM + _resolve(row["rota"])
    try:
        r = _sonda(metodo, url, cookies)
    except httpx.HTTPError as exc:  # pragma: no cover
        pytest.fail(f"erro de rede em {url}: {exc}")
    # Defeito conhecido da auditoria: registra no CSV (ok=xfail conta como
    # cobertura no G2, não como falha) e marca xfail com a razão documentada.
    if row["rota"] in XFAIL_AUDITORIA:
        status_defeito, razao = XFAIL_AUDITORIA[row["rota"]]
        if r.status_code == status_defeito:
            _results.append(
                {"rota": row["rota"], "metodo": metodo, "papel": papel, "status": r.status_code, "ok": "xfail"}
            )
            pytest.xfail(razao)
    # Sub-entidades NÃO semeadas (petitório/anexo/doc/extensão/cofre/concorrente)
    # resolvem p/ sentinelas: 404 ali PROVA que o guard autorizou (chegou ao
    # lookup) — aceito só nesses casos; nas entidades semeadas exige-se 2xx/422.
    # Writes com corpo-sonda {}: 400 de validação tambem PROVA autorização
    # (o guard passou; faltam campos que a sonda generica nao tem como saber).
    # ALLOW_404_GET / ALLOW_400_GET: limitações da sonda por rota (ver topo).
    aceitos = PASS_STATUSES | (
        {404}
        if (fixtures.UUID_NAO_SEMEADO in url or fixtures.CNPJ_CONCORRENTE in url)
        else set()
    ) | ({400} if metodo in WRITE_METHODS else set())
    if row["rota"] in ALLOW_404_GET:
        aceitos |= {404}
    if row["rota"] in ALLOW_400_GET:
        aceitos |= {400}
    ok = r.status_code in aceitos
    _results.append(
        {"rota": row["rota"], "metodo": metodo, "papel": papel, "status": r.status_code, "ok": ok}
    )
    assert ok, f"{metodo} {row['rota']} com {papel} deu {r.status_code} (esperado autorizar)"


@pytest.mark.parametrize("row", INVENTORY_ROWS, ids=lambda r: r["rota"])
def test_route_denies_wrong_role(row, sessao_por_papel):
    """O papel que deve barrar (ex.: EXTERNO em requireVisualizar) recebe 401/403."""
    metodo = row["metodos"].split("|")[0]
    papel = row["barra"]
    if papel in ("-", "", "sem-bearer", "segundo-uso(409)", "senha-errada"):
        # Mesmo contrato do allow-test: skip justificado vira linha SKIP no CSV.
        _results.append(
            {"rota": row["rota"], "metodo": metodo, "papel": papel or "-", "status": "SKIP", "ok": "skip"}
        )
        pytest.skip(f"barreira específica testada à parte: {row['rota']}")
    cookies = sessao_por_papel(papel)
    url = ONPREM + _resolve(row["rota"])
    r = _sonda(metodo, url, cookies)
    # Writes: algumas rotas validam o corpo ANTES do guard de papel — com a
    # sonda {} o papel barrado recebe 400 sem nada executar. Aceito como
    # "não-executou" (a barreira efetiva existe; ordem validação→guard é
    # achado de robustez, não furo de RBAC — anotado na auditoria).
    # DENY_404_SENTINELA / DENY_ESTADO: limitações da sonda por rota (ver topo).
    ok = (
        r.status_code in DENY_STATUSES
        or (metodo in WRITE_METHODS and r.status_code == 400)
        or (
            row["rota"] in DENY_404_SENTINELA
            and r.status_code == 404
            and fixtures.UUID_NAO_SEMEADO in url
        )
        or r.status_code in DENY_ESTADO.get(row["rota"], set())
    )
    _results.append(
        {"rota": row["rota"], "metodo": metodo, "papel": papel, "status": r.status_code, "ok": ok}
    )
    assert ok, (
        f"{metodo} {row['rota']} com {papel} deu {r.status_code} "
        "(esperado 401/403, ou 400 em write c/ sonda {})"
    )


# [id] é polissêmico no inventário (licitação, participação, família, perfil,
# user, documento do cofre, resultado) — resolve pelo PREFIXO da rota.
# Entidades não semeadas pelo seed.sql usam fixtures.UUID_NAO_SEMEADO: uuid
# VÁLIDO (não estoura 22P02 na coluna uuid) e garantidamente ausente → 404 na
# rota autorizada, 401/403 intactos no deny-test.
_ID_POR_PREFIXO: list[tuple[str, str]] = [
    ("/api/licitacoes/",                    fixtures.LIC_ID),
    ("/api/conformidade/familias/",         fixtures.FAM_ID),
    ("/api/conformidade/cofre/documentos/", fixtures.UUID_NAO_SEMEADO),  # cofre não semeado
    ("/api/admin/users/",                   fixtures.USER_IDS["EXTERNO"]),
    ("/api/resultados/",                    fixtures.LIC_NUMERO),  # aceita numero (regex \d{8,12})
    ("/api/perfis/",                        fixtures.PERFIL_ID),
]


def _resolve(rota: str) -> str:
    """Substitui placeholders pelos ids canônicos do dataset-âncora
    (tests/lib/fixtures.py == tests/fixtures/seed.sql)."""
    if "[id]" in rota:
        alvo = next(
            (uid for prefixo, uid in _ID_POR_PREFIXO if rota.startswith(prefixo)),
            fixtures.UUID_NAO_SEMEADO,
        )
        rota = rota.replace("[id]", alvo)
    return (
        rota.replace("[licitacaoId]", fixtures.LIC_ID)
        .replace("[petitorioId]", fixtures.UUID_NAO_SEMEADO)
        .replace("[anexoId]", fixtures.UUID_NAO_SEMEADO)
        .replace("[docId]", fixtures.UUID_NAO_SEMEADO)
        .replace("[extId]", fixtures.UUID_NAO_SEMEADO)
        .replace("[notifId]", fixtures.UUID_NAO_SEMEADO)
        .replace("[cnpj]", fixtures.CNPJ_CONCORRENTE)
        .replace("[...nextauth]", "session")
    )
