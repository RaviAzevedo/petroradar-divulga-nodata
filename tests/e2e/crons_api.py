"""
tests/e2e/crons_api.py — Suíte E2E dos CRONS do app Next (gate G8 do go_no_go).

Valida, contra a stack VIVA (web:3000 via ONPREM_BASE_URL), o contrato das 12
rotas GET /api/cron/<nome> que o worker beat dispara (worker/beat_schedule.py →
tasks.cron_trigger, Bearer CRON_SECRET):

    prazos · vencimentos · sync-monitor · digest-licitacoes · saude-contratos ·
    cnpj-watch · triagem-semantica · convocacao-watch · acervo-index ·
    digest-executivo · relatorio-mensal
    (circulares-watch e oportunidades-novas saíram na limpeza de 2026-09-18)

Contratos provados (espelham verifyCronAuth de app/src/lib/security/secrets.ts
e os handlers em app/src/app/api/cron/*/route.ts):
  - SEM credencial            → 401 {"error": ...} (nenhum efeito colateral);
  - Bearer ERRADO             → 401;
  - x-vercel-cron forjado     → 401 quando CRON_SECRET está configurado (prod);
  - COM cron_headers()        → 200 {"ok": true, ...} com campo de resultado
    (stats/alerta/situacao/...) OU "skipped" — skipped:true É SUCESSO: é o
    contrato do gate gracioso (cron desabilitado por config / IA indisponível);
  - idempotência: 2 execuções seguidas do cron mais inócuo (convocacao-watch,
    dedup por convocacao_notificada_em) mantêm o MESMO contrato;
  - efeito colateral (psycopg): invariante do cron prazos sobre licitacoes.fase.

REGRA DE OURO (custo): triagem-semantica chama a API
Anthropic quando ANTHROPIC_API_KEY está presente e as flags de config habilitam;
acervo-index gera embeddings pagos quando o provider é voyage/openai com chave.
Nesses cenários o teste autorizado é PULADO (pytest.skip) — replicamos os gates
de app/src/lib/config.ts (flag()/embeddingCredencialDisponivel()) a partir do
MESMO env (.env.onprem, carregado no tester). Com provider local (TEI/BGE-m3,
EMBEDDING_PROVIDER=local ou EMBEDDING_BASE_URL) a execução é grátis e roda.

LOCK/CATCH-UP (nome do G8): o lock distribuído existe SÓ no worker
(tasks.cron_trigger → Redis SET NX EX 900, chave lock:worker:cron:<nome>); a
rota HTTP não implementa lock próprio nem catch-up de janelas perdidas →
documentado como xfail(strict=False), nunca FAIL do gate.

Particularidade on-prem: cnpj-watch depende de egress a brasilapi.com.br (host
fora das listas PROIBIDOS/EXIGIDOS do egress_guard) — em ambiente air-gapped a
rota responde 502 {"ok": false, "error": ...}; aceitamos 200 OU 502 como
contrato REAL (o 502 é o caminho codificado para falha de rede da BrasilAPI).

Execução (tester, perfil "tests"): pytest -q tests/e2e/crons_api.py
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

# ── Bootstrap de import (coleta isolada no host; no tester PYTHONPATH=/) ──────
_RAIZ = Path(__file__).resolve().parents[2]
if str(_RAIZ) not in sys.path:
    sys.path.insert(0, str(_RAIZ))

from tests.lib import fixtures
from tests.lib.auth_helpers import DEFAULT_WEB_BASE, cron_headers

# ── Timeouts (rotas têm maxDuration ≤ 300; nunca exceder isso) ────────────────
# 240s no pesado: o cron prazos varre o dataset REAL (centenas de licitações
# + dedup de notificações) e em dev emulado (Apple Silicon) passa de 90s — era
# falso-negativo por ReadTimeout, não quebra de contrato. No x86 nativo é rápido.
TIMEOUT_LEVE = 30.0    # crons de poucas queries (watch/monitor)
TIMEOUT_PESADO = 240.0  # prazos/vencimentos/saude/digest/relatorio/acervo/cnpj


# ─────────────────────────────────────────────────────────────────────────────
# Réplicas dos gates de custo de app/src/lib/config.ts (mesmo env do tester)
# ─────────────────────────────────────────────────────────────────────────────
def _flag(nome: str, default: bool = True) -> bool:
    """Réplica EXATA de config.ts::flag(): ausente/vazio → default; liga só com
    "true"/"1" (qualquer outro valor desliga)."""
    v = os.environ.get(nome)
    if v is None or v == "":
        return default
    return v in ("true", "1")


def _triagem_chamaria_anthropic() -> bool:
    """triagem-semantica só chama Claude se a chave existe E o cron está
    habilitado (gates da própria rota, na mesma ordem)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY")) and _flag("CRON_TRIAGEM_ENABLED")


