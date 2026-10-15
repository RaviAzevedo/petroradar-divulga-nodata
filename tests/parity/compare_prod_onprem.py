"""
WP12 §5 — COMPARAÇÃO on-prem × prod (mesmos inputs -> mesmas saídas).

Para um conjunto fixo de rotas e inputs, captura a saída do PROD-REF (clone de
produção; URL em PROD_REF_BASE_URL) e do ONPREM-SUT (http://web:3000), normaliza
campos voláteis (tests/lib/normalize.py) e emite o veredito por rota:
  IDÊNTICO / EQUIVALENTE (volátil normalizado) / DIVERGENTE (campo X).

Regras (WP12 §5.1):
  - GET idempotentes              -> diff 1:1 normalizado.
  - POST heurísticos determinísticos (go-no-go, winrate, perfis/preview,
    familias/match, gap {usarIA:false}) -> diff 1:1 EXATO (não normaliza valores).
  - POST com IA (analise/minuta/sugestao-preco/triagem) -> compara só SHAPE +
    efeito persistido (custo>0/tokens>0), NUNCA o texto.
  - Embeddings: nunca compara vetor; compara dim=1024 (on-prem) e recall do top-K.

Se PROD_REF_BASE_URL estiver vazio, usa goldens locais em tests/_golden/;
se TAMBÉM não houver golden nenhum, a comparação é PULADA com aviso (skipped=true,
exit 0) — jamais finge paridade sem referência.

MODO SELF-GOLDEN (B5, 2026-07-02) — reativa o G5 parcialmente SEM PROD-REF:
  ``SELF_GOLDEN=1`` (alvo ``make test-parity-self``):
    1ª execução (tests/_golden/ vazio, ou ``SELF_GOLDEN_REFRESH=1``): captura os
    goldens do PRÓPRIO ambiente on-prem (ONPREM_BASE_URL) — a resposta de HOJE
    vira a baseline LOCAL em tests/_golden/ (gitignored: pode conter dado real).
    Execuções seguintes: comparam o ambiente atual contra essa baseline
    (replay offline) e detectam DRIFT DE CONTRATO (shape/valor de rotas estáveis).
  O catálogo self-golden usa SÓ rotas GET determinísticas sobre as âncoras do
  seed e2e (tests/lib/fixtures.py) — nada que a coleta/beat mute com o tempo.
  O modo PROD_REF continua intacto (PROD_REF_BASE_URL tem semântica original).

Saídas:
  tests/_artifacts/parity_report.html   (tabela por rota, + diffs em _artifacts/diff/)
  tests/_artifacts/parity_summary.json  (CONTRATO CANÔNICO lido pelo gate G5):
    {"casos": int, "identicos": int, "equivalentes": int, "divergentes": int,
     "nao_autenticado": int, "skipped": bool}

REGRA ANTI-VACUIDADE (auditoria 2026-06-10): antes de comparar igualdade, valida-se
o STATUS — se AMBOS os lados respondem 401/403 num caso autenticado, o veredito é
NAO_AUTENTICADO (a sessão não logou), NUNCA "IDÊNTICO 401×401". O G5 reprova se
nao_autenticado==casos (paridade vácua).

Critério de aceite (WP12 G5): nenhuma rota de comparação EXATA em DIVERGENTE.

A captura/replay + login NextAuth real vivem em tests/lib/golden.py.
"""
from __future__ import annotations

import json
import os
import pathlib

import httpx

from tests.lib import fixtures, golden, normalize  # type: ignore

ONPREM = os.environ.get("ONPREM_BASE_URL", "http://web:3000")
PROD_REF = os.environ.get("PROD_REF_BASE_URL", "")  # vazio => usa _golden/
SELF_GOLDEN = os.environ.get("SELF_GOLDEN", "") in ("1", "true", "yes")
SELF_GOLDEN_REFRESH = os.environ.get("SELF_GOLDEN_REFRESH", "") in ("1", "true", "yes")
# _artifacts relativo a tests/ (funciona no tester E no host), com override por env.
ART = pathlib.Path(os.environ.get("GNG_ARTIFACTS", str(pathlib.Path(__file__).resolve().parents[1] / "_artifacts")))
(ART / "diff").mkdir(parents=True, exist_ok=True)

EXACT = "exact"      # heurística determinística — sem normalização de valores
NORM = "normalized"  # leitura — normaliza voláteis
SHAPE = "shape"      # IA — só shape + efeito persistido
RECALL = "recall"    # RAG — recall do top-K + dim 1024

