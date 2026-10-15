"""
WP12 §6 — Consolidador GO / NO-GO.

Lê os artefatos produzidos pelos demais passos e aplica os gates:
  Bloqueadores  G1..G13  (qualquer FAIL => NO-GO)
  Degradações   D1..D6   (SKIP permitido, exige no-op comprovado)

Entradas (em tests/_artifacts/) — CONTRATOS CANÔNICOS dos produtores:
  smoke.json            (§2  -> G1)   {"pass","fail","skip","checks":{nome:{ok,detail}}}
                        produtores: tests/smoke.sh e tests/smoke/test_smoke_health.py
  route_inventory.csv   (§4  -> G2)   resultado por rota (rota,metodo,papel,status,ok)
  e2e_results.json      (§3  -> G3,G6..G8,G13,D1..D5)
                        {"ok",suites:{suite:{tests,failures,errors,skipped}},"faltando":[...]}
                        produtor: tests/run_e2e.sh (1 junit POR suíte; nunca ok=true vazio)
  migrate_check.json    (§6  -> G4)   {"ok","embedding_dim","migrations_aplicadas",
                        "extensoes","counts_match","detalhe"} — produtor: tests/migrate_check.py
  parity_summary.json   (§5  -> G5)   {"casos","identicos","equivalentes","divergentes",
                        "nao_autenticado","skipped"} — produtor: tests/parity/compare_prod_onprem.py
  egress.json           (G10,G11)     {"proibidos":{h:{observado,esperado,provado_bloqueado}},
                        "exigidos":{h:{status}},"gated":{...},"veredito"} — produtor:
                        tests/lib/egress_guard.py (+ sonda ativa tests/lib/egress_probe.sh)
  backup_check.json     (DR  -> G12)  {"ok","restored","tabelas","dump","detalhe"}
                        produtor: tests/dr_check.sh (DR dry-run no HOST)

Saída: tests/_artifacts/go-no-go.md (veredito final + tabela de gates).

STATUS: REAL — cada gate inspeciona o CONTEÚDO do(s) artefato(s) com uma regra
específica (não só "arquivo existe"). Onde o gate depende de um artefato ainda não
produzido, o status é "PENDENTE" (equivale a NO-GO até ser gerado). Em PT-BR.
"""
from __future__ import annotations

import csv
import io
import json
import os
import pathlib

# Diretório de artefatos: dentro do container `tester` é /tests/_artifacts; no host
# pode-se sobrescrever via env GNG_ARTIFACTS (mantém o default histórico do WP12).
ART = pathlib.Path(os.environ.get("GNG_ARTIFACTS", "/tests/_artifacts"))

# Inventário-fonte das rotas (versionado ao lado deste arquivo). Usado pelo G2
# como "golden de cobertura": o resultado em _artifacts/route_inventory.csv deve
# cobrir TODAS estas rotas. Resolvido relativo a este .py (não a ART).
ROUTE_INVENTORY_SRC = pathlib.Path(__file__).parent / "parity" / "route_inventory.csv"

# smoke.sh é versionado no repo (gera smoke.json em runtime). O G1 confere tanto o
# resultado (smoke.json) quanto a presença das âncoras de contrato no próprio script.
SMOKE_SH = pathlib.Path(__file__).parent / "smoke.sh"

# Nº mínimo de rotas que o inventário precisa cobrir para o G2 passar.
MIN_ROTAS = 90