def _embeddings_pagos() -> bool:
    """Réplica de embeddingCredencialDisponivel() (config.ts) sob a ótica de
    CUSTO: provider local/TEI (EMBEDDING_PROVIDER=local ou EMBEDDING_BASE_URL)
    é grátis; voyage/openai COM chave é pago (e, on-prem, egress PROIBIDO —
    chamar sujaria o gate G10); sem credencial o gate da rota fecha sozinho
    (200 + skipped) e a chamada é segura."""
    provider = os.environ.get("EMBEDDING_PROVIDER") or "voyage"
    if provider == "local" or os.environ.get("EMBEDDING_BASE_URL"):
        return False
    if provider == "voyage" and os.environ.get("VOYAGE_API_KEY"):
        return True
    if provider == "openai" and os.environ.get("OPENAI_API_KEY"):
        return True
    return False


def _acervo_index_pagaria() -> bool:
    """acervo-index gera embeddings de verdade só se o cron E o feature-flag do
    RAG estão ligados e o provider é remoto pago."""
    return (
        _flag("CRON_ACERVO_INDEX_ENABLED")
        and _flag("FEATURE_ACERVO_RAG")
        and _embeddings_pagos()
    )


def _hoje_brasilia() -> str:
    """Réplica de hojeBrasilia() do cron prazos: data civil YYYY-MM-DD no fuso
    America/Sao_Paulo (fallback UTC-3 fixo — BR sem DST desde 2019)."""
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo("America/Sao_Paulo")
    except Exception:  # noqa: BLE001 — tzdata ausente na imagem
        tz = timezone(timedelta(hours=-3))
    return datetime.now(tz).strftime("%Y-%m-%d")


# ─────────────────────────────────────────────────────────────────────────────
# Registro das rotas de cron (espelha worker/beat_schedule.py e app/src/app/api/cron/)
# ─────────────────────────────────────────────────────────────────────────────
# guard: callable que, quando True, PULA a execução autorizada (custo de IA).
# aceita_502: contrato REAL da rota inclui 502 (falha de egress externo).
CRONS: dict[str, dict] = {
    "prazos":              {"timeout": TIMEOUT_PESADO},
    "vencimentos":         {"timeout": TIMEOUT_PESADO},
    "sync-monitor":        {"timeout": TIMEOUT_LEVE},
    "digest-licitacoes":   {"timeout": TIMEOUT_LEVE},  # 0026: sem transporte -> {ok, skipped}
    "saude-contratos":     {"timeout": TIMEOUT_PESADO},  # gap recalc usa usarIA:false
    "cnpj-watch":          {"timeout": TIMEOUT_PESADO, "aceita_502": True},
    "triagem-semantica":   {
        "timeout": TIMEOUT_LEVE,
        "guard":   _triagem_chamaria_anthropic,
        "motivo":  "ANTHROPIC_API_KEY presente + CRON_TRIAGEM_ENABLED — execução "
                   "real chamaria Claude (pago); contrato 401/skip coberto nos "
                   "demais testes",
    },
    "convocacao-watch":    {"timeout": TIMEOUT_LEVE},
    "acervo-index":        {
        "timeout": TIMEOUT_PESADO,
        "guard":   _acervo_index_pagaria,
        "motivo":  "provider de embeddings remoto pago (voyage/openai) configurado — "
                   "on-prem o caminho suportado é TEI local (EMBEDDING_PROVIDER=local)",
    },
    "digest-executivo":    {"timeout": TIMEOUT_PESADO},
    "relatorio-mensal":    {"timeout": TIMEOUT_PESADO},
}

# Cron mais INÓCUO pelo código (escolha justificada): convocacao-watch faz 1
# SELECT de gatilhos (em geral vazio), dedup nativo por convocacao_notificada_em,
# zero IA, e-mail só com gatilho E SMTP interno gated — ideal p/ rodar 2x.
CRON_INOCUO = "convocacao-watch"


def _url(nome: str) -> str:
    return f"/api/cron/{nome}"


def _campos_resultado(body: dict) -> set[str]:
    """Campos de resultado além do ok (stats/skipped/alerta/situacao/...)."""
    return set(body) - {"ok"}