# (rota, método, body, papel, modo_de_comparação)
#
# Catálogo SELF-GOLDEN: 13 rotas GET estáveis sobre as âncoras determinísticas
# do seed e2e (fixtures.uuid_fixo). Critério de seleção (B5):
#   - NADA que a coleta/beat mute (listas de licitacoes, agregados, saúde do
#     pipeline) — o golden precisa valer amanhã;
#   - NADA com side effect (previsao-winrate persiste; analise chama IA);
#   - voláteis restantes (criadoEm/atualizadoEm/ids) normalizados em modo NORM;
#   - EXACT só onde a heurística é determinística sobre dados estáveis
#     (match familia↔edital);
#   - /api/resultados/<numero-fictício> versiona o CONTRATO do estado vazio
#     (número 70049901xx é fictício — nenhuma coleta o preenche).
CASES = [
    (f"/api/licitacoes/{fixtures.LIC_ID}", "GET", None, "VISUALIZADOR", NORM),
    (f"/api/licitacoes/{fixtures.LIC_ID_2}", "GET", None, "VISUALIZADOR", NORM),
    (f"/api/licitacoes/{fixtures.LIC_ID}/circulares", "GET", None, "VISUALIZADOR", NORM),
    (f"/api/licitacoes/{fixtures.LIC_ID}/gap-habilitacao", "GET", None, "VISUALIZADOR", NORM),
    (f"/api/conformidade/familias/{fixtures.FAM_ID}", "GET", None, "VISUALIZADOR", NORM),
    (f"/api/conformidade/familias/{fixtures.FAM_ID_2}", "GET", None, "VISUALIZADOR", NORM),
    (f"/api/conformidade/familias/match/{fixtures.LIC_ID}", "GET", None, "VISUALIZADOR", EXACT),
    (f"/api/resultados/{fixtures.LIC_NUMERO_2}", "GET", None, "VISUALIZADOR", NORM),
]


def _summary_skipped() -> dict:
    """Resumo canônico de comparação PULADA (sem referência) — G5 fica PENDENTE."""
    return {
        "casos": 0, "identicos": 0, "equivalentes": 0,
        "divergentes": 0, "nao_autenticado": 0, "skipped": True,
    }