# As 7 suítes e2e do contrato canônico (nomes EXATOS de tests/run_e2e.sh::SUITES).
# G3/G6..G8 exigem 5 delas individualmente; o G13 exige a tupla COMPLETA — sem ele,
# licitacoes_api/pacote_orcamento_api (e a extinta notificacoes_api) eram
# órfãs no roteador e podiam falhar (ou nunca rodar) com veredito GO (verificação
# adversarial 2026-06-11, mesma classe do bloqueante #9 da auditoria).
# (O módulo Petitórios foi removido do produto em 2026-07-04 — suíte retirada.)
# (notificacoes_api saiu em 2026-09-18: sininho, Web Push e webhooks removidos.)
# (scraper_api e o gate G9 sairam com o coletor do portal de compras, que nao
#  faz parte deste repositorio — a numeracao G10..G13 foi mantida.)
SUITES_CANONICAS = (
    "auth_rbac_api",
    "licitacoes_api",
    "busca_api",
    "acervo_rag_api",
    "cofre_api",
    "pacote_orcamento_api",
    "crons_api",
)

# G1 — famílias de checagem que TODO produtor de smoke.json precisa cobrir (os 7
# serviços de longa duração do compose; createbuckets é job one-shot validado via
# minio; elasticsearch REMOVIDO em 2026-07-02). Sem isto, derrubar web+bff fazia
# as checagens SUMIREM do artefato e fail==0 virava falso GO (verificação
# adversarial 2026-06-11). Casa com os DOIS produtores: o pytest usa nomes puros
# ("web", "bff", ...); o smoke.sh usa "<secao>:<seq>" ("web:1", "bff:2", ...) —
# daí o match por nome OU prefixo.
G1_FAMILIAS_OBRIGATORIAS = (
    "web", "bff", "db", "redis", "minio",
    "worker", "embeddings-local",
)


GATES = [
    ("G1", "8 containers + deps cruzadas + negativos", "smoke.json", True),
    ("G2", "90 rotas cobertas (status/papel)", "route_inventory.csv", True),
    ("G3", "Login+RBAC 7 papéis + jti revoga + maxAge 8h", "e2e_results.json", True),
    ("G4", "Migrations 0000..0016 + vector(1024) + counts==golden", "migrate_check.json", True),
    ("G5", "Comparações exatas IDÊNTICAS (sem DIVERGENTE)", "parity_summary.json", True),
    ("G6", "RAG dim=1024 + recall âncora + anti-IDOR", "e2e_results.json", True),
    ("G7", "Upload Cofre MinIO+DB + download íntegro", "e2e_results.json", True),
    ("G8", "Crons gravam + idempotentes + lock + catch-up", "e2e_results.json", True),
    ("G10", "Sem egress proibido (GitHub/Upstash/Voyage/OpenAI/Resend)", "egress.json", True),
    ("G11", "Egress obrigatório OK (Anthropic se IA / Microsoft Graph se e-mail)", "egress.json", True),
    ("G12", "Backup/restore validado (DR dry-run)", "backup_check.json", True),
    ("G13", "7 suítes e2e canônicas completas (ok global, sem faltando)", "e2e_results.json", True),
]

DEGRADACOES = [
    # (Canal WhatsApp removido em 2026-07-04.)
    # (D1 Web Push e D2 Webhook de saída saíram com os canais em 2026-09-18.)
    # E-mail NÃO é degradação graciosa: o Graph é o transporte ÚNICO (SMTP/Resend
    # deletados). Sem GRAPH_MAIL_SENDER o sistema sobe e NÃO envia NADA, calado.
    ("D3", "E-mail (Microsoft Graph — sem fallback; ausência = ZERO e-mail)", "GRAPH_MAIL_SENDER"),
    ("D4", "IA Anthropic (air-gap total)", "ANTHROPIC_API_KEY"),
    ("D5", "Sentry/observabilidade", "SENTRY_DSN"),
]


# ── Utilitários de leitura ────────────────────────────────────────────────────
def _exists(name: str) -> bool:
    return (ART / name).exists()


def _read_text(name: str) -> str:
    return (ART / name).read_text(errors="ignore")


def _read_json(name: str) -> dict | list | None:
    try:
        return json.loads(_read_text(name))
    except (json.JSONDecodeError, OSError):
        return None