# ─────────────────────────────────────────────────────────────────────────────
# Fixture: client httpx no web (skip se a stack não está no ar — igual conftest)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="session")
def web():
    """httpx.Client cru no Next (sem sessão — crons autenticam por Bearer)."""
    base = (os.environ.get("ONPREM_BASE_URL") or DEFAULT_WEB_BASE).rstrip("/")
    client = httpx.Client(base_url=base, timeout=TIMEOUT_LEVE)
    try:
        client.get("/api/auth/csrf")  # sonda de liveness barata
    except httpx.TransportError as exc:
        client.close()
        pytest.skip(f"web não alcançável em {base} ({exc}) — make up + perfil tests?")
    yield client
    client.close()


# ─────────────────────────────────────────────────────────────────────────────
# Sanidade: a credencial do tester é aceita (diagnóstico claro de seed/env)
# ─────────────────────────────────────────────────────────────────────────────
def test_cron_headers_do_tester_sao_aceitos(web):
    """cron_headers() (Bearer CRON_SECRET do .env.onprem, ou x-vercel-cron em
    dev) DEVE autenticar — 401 aqui significa CRON_SECRET divergente entre o
    tester e o container web, e derruba a suíte inteira com causa óbvia."""
    r = web.get(_url(CRON_INOCUO), headers=cron_headers(), timeout=TIMEOUT_LEVE)
    assert r.status_code != 401, (
        f"verifyCronAuth rejeitou cron_headers() (HTTP {r.status_code}: {r.text[:200]}) — "
        "CRON_SECRET do tester difere do CRON_SECRET do web? (env_file .env.onprem)"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 401 — sem credencial / credencial errada / x-vercel-cron forjado
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("nome", sorted(CRONS), ids=sorted(CRONS))
def test_cron_sem_credencial_retorna_401(web, nome):
    """GET /api/cron/<nome> SEM header nenhum → 401 {"error"} antes de qualquer
    efeito colateral (verifyCronAuth/autorizarCron é a 1ª linha do handler).
    Vale p/ TODAS as rotas, inclusive as de IA (gate de auth é grátis)."""
    r = web.get(_url(nome), timeout=TIMEOUT_LEVE)
    assert r.status_code == 401, f"{nome}: esperado 401, veio {r.status_code}: {r.text[:200]}"
    body = r.json()
    assert "error" in body, f"{nome}: 401 sem campo error: {body}"


def test_cron_bearer_errado_retorna_401(web):
    """Bearer com segredo INVÁLIDO → 401 (comparação constant-time de
    verifyCronAuth; sem CRON_SECRET no web o header errado tampouco passa,
    pois não é x-vercel-cron)."""
    r = web.get(
        _url(CRON_INOCUO),
        headers={"Authorization": "Bearer segredo-invalido-e2e"},
        timeout=TIMEOUT_LEVE,
    )
    assert r.status_code == 401, f"esperado 401, veio {r.status_code}: {r.text[:200]}"


def test_cron_x_vercel_cron_forjado_nao_basta_em_prod(web):
    """Com CRON_SECRET configurado (caminho de produção on-prem), o header
    x-vercel-cron: 1 sozinho NÃO autoriza (qualquer cliente externo forja) —
    contrato explícito de verifyCronAuth. Sem CRON_SECRET no ambiente, o modo
    dev aceita o header de propósito → teste não se aplica (skip)."""
    if not os.environ.get("CRON_SECRET"):
        pytest.skip("CRON_SECRET ausente no env do tester — modo dev aceita x-vercel-cron")
    r = web.get(_url(CRON_INOCUO), headers={"x-vercel-cron": "1"}, timeout=TIMEOUT_LEVE)
    assert r.status_code == 401, (
        f"x-vercel-cron forjado foi ACEITO (HTTP {r.status_code}) com CRON_SECRET "
        "configurado — regressão de segurança em verifyCronAuth"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 200 — execução autorizada de cada rota (skipped:true É sucesso)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("nome", sorted(CRONS), ids=sorted(CRONS))
def test_cron_autorizado_responde_contrato(web, nome):
    """GET autorizado (cron_headers) → 200 + JSON {"ok": true, ...} com campo de
    resultado (stats/alerta/situacao/enviado/...) OU "skipped" — o skipped é o
    contrato do gate gracioso (cron desabilitado por env, IA/embeddings
    indisponíveis) e conta como SUCESSO.

    Exceções codificadas nas rotas (contrato REAL, não imaginário):
      - cnpj-watch: 502 {"ok": false, "error"} quando a BrasilAPI não responde
        (air-gap); aceito como contrato de egress bloqueado.
      - crons que chamariam API paga (Anthropic/voyage/openai) com credencial
        real no env: PULADOS — regra de ouro de custo (gate 401 já coberto).
    """
    meta = CRONS[nome]
    guard = meta.get("guard")
    if guard is not None and guard():
        pytest.skip(f"{nome}: {meta['motivo']}")

    try:
        r = web.get(_url(nome), headers=cron_headers(), timeout=meta["timeout"])
    except httpx.TimeoutException:
        if meta.get("aceita_502"):
            pytest.skip(
                f"{nome}: rota pendurada além de {meta['timeout']}s — egress externo "
                "aparentemente DROPado (sem RST); contrato 502 não observável"
            )
        raise

    aceitos = {200, 502} if meta.get("aceita_502") else {200}
    assert r.status_code in aceitos, (
        f"{nome}: esperado {sorted(aceitos)}, veio {r.status_code}: {r.text[:300]}"
    )
    body = r.json()
    assert isinstance(body, dict), f"{nome}: payload não é objeto JSON: {r.text[:200]}"

    if r.status_code == 502:
        # cnpj-watch sem rota até a BrasilAPI: {"ok": false, "error": ...}
        assert body.get("ok") is False and "error" in body, f"{nome}: 502 fora do contrato: {body}"
        return

    assert body.get("ok") is True, f"{nome}: 200 sem ok:true: {body}"
    assert _campos_resultado(body), (
        f"{nome}: resposta sem campo de resultado/skipped além do ok: {body}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Idempotência — 2 execuções seguidas do cron mais inócuo
# ─────────────────────────────────────────────────────────────────────────────
def test_cron_inocuo_idempotente_em_duas_execucoes(web):
    """convocacao-watch 2x seguidas (escolha PELO CÓDIGO: 1 SELECT de gatilhos,
    dedup nativo marcando licitacao_eventos_vencedor.convocacao_notificada_em
    ANTES de devolver, zero IA, e-mail gated): as duas execuções devolvem 200 +
    ok:true com o MESMO conjunto de campos, e a 2ª não reprocessa gatilho algum
    (dedup consumiu todos na 1ª — stats.gatilhos == 0). cnpj-watch foi
    descartado de propósito: depende de egress externo e INSERE um snapshot em
    cnpj_status_log a cada execução (não é inócuo nem determinístico on-prem)."""
    r1 = web.get(_url(CRON_INOCUO), headers=cron_headers(), timeout=TIMEOUT_LEVE)
    r2 = web.get(_url(CRON_INOCUO), headers=cron_headers(), timeout=TIMEOUT_LEVE)

    for i, r in ((1, r1), (2, r2)):
        assert r.status_code == 200, f"execução {i}: HTTP {r.status_code}: {r.text[:200]}"

    b1, b2 = r1.json(), r2.json()
    assert b1.get("ok") is True and b2.get("ok") is True, f"ok divergente: {b1} / {b2}"
    assert set(b1) == set(b2), (
        f"contrato mudou entre execuções: {sorted(b1)} != {sorted(b2)}"
    )

    # Gate gracioso (cron desabilitado) também é idempotente — nada mais a provar.
    if b2.get("skipped"):
        assert b1.get("skipped") == b2.get("skipped")
        return

    stats2 = b2.get("stats") or {}
    assert stats2.get("gatilhos") == 0, (
        f"2ª execução reprocessou gatilhos (dedup convocacao_notificada_em falhou?): {stats2}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Efeito colateral (psycopg) — invariante do cron prazos sobre licitacoes.fase
# ─────────────────────────────────────────────────────────────────────────────
def test_prazos_encerra_fases_vencidas_no_banco(web, db):
    """Após uma execução autorizada de /api/cron/prazos, NENHUMA licitação pode
    restar em 'Recebendo Propostas'/'Agendada (Futura)' com data_fim (string de
    data civil) anterior a hoje-Brasília — é exatamente o UPDATE do passo 0 da
    rota. Reexecutável à vontade (UPDATE idempotente, e-mails deduplicados pela
    própria rota). De quebra confere que a âncora do seed (fixtures.LIC_ID, que
    o seed mantém com prazo FUTURO) não foi encerrada indevidamente."""
    r = web.get(_url("prazos"), headers=cron_headers(), timeout=TIMEOUT_PESADO)
    assert r.status_code == 200, f"prazos: HTTP {r.status_code}: {r.text[:300]}"
    assert r.json().get("ok") is True

    hoje = _hoje_brasilia()
    with db.cursor() as cur:
        # Mesma cláusula WHERE do UPDATE da rota (data_fim é text — comparação
        # lexicográfica YYYY-MM-DD, igual ao SQL do handler).
        cur.execute(
            """
            SELECT count(*) FROM licitacoes
            WHERE fase IN ('Recebendo Propostas', 'Agendada (Futura)')
              AND data_fim IS NOT NULL
              AND data_fim != ''
              AND data_fim < %s
            """,
            (hoje,),
        )
        restantes = cur.fetchone()[0]
        assert restantes == 0, (
            f"{restantes} licitação(ões) vencida(s) seguem com fase ativa após o cron"
        )

        cur.execute(
            "SELECT fase, data_fim FROM licitacoes WHERE id = %s",
            (fixtures.LIC_ID,),
        )
        row = cur.fetchone()

    if row is None:
        pytest.skip("fixtures.LIC_ID não semeado — rode make seed-e2e antes")
    fase, data_fim = row
    if data_fim and data_fim >= hoje:
        assert fase != "Prazo Encerrado", (
            f"LIC_ID com data_fim futura ({data_fim}) foi encerrada indevidamente"
        )


# ─────────────────────────────────────────────────────────────────────────────
# sync-monitor POST (único cron com handler POST — GitHub Actions on failure)
# ─────────────────────────────────────────────────────────────────────────────
def test_sync_monitor_post_sem_auth_retorna_401(web):
    """POST /api/cron/sync-monitor sem Bearer → 401 quando CRON_SECRET está
    configurado (verifyBearer). Mandamos body INVÁLIDO de propósito: se a auth
    estiver quebrada, a rota responde 400 ANTES de disparar e-mail de alerta —
    o teste falha provando a regressão sem efeito colateral. Sem CRON_SECRET no
    env, o POST passa direto por contrato de dev → não se aplica (skip)."""
    if not os.environ.get("CRON_SECRET"):
        pytest.skip("CRON_SECRET ausente — em dev o POST passa sem Bearer (contrato)")
    r = web.post(
        _url("sync-monitor"),
        content=b"isto-nao-e-json",
        headers={"Content-Type": "application/json"},
        timeout=TIMEOUT_LEVE,
    )
    assert r.status_code == 401, (
        f"POST sem Bearer deveria dar 401 com CRON_SECRET configurado, veio "
        f"{r.status_code}: {r.text[:200]}"
    )


def test_sync_monitor_post_body_invalido_retorna_400(web):
    """POST autorizado com body que não é JSON → 400 {"error": "Body inválido"}
    (parse vem logo após a auth, antes de qualquer e-mail) — prova o gate de
    payload sem disparar o alerta real aos admins."""
    headers = {**cron_headers(), "Content-Type": "application/json"}
    r = web.post(
        _url("sync-monitor"),
        content=b"isto-nao-e-json",
        headers=headers,
        timeout=TIMEOUT_LEVE,
    )
    assert r.status_code == 400, f"esperado 400, veio {r.status_code}: {r.text[:200]}"
    assert "error" in r.json()


# ─────────────────────────────────────────────────────────────────────────────
# Lock / catch-up — documentado-mas-não-implementado NA ROTA (xfail, auditoria)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.xfail(
    strict=False,
    reason=(
        "lock/catch-up do G8 existem SÓ na camada do worker (tasks.cron_trigger: "
        "Redis SET NX EX 900, chave lock:worker:cron:<nome>; sem catch-up de "
        "janelas perdidas). As rotas /api/cron/* NÃO expõem lock próprio — duas "
        "chamadas HTTP diretas executam em paralelo. Verificado no código em "
        "2026-06-11; quando a rota ganhar lock/catch-up, promover a assert dura."
    ),
)
def test_lock_e_catchup_expostos_pela_rota(web):
    """Sonda o contrato AUSENTE: uma execução autorizada do cron inócuo deveria
    declarar estado de lock/catch-up no payload se a rota implementasse o
    mecanismo (hoje só o worker tem — ver reason)."""
    r = web.get(_url(CRON_INOCUO), headers=cron_headers(), timeout=TIMEOUT_LEVE)
    assert r.status_code == 200
    body = r.json()
    marcadores = {"lock", "locked", "lockedUntil", "catchUp", "catch_up", "catchup"}
    assert marcadores & set(body), (
        f"rota não expõe lock/catch-up (campos {sorted(body)}) — esperado enquanto "
        "o mecanismo viver apenas no worker"
    )