def _write_summary(summary: dict) -> None:
    (ART / "parity_summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))


def _ref_base() -> str | None:
    """Resolve a BASE DE REFERÊNCIA efetiva desta execução (ou None p/ SKIP).

    - PROD_REF_BASE_URL setado  => modo original (captura do PROD-REF).
    - SELF_GOLDEN=1             => self-golden: sem goldens (ou com REFRESH=1)
      captura do PRÓPRIO on-prem (baseline); com goldens, replay offline ("").
    - nada                      => replay se houver goldens; senão SKIP (None).
    """
    goldens = list(golden.GOLDEN_DIR.glob("*.json"))
    if PROD_REF:
        return PROD_REF
    if SELF_GOLDEN:
        if SELF_GOLDEN_REFRESH or not goldens:
            print(f"SELF-GOLDEN: capturando baseline do próprio ambiente ({ONPREM}) em tests/_golden/ …")
            return ONPREM
        print(f"SELF-GOLDEN: comparando {ONPREM} contra {len(goldens)} golden(s) versionados (replay offline).")
        return ""
    if goldens:
        return ""
    return None


def run() -> dict:
    # Sem PROD_REF, sem SELF_GOLDEN e sem nenhum golden versionado não há o que
    # comparar: SKIP honesto (exit 0 com aviso) em vez de casos "IDÊNTICOS"
    # contra goldens vazios — o gate G5 trata skipped/casos==0 como PENDENTE.
    ref_base = _ref_base()
    if ref_base is None:
        summary = _summary_skipped()
        _write_summary(summary)
        print(
            "AVISO: sem PROD_REF_BASE_URL, sem SELF_GOLDEN=1 e sem goldens em "
            "tests/_golden/ — comparação PULADA (skipped=true)."
        )
        return summary

    report: list[dict] = []
    for rota, metodo, body, papel, modo in CASES:
        out_onprem = _call(ONPREM, rota, metodo, body, papel)
        out_prod = golden.fetch_or_replay(ref_base, rota, metodo, body, papel)
        # Gate anti-vacuidade: caso AUTENTICADO em que os DOIS lados devolvem
        # 401/403 não é paridade — é sessão que não logou. Classifica à parte.
        st_prod, st_onprem = out_prod.get("status"), out_onprem.get("status")
        if st_onprem in (401, 403) and st_prod in (401, 403, None):
            verdict, detail = "NAO_AUTENTICADO", (
                f"status prod={st_prod} × onprem={st_onprem} em caso autenticado "
                f"(papel {papel}) — sessão não estabelecida; comparação inválida"
            )
        else:
            verdict, detail = _compare(modo, out_prod, out_onprem)
        (ART / "diff" / f"{_slug(rota)}__{metodo}.json").write_text(
            json.dumps({"prod": out_prod, "onprem": out_onprem, "modo": modo}, indent=2, ensure_ascii=False)
        )
        report.append({"rota": rota, "metodo": metodo, "modo": modo, "verdict": verdict, "detail": detail})
    _write_html(report)

    contagem = {v: sum(1 for r in report if r["verdict"] == v)
                for v in ("IDENTICO", "EQUIVALENTE", "DIVERGENTE", "NAO_AUTENTICADO")}
    summary = {
        "casos": len(report),
        "identicos": contagem["IDENTICO"],
        "equivalentes": contagem["EQUIVALENTE"],
        "divergentes": contagem["DIVERGENTE"],
        "nao_autenticado": contagem["NAO_AUTENTICADO"],
        "skipped": False,
    }
    _write_summary(summary)
    return summary


def _compare(modo: str, prod: dict, onprem: dict) -> tuple[str, str]:
    if modo == EXACT:
        a, b = normalize.shape_only(prod), normalize.shape_only(onprem)  # só zera nada de valor
        if a == b:
            return "IDENTICO", ""
        return "DIVERGENTE", normalize.first_diff(a, b)
    if modo == NORM:
        a, b = normalize.normalize(prod), normalize.normalize(onprem)
        if a == b:
            return "EQUIVALENTE", "voláteis normalizados"
        return "DIVERGENTE", normalize.first_diff(a, b)
    if modo == SHAPE:
        if normalize.keys_match(prod, onprem) and normalize.effect_persisted(onprem):
            return "EQUIVALENTE", "shape igual; custo/tokens persistidos; texto IA ignorado"
        return "DIVERGENTE", "shape ou efeito de IA não bateu"
    if modo == RECALL:
        if normalize.dim_is(onprem, 1024) and normalize.recall_superset(prod, onprem):
            return "EQUIVALENTE", "dim=1024 (BGE-m3) + recall ⊇ prod (provider divergente por design)"
        return "DIVERGENTE", "dim != 1024 ou recall perdeu citação-âncora"
    return "DIVERGENTE", f"modo desconhecido: {modo}"


def _call(base: str, rota: str, metodo: str, body, papel: str) -> dict:
    cookies = golden.session_cookie(base, papel)
    r = httpx.request(metodo, base + rota, json=body, cookies=cookies, timeout=60)
    try:
        return {"status": r.status_code, "json": r.json()}
    except ValueError:
        return {"status": r.status_code, "bytes": len(r.content), "ctype": r.headers.get("content-type")}


def _slug(rota: str) -> str:
    return rota.strip("/").replace("/", "_")


def _write_html(report: list[dict]) -> None:
    rows = "\n".join(
        f"<tr class='{r['verdict'].lower()}'><td>{r['rota']}</td><td>{r['metodo']}</td>"
        f"<td>{r['modo']}</td><td>{r['verdict']}</td><td>{r['detail']}</td></tr>"
        for r in report
    )
    html = (
        "<html><head><meta charset='utf-8'><style>"
        ".identico{background:#dfd}.equivalente{background:#eef}.divergente{background:#fdd}"
        ".nao_autenticado{background:#ffe8cc}"
        "table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px}</style></head>"
        "<body><h1>WP12 — Paridade on-prem × prod</h1>"
        "<table><tr><th>Rota</th><th>Método</th><th>Modo</th><th>Veredito</th><th>Detalhe</th></tr>"
        f"{rows}</table></body></html>"
    )
    (ART / "parity_report.html").write_text(html)


if __name__ == "__main__":
    summary = run()
    print(json.dumps(summary, ensure_ascii=False))
    # SKIP consciente (sem referência) sai 0 — o gate G5 fica PENDENTE, não FAIL.
    # NO-GO (exit 1) com DIVERGENTE em comparação exata/shape/recall (WP12 G5) OU
    # com paridade VÁCUA (todos os casos 401/403 — sessão não logou; mesma regra
    # anti-vacuidade do _check_g5_parity do go_no_go.py).
    vacua = summary["casos"] > 0 and summary["nao_autenticado"] == summary["casos"]
    raise SystemExit(1 if (summary["divergentes"] or vacua) else 0)