def _rotas_da_fonte(csv_text: str) -> list[str]:
    """Extrai a coluna `rota` das linhas de dados do inventário-FONTE (ignora
    comentários `#` e cabeçalho). 1 linha de dados = 1 rota (a fonte não tem
    rota duplicada); a lista é o golden de cobertura do G2."""
    rotas: list[str] = []
    for row in csv.reader(io.StringIO(csv_text)):
        if not row:
            continue
        first = row[0].lstrip()
        if first.startswith("#") or first == "dominio" or first == "rota":
            continue
        if len(row) >= 2:
            rotas.append(row[1].strip())
    return rotas


# ── Checagens REAIS por gate (cada uma devolve (status, detalhe)) ──────────────
def _check_g1_smoke() -> tuple[str, str]:
    """G1: smoke.json deve registrar fail==0 E cobrir as famílias obrigatórias em
    "checks" — só o contador era refutável: com web+bff fora do ar a exceção de
    conexão suprimia as checagens e o artefato saía {"fail": 0} (falso GO). O
    smoke.sh versionado também deve checar o /bff/health (contrato de saúde da
    BFF) — prova que o script não é um esqueleto."""
    # Âncora estrutural: o próprio script precisa exercitar o health da BFF.
    if not SMOKE_SH.exists():
        return "FAIL", "tests/smoke.sh ausente"
    sh = SMOKE_SH.read_text(errors="ignore")
    if "/bff/health" not in sh:
        return "FAIL", "smoke.sh não referencia /bff/health (contrato de saúde da BFF)"
    if not _exists("smoke.json"):
        return "PENDENTE", "smoke.json ainda não gerado (rodar tests/smoke.sh)"
    data = _read_json("smoke.json")
    if not isinstance(data, dict):
        return "FAIL", "smoke.json inválido/não-objeto"
    fail = data.get("fail", data.get("FAIL"))
    if fail is None:
        return "FAIL", "smoke.json sem contador 'fail'"
    if int(fail) > 0:
        return "FAIL", f"smoke.json reporta {fail} falha(s)"
    # Cobertura mínima: fail==0 só vale se TODAS as famílias estão presentes em
    # "checks" (nome exato OU prefixo "<familia>:..."). Checagem sumida = NO-GO.
    checks = data.get("checks")
    if not isinstance(checks, dict) or not checks:
        return "FAIL", "smoke.json sem bloco 'checks' (artefato vácuo: fail=0 não prova nada)"
    faltam = [
        fam for fam in G1_FAMILIAS_OBRIGATORIAS
        if not any(n == fam or n.startswith(f"{fam}:") for n in checks)
    ]
    if faltam:
        return "FAIL", (
            "smoke.json sem checagem de: " + ", ".join(faltam)
            + " (serviço fora do ar não pode sumir do artefato)"
        )
    return "PASS", (
        f"smoke OK (fail=0; {len(checks)} checks cobrindo as "
        f"{len(G1_FAMILIAS_OBRIGATORIAS)} famílias); smoke.sh exercita /bff/health"
    )


