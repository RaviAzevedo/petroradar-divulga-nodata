#!/usr/bin/env bash
# =============================================================================
# run_e2e.sh — WP12 §3: orquestra os e2e por feature (pytest+httpx [+playwright])
# =============================================================================
# Roda DENTRO do container `tester` (perfil "tests") OU no host (deps instaladas).
# Pré: make up + migrate + test-seed já executados.
#
# CONTRATO (auditoria 2026-06-10, bloqueante #9 — fim do "ok=true vazio"):
#   - pytest roda POR SUÍTE, com 1 junit por suíte (e2e_<suite>.xml);
#   - e2e_results.json consolida APENAS o que os junits provam:
#       {"ok": bool,
#        "suites": {"<suite>": {"tests","failures","errors","skipped"}},
#        "faltando": [suites sem junit OU com 0 testes coletados]}
#   - ok=true SOMENTE se TODAS as suítes têm junit presente, >0 testes e
#     failures+errors==0 em todas. Suíte ausente/vácua => faltando + ok=false.
#   - Falha de pytest NUNCA derruba o script antes da consolidação (rc capturado).
# =============================================================================
set -uo pipefail   # SEM -e de propósito: cada suíte falha isolada; consolidamos no fim.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"   # no tester: /  (tests montado em /tests)
ART="${ART:-${SCRIPT_DIR}/_artifacts}"
mkdir -p "${ART}"

# `from tests.lib import fixtures` precisa do PAI de tests/ no PYTHONPATH
# (no tester o Dockerfile já exporta PYTHONPATH=/; no host garantimos aqui).
export PYTHONPATH="${REPO_DIR}${PYTHONPATH:+:${PYTHONPATH}}"
cd "${REPO_DIR}"

PY="${PY:-python3}"
command -v "${PY}" >/dev/null 2>&1 || PY=python

# As 7 suítes do contrato canônico (nomes EXATOS — go_no_go.py G3/G6..G8 exige
# 5 individualmente e o G13 exige a tupla completa == SUITES_CANONICAS).
SUITES=(
  auth_rbac_api
  licitacoes_api
  busca_api
  acervo_rag_api
  cofre_api
  pacote_orcamento_api
  crons_api
)

echo ">> [e2e] APIs (pytest+httpx) — ${#SUITES[@]} suítes, 1 junit por suíte"
for suite in "${SUITES[@]}"; do
  arq="tests/e2e/${suite}.py"
  junit="${ART}/e2e_${suite}.xml"
  rm -f "${junit}"
  if [[ ! -f "${arq}" ]]; then
    echo ">> [e2e] ${suite}: ARQUIVO AUSENTE (${arq}) — entra em 'faltando'"
    continue
  fi
  echo ">> [e2e] ${suite}: pytest -q ${arq}"
  pytest -q "${arq}" --junitxml="${junit}"
  rc=$?
  # rc: 0=ok, 1=falhas (junit registra), 5=nada coletado (junit tests=0).
  # Qualquer rc segue adiante — o veredito é do consolidador, não do shell.
  [[ ${rc} -ne 0 ]] && echo ">> [e2e] ${suite}: pytest rc=${rc} (ver ${junit})"
done

echo ">> [e2e] UI (playwright)"
# Specs .ts ainda não existem (WP12 §3.1/§3.2/§3.5 planeja-os) — SKIP limpo até lá.
shopt -s nullglob
SPECS=("${SCRIPT_DIR}"/e2e/*.spec.ts)
shopt -u nullglob
if [[ ${#SPECS[@]} -eq 0 ]]; then
  echo ">> [e2e] Playwright: nenhum *.spec.ts em tests/e2e — SKIP (sem specs de UI)"
elif command -v npx >/dev/null 2>&1; then
  npx playwright test --config=playwright.config.ts --reporter=json > "${ART}/e2e_ui.json" || \
    echo ">> [e2e] Playwright com falhas (ver e2e_ui.json)"
else
  echo ">> [e2e] Playwright: npx ausente — SKIP UI (rodar no host com node)"
fi

# ── Consolidação: junit POR suíte -> e2e_results.json (contrato canônico) ────
echo ">> [e2e] consolidando e2e_results.json"
E2E_ART="${ART}" E2E_SUITES="${SUITES[*]}" "${PY}" - <<'PY'
import json, os, pathlib, xml.etree.ElementTree as ET

art = pathlib.Path(os.environ["E2E_ART"])
suites_esperadas = os.environ["E2E_SUITES"].split()

def parse_junit(path: pathlib.Path) -> dict:
    """Soma tests/failures/errors/skipped (raiz <testsuites> OU <testsuite>)."""
    root = ET.parse(path).getroot()
    nodes = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    tot = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    for n in nodes:
        for k in tot:
            tot[k] += int(n.attrib.get(k, 0) or 0)
    return tot

res = {"ok": True, "suites": {}, "faltando": []}
for nome in suites_esperadas:
    junit = art / f"e2e_{nome}.xml"
    if not junit.exists():
        res["faltando"].append(nome)        # junit ausente => suíte não rodou
        res["ok"] = False
        continue
    try:
        tot = parse_junit(junit)
    except ET.ParseError as exc:
        res["faltando"].append(nome)        # junit corrompido conta como ausente
        res["ok"] = False
        print(f">> [e2e] {nome}: junit ilegível ({exc})")
        continue
    res["suites"][nome] = tot
    if tot["tests"] == 0:
        res["faltando"].append(nome)        # 0 testes coletados = suíte vácua
        res["ok"] = False
    if tot["failures"] + tot["errors"] > 0:
        res["ok"] = False

(art / "e2e_results.json").write_text(json.dumps(res, indent=2, ensure_ascii=False))
print(json.dumps(res, ensure_ascii=False))
PY

# Exit do orquestrador espelha o ok consolidado (sem mascarar como antes).
"${PY}" - <<PY
import json, sys
ok = json.load(open("${ART}/e2e_results.json"))["ok"]
sys.exit(0 if ok else 1)
PY