def _check_g2_routes() -> tuple[str, str]:
    """G2: cobertura julgada no RESULTADO contra o inventário-FONTE — não só na
    fonte (verificação adversarial 2026-06-11: um resultado de 1 linha ok=True
    passava com "103 rotas"). Regras:
      - fonte precisa ter >= MIN_ROTAS rotas (golden de cobertura);
      - resultado sem nenhuma linha ok==False/false;
      - TODA rota da fonte precisa de >= 2 registros no resultado (autoriza +
        barra; SKIP justificado CONTA — test_route_inventory.py grava status=SKIP
        antes de pular). Linha sumida = teste que estourou antes de registrar
        (ou subset rodado) => FAIL, nunca PASS vácuo."""
    if not ROUTE_INVENTORY_SRC.exists():
        return "FAIL", "route_inventory.csv (fonte) ausente"
    fonte = _rotas_da_fonte(ROUTE_INVENTORY_SRC.read_text(errors="ignore"))
    n = len(fonte)
    if n < MIN_ROTAS:
        return "FAIL", f"inventário cobre {n} rotas (< {MIN_ROTAS})"
    if not _exists("route_inventory.csv"):
        return "PENDENTE", f"inventário-fonte OK ({n} rotas); falta resultado dos testes"
    # Resultado: header rota,metodo,papel,status,ok ; barrar ok falso E buraco de cobertura.
    res = _read_text("route_inventory.csv")
    falhas = 0
    skips = 0
    total = 0
    registros_por_rota: dict[str, int] = {}
    for row in csv.DictReader(io.StringIO(res)):
        total += 1
        rota = str(row.get("rota", "")).strip()
        registros_por_rota[rota] = registros_por_rota.get(rota, 0) + 1
        if str(row.get("ok", "")).strip().lower() in ("false", "0", "no"):
            falhas += 1
        elif str(row.get("status", "")).strip().upper() == "SKIP":
            skips += 1
    if total == 0:
        return "PENDENTE", f"inventário-fonte OK ({n} rotas); resultado vazio"
    if falhas > 0:
        return "FAIL", f"{falhas}/{total} chamadas de rota com status divergente"
    sem_cobertura = [r for r in fonte if registros_por_rota.get(r, 0) < 2]
    if sem_cobertura:
        exemplos = ", ".join(sem_cobertura[:3])
        return "FAIL", (
            f"{len(sem_cobertura)}/{n} rotas da fonte sem os 2 registros"
            f" (autoriza+barra) no resultado — cobertura vácua (ex.: {exemplos})"
        )
    return "PASS", (
        f"{n} rotas no inventário; {total} checagens ({skips} SKIP justificados),"
        f" 0 divergências, cobertura 2/2 em todas as rotas"
    )


def _check_e2e(*, exige_suite: str | tuple[str, ...] | None = None) -> tuple[str, str]:
    """Base dos gates que dependem de e2e_results.json (contrato canônico:
    {"ok": bool, "suites": {suite: {tests,failures,errors,skipped}}, "faltando": [..]}).

    Com `exige_suite` (str OU tupla), o gate é julgado SUITE A SUITE — nunca pelo
    "ok" global vazio (defeito da auditoria #9: GO vácuo com suites={}):
      - suíte em "faltando" ou ausente de "suites"  -> PENDENTE (nomeia a suíte);
      - failures+errors > 0                          -> FAIL;
      - tests == 0                                   -> PENDENTE (junit vazio = vácuo).
    """
    if not _exists("e2e_results.json"):
        return "PENDENTE", "e2e_results.json ainda não gerado (rodar run_e2e.sh)"
    data = _read_json("e2e_results.json")
    if not isinstance(data, dict):
        return "FAIL", "e2e_results.json inválido/não-objeto"
    suites = data.get("suites", {})
    faltando = data.get("faltando", [])

    if exige_suite is None:
        # Sem suíte específica: vale o agregado, mas vazio NUNCA é PASS.
        if not suites:
            return "PENDENTE", "e2e_results.json sem nenhuma suíte (consolidação vácua)"
        if faltando:
            return "PENDENTE", "suítes faltando: " + ", ".join(map(str, faltando))
        if data.get("ok") is not True:
            return "FAIL", "e2e_results.json: ok != true (há suíte com falha)"
        return "PASS", f"e2e ok=true ({len(suites)} suíte(s))"

    exigidas = (exige_suite,) if isinstance(exige_suite, str) else tuple(exige_suite)
    detalhes: list[str] = []
    for nome in exigidas:
        if nome in faltando or nome not in suites:
            return "PENDENTE", f"suíte '{nome}' ausente em e2e_results.json (junit não gerado)"
        s = suites[nome]
        fails = int(s.get("failures", 0)) + int(s.get("errors", 0))
        if fails > 0:
            return "FAIL", f"suíte '{nome}' com {fails} falha(s)/erro(s)"
        n = int(s.get("tests", 0))
        if n == 0:
            return "PENDENTE", f"suíte '{nome}' com 0 testes coletados (vácua)"
        detalhes.append(f"{nome}: {n} teste(s) OK")
    return "PASS", "; ".join(detalhes)


def _check_g13_e2e_suites_completas() -> tuple[str, str]:
    """G13 (verificação adversarial 2026-06-11 — suítes ÓRFÃS): G3/G6..G8 só
    exigem 5 das suítes canônicas; licitacoes_api e pacote_orcamento_api
    podiam falhar (ou nunca rodar) sem
    derrubar nenhum gate => GO vácuo. Este gate fecha o buraco em duas camadas:
      1) julga SUITE A SUITE a tupla completa SUITES_CANONICAS via _check_e2e
         (presente, >0 testes, failures+errors==0);
      2) cobra o agregado do consolidador (ok=true E faltando==[]) — defesa em
         profundidade contra um e2e_results.json com suites limpas mas
         consolidação inconsistente (o contrato diz: ok=true SOMENTE com todas)."""
    st, detalhe = _check_e2e(exige_suite=SUITES_CANONICAS)
    if st != "PASS":
        return st, detalhe
    data = _read_json("e2e_results.json")
    if not isinstance(data, dict):
        return "FAIL", "e2e_results.json inválido/não-objeto"
    faltando = data.get("faltando", [])
    if faltando:
        return "PENDENTE", "consolidador acusa suítes faltando: " + ", ".join(map(str, faltando))
    if data.get("ok") is not True:
        return "FAIL", f"ok != true no consolidador apesar de {len(SUITES_CANONICAS)}/{len(SUITES_CANONICAS)} suítes limpas (e2e_results.json inconsistente)"
    total = sum(
        int((data.get("suites", {}).get(s) or {}).get("tests", 0)) for s in SUITES_CANONICAS
    )
    n = len(SUITES_CANONICAS)
    return "PASS", f"{n}/{n} suítes canônicas com junit, {total} teste(s), 0 falhas; ok=true e faltando=[]"


def _check_g4_migrate() -> tuple[str, str]:
    """G4: migrate_check.json (produtor: tests/migrate_check.py) deve confirmar
    ok=true, >=16 migrations (0000..0015), extensões vector+pgcrypto, dimensão
    1024 e counts_match != false (null = sem golden origin_counts.csv, tolerado)."""
    if not _exists("migrate_check.json"):
        return "PENDENTE", "migrate_check.json ainda não gerado (rodar tests/migrate_check.py)"
    data = _read_json("migrate_check.json")
    if not isinstance(data, dict):
        return "FAIL", "migrate_check.json inválido"
    if data.get("ok") is not True:
        return "FAIL", f"migrate_check: ok != true ({data.get('detalhe', 'sem detalhe')})"
    # Dimensão do embedding deve ser 1024 (Decisão 1 / migration 0015).
    dim = data.get("embedding_dim")
    if dim is None or int(dim) != 1024:
        return "FAIL", f"dimensão do vetor = {dim} (esperado 1024)"
    mig = data.get("migrations_aplicadas")
    if mig is not None and int(mig) < 17:
        return "FAIL", f"{mig} migrations aplicadas (< 17 = 0000..0016)"
    ext = data.get("extensoes") or []
    if "vector" not in ext or "pgcrypto" not in ext:
        return "FAIL", f"extensões ausentes (tem {ext}; exige vector+pgcrypto)"
    if data.get("counts_match") is False:
        return "FAIL", "counts != golden origin_counts.csv após migração"
    golden = "counts==golden" if data.get("counts_match") else "sem golden (counts_match=null)"
    return "PASS", f"{mig} migrations; dim=1024; vector+pgcrypto; {golden}"


def _check_g5_parity() -> tuple[str, str]:
    """G5: parity_summary.json (contrato canônico). PENDENTE se a comparação foi
    pulada (skipped) ou vácua (casos==0); FAIL se há DIVERGENTE em comparação
    exata OU se a "paridade" foi inteira 401×401 (nao_autenticado==casos — o
    falso-IDÊNTICO denunciado pela auditoria); PASS caso contrário."""
    if not _exists("parity_summary.json"):
        return "PENDENTE", "parity_summary.json ainda não gerado (compare_prod_onprem.py)"
    data = _read_json("parity_summary.json")
    if not isinstance(data, dict):
        return "FAIL", "parity_summary.json inválido"
    casos = int(data.get("casos", 0))
    if data.get("skipped") is True or casos == 0:
        return "PENDENTE", "comparação pulada (sem PROD_REF/goldens) ou 0 casos"
    div = int(data.get("divergentes", 0))
    nao_auth = int(data.get("nao_autenticado", 0))
    if div > 0:
        return "FAIL", f"{div}/{casos} comparação(ões) DIVERGENTE(s)"
    if nao_auth == casos:
        return "FAIL", f"paridade vácua: {casos} caso(s) todos 401/403 nos dois lados (sessão não logou)"
    extra = f"; {nao_auth} sem autenticação" if nao_auth else ""
    return "PASS", (
        f"{data.get('identicos', 0)} idênticos + {data.get('equivalentes', 0)} equivalentes"
        f" / {casos} casos, 0 divergentes{extra}"
    )


def _check_g10_egress_proibido() -> tuple[str, str]:
    """G10: formato REAL do egress_guard ({"proibidos": {h: {observado, esperado,
    provado_bloqueado}}, ..., "veredito"}). FAIL se qualquer proibido foi
    observado; PASS se o veredito é GO OU todos os proibidos estão PROVADOS
    bloqueados (sonda ativa egress_probe); senão PENDENTE (inconclusivo)."""
    if not _exists("egress.json"):
        return "PENDENTE", "egress.json ainda não gerado (egress_guard)"
    data = _read_json("egress.json")
    if not isinstance(data, dict) or not isinstance(data.get("proibidos"), dict):
        return "FAIL", "egress.json inválido (sem bloco 'proibidos')"
    proibidos: dict = data["proibidos"]
    observados = [h for h, v in proibidos.items() if isinstance(v, dict) and v.get("observado")]
    if observados:
        return "FAIL", "egress proibido observado: " + ", ".join(observados)
    veredito = str(data.get("veredito", ""))
    todos_provados = bool(proibidos) and all(
        isinstance(v, dict) and v.get("provado_bloqueado") is True for v in proibidos.values()
    )
    if veredito.startswith("GO") or todos_provados:
        prova = "todos provados bloqueados (sonda ativa)" if todos_provados else f"veredito do guard: {veredito}"
        return "PASS", f"nenhum egress proibido; {prova}"
    return "PENDENTE", f"INCONCLUSIVO — sem captura/sonda que prove o bloqueio ({veredito or 'sem veredito'})"


def _check_g11_egress_exigido() -> tuple[str, str]:
    """G11: bloco "exigidos" do egress_guard ({h: {"status": observado|alcancavel|
    nao-verificado|FALTANDO}}). FAIL se algum exigido FALTANDO; PASS se todos
    observados/alcançáveis; senão PENDENTE (não verificado)."""
    if not _exists("egress.json"):
        return "PENDENTE", "egress.json ainda não gerado (egress_guard)"
    data = _read_json("egress.json")
    if not isinstance(data, dict) or not isinstance(data.get("exigidos"), dict):
        return "FAIL", "egress.json inválido (sem bloco 'exigidos')"
    exigidos: dict = data["exigidos"]
    status = {h: str((v or {}).get("status", "")) for h, v in exigidos.items()}
    faltando = [h for h, s in status.items() if s == "FALTANDO"]
    if faltando:
        return "FAIL", "egress exigido ausente: " + ", ".join(faltando)
    if exigidos and all(s in ("observado", "alcancavel") for s in status.values()):
        return "PASS", "egress exigido OK: " + ", ".join(f"{h}={s}" for h, s in status.items())
    nao_verif = [h for h, s in status.items() if s not in ("observado", "alcancavel")]
    return "PENDENTE", "egress exigido não verificado: " + (", ".join(nao_verif) or "lista vazia")


def _check_g12_backup() -> tuple[str, str]:
    """G12: backup_check.json (produtor: tests/dr_check.sh). Contrato: {"ok",
    "restored", "tabelas", "dump", "detalhe"}. PASS exige ok=true E restored=true."""
    if not _exists("backup_check.json"):
        return "PENDENTE", "backup_check.json ainda não gerado (rodar tests/dr_check.sh no host)"
    data = _read_json("backup_check.json")
    if not isinstance(data, dict):
        return "FAIL", "backup_check.json inválido"
    if data.get("ok") is False or data.get("restored") is False:
        return "FAIL", f"restore não validado: {data.get('detalhe', 'ok/restored false')}"
    if data.get("ok") is True and data.get("restored") is True:
        return "PASS", f"DR dry-run OK ({data.get('tabelas', '?')} tabelas restauradas de {data.get('dump', '?')})"
    return "PENDENTE", "backup_check.json sem veredito completo (exige ok=true e restored=true)"


# Roteador: associa cada gate à sua checagem REAL de conteúdo.
def _status_for(gate_id: str) -> tuple[str, str]:
    if gate_id == "G1":
        return _check_g1_smoke()
    if gate_id == "G2":
        return _check_g2_routes()
    if gate_id == "G3":
        return _check_e2e(exige_suite=("auth_rbac_api",))  # login+RBAC 7 papéis
    if gate_id == "G4":
        return _check_g4_migrate()
    if gate_id == "G5":
        return _check_g5_parity()
    if gate_id == "G6":
        return _check_e2e(exige_suite=("acervo_rag_api", "busca_api"))  # RAG/anti-IDOR
    if gate_id == "G7":
        return _check_e2e(exige_suite=("cofre_api",))  # cofre upload/download
    if gate_id == "G8":
        return _check_e2e(exige_suite=("crons_api",))  # crons idempotentes
    if gate_id == "G10":
        return _check_g10_egress_proibido()
    if gate_id == "G11":
        return _check_g11_egress_exigido()
    if gate_id == "G12":
        return _check_g12_backup()
    if gate_id == "G13":
        return _check_g13_e2e_suites_completas()  # 7/7 suítes (fecha as órfãs)
    return "PENDENTE", "gate sem checagem registrada"


def run() -> str:
    ART.mkdir(parents=True, exist_ok=True)
    lines = ["# WP12 — Veredito GO / NO-GO\n"]
    lines.append("## Gates bloqueadores\n")
    lines.append("| Gate | Descrição | Artefato | Status | Detalhe |")
    lines.append("|---|---|---|---|---|")
    blocker_fail = False
    for gid, desc, art, _ in GATES:
        st, detalhe = _status_for(gid)
        if st != "PASS":
            blocker_fail = True
        lines.append(f"| {gid} | {desc} | `{art}` | **{st}** | {detalhe} |")

    lines.append("\n## Degradações conscientes (SKIP exige no-op comprovado)\n")
    lines.append("| Gate | Subsistema | Env | Nota |")
    lines.append("|---|---|---|---|")
    for did, desc, env in DEGRADACOES:
        lines.append(f"| {did} | {desc} | `{env}` | SKIP/PASS conforme env + no-op comprovado |")

    veredito = "NO-GO" if blocker_fail else "GO"
    lines.insert(1, f"\n> **VEREDITO: {veredito}**\n")
    out = "\n".join(lines) + "\n"
    (ART / "go-no-go.md").write_text(out)
    return veredito


if __name__ == "__main__":
    v = run()
    print(v)
    raise SystemExit(0 if v == "GO" else 1)
