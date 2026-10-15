"""tests/e2e/acervo_rag_api.py — Suíte E2E do RAG/acervo (WP12 §3 — gate G6 do go_no_go).

Prova, contra a stack VIVA (perfil "tests" do compose), os 4 contratos do RAG:

  1. TEI direto (embeddings-local, BGE-m3/1024): POST /v1/embeddings com 1 texto
     devolve vetor dim==1024; o LIMITE de lote é documentado em runtime — 32
     textos passam, 33 tomam HTTP 413 (default ``max_client_batch_size`` do TEI,
     o serviço sobe SEM ``--max-client-batch-size`` no docker-compose). É por
     isso que o client do app fatia em EMBEDDING_MAX_LOTE=32
     (app/src/lib/acervo/embeddings.ts::embedLocal) — aqui testamos o serviço
     PURO para cravar o porquê do fatiamento.
  2. POST /api/acervo/buscar autenticado → 200 com estrutura válida. GUARDIÃO DO
     BLOQUEANTE #2 (AUDITORIA-2026-06-10): o gate de embeddings foi corrigido p/
     reconhecer o provider local — a rota NÃO pode mais responder
     ``disponivel:false`` ("provider não configurado"). Acervo vazio → listas
     vazias é OK; ``disponivel`` DEVE ser true.
  3. Anti-IDOR — contrato REAL de guards.ts::requireAcervo/assertAcessoObjeto:
     não há ACL por documento (escopo = tudo do tenant interno); a barreira é
     por PAPEL (EXTERNO → 403 FORBIDDEN) e por SESSÃO (sem auth → 401, mesmo
     mandando filtro licitacaoId de escopo alheio — o filtro nunca bypassa o
     guard, que roda ANTES de qualquer lógica).
  4. Sem sessão → 401/redirect (web) e 401 (BFF, token ausente/vencido).

Paridade: a rota migrada do BFF (bff/app/routers/migrated/acervo_buscar.py,
montada SEM prefixo no MESMO path /api/acervo/buscar) responde o MESMO shape
do Next, inclusive erros FLAT ``{error, code}`` (handleApiError espelhado pelo
exception_handler 401/403 do bff/app/main.py).

REGRA DE OURO (custo): NENHUMA chamada paga à API Anthropic. Toda busca
autenticada usa ``licitacaoId = fixtures.UUID_NAO_SEMEADO`` (0 chunks garantido
→ retorno ANTES da síntese) — exceto o round-trip de retrieval, que SÓ roda com
ANTHROPIC_API_KEY provadamente ausente do ambiente (skip caso contrário) e
FALHA ALTO se uma síntese acontecer mesmo assim (sinal de env desalinhado).

Idempotência: o único teste com escrita (chunk semeado em acervo_chunks) faz
DELETE antes E depois (UUID sentinela próprio da suíte). Rate limit
(rl:acervo-buscar:<user>, 30/60s — replicado em web e BFF) é limpo no setup do
módulo p/ re-execuções em sequência nunca esbarrarem em 429.

Rodar: ``pytest -q tests/e2e/acervo_rag_api.py`` (run_e2e.sh chama assim e
consolida o junit em tests/_artifacts/e2e_results.json — suíte "acervo_rag_api").
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
import pytest

# tests.lib é alcançável com PYTHONPATH=/ (tester) ou repo-root no host; o
# fallback cobre invocação direta fora do run_e2e.sh (mesmo truque do conftest).
try:
    from tests.lib import fixtures
    from tests.lib.auth_helpers import bff_client, forge_bff_token, login_web, redis_conn
except ImportError:  # pragma: no cover — execução avulsa no host
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from tests.lib import fixtures
    from tests.lib.auth_helpers import bff_client, forge_bff_token, login_web, redis_conn

# ── Contratos de ambiente (env_file .env.onprem no tester) ────────────────────
WEB_BASE = (os.environ.get("ONPREM_BASE_URL") or "http://web:3000").rstrip("/")
BFF_BASE = (os.environ.get("BFF_BASE_URL") or "http://bff:8000").rstrip("/")
TEI_BASE = (os.environ.get("EMBEDDING_BASE_URL") or "http://embeddings-local:80").rstrip("/")
TEI_MODEL = os.environ.get("EMBEDDING_MODEL") or "BAAI/bge-m3"
# BGE-m3 = 1024; DEVE casar com acervo_chunks.embedding vector(1024) (migration 0015).
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIMENSOES") or 1024)
# Default do TEI sem --max-client-batch-size: 32 inputs/request (origem do
# EMBEDDING_MAX_LOTE=32 no client do app — embeddings.ts).
TEI_MAX_LOTE = 32

ROTA_BUSCAR = "/api/acervo/buscar"
TIMEOUT = httpx.Timeout(20.0)
# Lote de 32 passa por inferência real (CPU; emulado em dev arm64) — folga maior.
TIMEOUT_LOTE = httpx.Timeout(90.0)

# UUIDs sentinela EXCLUSIVOS desta suíte (padrão das fixtures, sufixos a6/a7 —
# fora das faixas semeadas 01..07/01xx/02xx/03xx/04xx/05xx e do reservado ff).
CHUNK_E2E_ID = "00000000-0000-4000-8000-0000000000a6"
ORIGEM_E2E_ID = "00000000-0000-4000-8000-0000000000a7"
# Texto-âncora com marcador único: pergunta == texto → similaridade ≈ 1.0,
# muito acima do corte default (ACERVO_SIMILARIDADE_MIN = 0.35).
TEXTO_ANCORA = (
    "E2E-G6-ACERVO-RAG: atestado de capacidade técnica da Proponente em engenharia "
    f"de processo (família CRC {fixtures.FAM_CODIGO_CRC}) para unidades de refino da Petrobras."
)

# Pergunta inócua das buscas de contrato — sempre filtrada por UUID_NAO_SEMEADO
# (0 chunks garantido ⇒ a rota retorna ANTES de qualquer síntese paga).
PERGUNTA_PADRAO = "Quais atestados de engenharia de processo existem no acervo?"
FILTRO_SEM_CHUNKS = {"licitacaoId": fixtures.UUID_NAO_SEMEADO}


def _payload_sem_chunks(pergunta: str = PERGUNTA_PADRAO) -> dict:
    return {"pergunta": pergunta, **FILTRO_SEM_CHUNKS}


def _vetor_literal(vetor: list[float]) -> str:
    """Serializa p/ literal pgvector '[a,b,c]' (mesmo formato do toDriver do app)."""
    return "[" + ",".join(repr(float(v)) for v in vetor) + "]"


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures locais da suíte
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module", autouse=True)
def rl_limpo():
    """Zera rl:acervo-buscar:<user> (30 hits/60s) p/ re-execuções nunca verem 429.

    Web (app/src/lib/rate-limit) e BFF (app/core/rate_limit.py) usam o MESMO
    prefixo ``rl:`` no Redis db0. Best-effort: Redis fora do ar não derruba a
    suíte aqui (cada teste falha sozinho com diagnóstico melhor).
    """
    try:
        with redis_conn() as r:
            for uid in fixtures.USER_IDS.values():
                r.delete(f"rl:acervo-buscar:{uid}")
    except Exception:  # noqa: BLE001 — limpeza é conveniência, não contrato
        pass
    yield


@pytest.fixture(scope="module")
def tei() -> httpx.Client:
    """Client no TEI puro (embeddings-local). Serviço FORA do ar = FAIL, não skip:
    G6 existe exatamente p/ provar o provider local vivo (bloqueante #2)."""
    client = httpx.Client(base_url=TEI_BASE, timeout=TIMEOUT)
    try:
        r = client.get("/health")
    except httpx.TransportError as exc:
        client.close()
        pytest.fail(
            f"embeddings-local inalcançável em {TEI_BASE} ({exc}) — serviço TEI "
            "caiu? (G6 exige o provider local de embeddings no ar)"
        )
    assert r.status_code == 200, f"TEI /health → HTTP {r.status_code} (modelo ainda baixando?)"
    yield client
    client.close()


@pytest.fixture(scope="module")
def web_anon() -> httpx.Client:
    """Client SEM cookie de sessão (prova o guard de auth do Next)."""
    client = httpx.Client(base_url=WEB_BASE, timeout=TIMEOUT, follow_redirects=False)
    yield client
    client.close()


@pytest.fixture(scope="module")
def web_externo():
    """Sessão NextAuth REAL do usuário EXTERNO (autenticado, mas barrado no acervo)."""
    try:
        client = login_web(fixtures.USERS["EXTERNO"], fixtures.E2E_PASSWORD)
    except httpx.TransportError as exc:
        pytest.skip(f"web não alcançável ({exc}) — stack no ar? (make up + perfil tests)")
    yield client
    client.close()


@pytest.fixture(scope="module")
def bff_externo() -> httpx.Client:
    """Bearer JWS HS256 forjado com papel EXTERNO (modo (b) do security.py)."""
    client = bff_client(role="EXTERNO")
    yield client
    client.close()


# ─────────────────────────────────────────────────────────────────────────────
# 1. TEI direto — dimensão e LIMITE de lote (contrato do fatiamento do app)
# ─────────────────────────────────────────────────────────────────────────────


def test_tei_embedding_unitario_dim_1024(tei: httpx.Client):
    """1 texto → 1 vetor com dim==EMBEDDING_DIM (1024, coluna vector(1024))."""
    r = tei.post("/v1/embeddings", json={"model": TEI_MODEL, "input": [TEXTO_ANCORA]})
    assert r.status_code == 200, f"TEI /v1/embeddings → HTTP {r.status_code}: {r.text[:300]}"
    data = r.json().get("data") or []
    assert len(data) == 1, f"esperado 1 embedding, veio {len(data)}"
    vetor = data[0].get("embedding") or []
    assert len(vetor) == EMBEDDING_DIM, (
        f"dimensão {len(vetor)} != {EMBEDDING_DIM} — EMBEDDING_MODEL/EMBEDDING_DIMENSOES "
        "desalinhados da coluna acervo_chunks.embedding vector(1024)?"
    )
    assert all(isinstance(v, (int, float)) for v in vetor[:8]), "vetor com valores não-numéricos"


def test_tei_lote_32_dentro_do_limite(tei: httpx.Client):
    """32 textos (== max_client_batch_size default) passam em UMA request."""
    textos = [f"texto e2e g6 numero {i}" for i in range(TEI_MAX_LOTE)]
    r = tei.post(
        "/v1/embeddings",
        json={"model": TEI_MODEL, "input": textos},
        timeout=TIMEOUT_LOTE,
    )
    assert r.status_code == 200, (
        f"lote de {TEI_MAX_LOTE} deveria passar (limite default do TEI) — "
        f"HTTP {r.status_code}: {r.text[:300]}"
    )
    data = r.json().get("data") or []
    assert len(data) == TEI_MAX_LOTE, f"esperados {TEI_MAX_LOTE} vetores, vieram {len(data)}"
    # Ordem recuperável via `index` (o client do app reordena por ele).
    assert sorted(d["index"] for d in data) == list(range(TEI_MAX_LOTE))
    assert all(len(d["embedding"]) == EMBEDDING_DIM for d in data)


def test_tei_lote_33_estoura_413(tei: httpx.Client):
    """33 textos → 413: CRAVA o limite que obriga o fatiamento no client do app.

    O serviço sobe sem ``--max-client-batch-size`` ⇒ vale o default 32 do TEI.
    Validação é feita ANTES da inferência (resposta imediata). É este contrato
    que embeddings.ts::embedLocal contorna fatiando em EMBEDDING_MAX_LOTE=32 —
    um lote de 33 FUNCIONA pelo client do app (2 requests), mas não no TEI puro.
    """
    textos = [f"texto e2e g6 overflow {i}" for i in range(TEI_MAX_LOTE + 1)]
    r = tei.post("/v1/embeddings", json={"model": TEI_MODEL, "input": textos})
    assert r.status_code == 413, (
        f"lote de {TEI_MAX_LOTE + 1} deveria tomar 413 (max_client_batch_size=32) "
        f"— veio HTTP {r.status_code}: {r.text[:300]}. Se o compose ganhou "
        "--max-client-batch-size, atualizar este contrato E o EMBEDDING_MAX_LOTE do app."
    )


# ─────────────────────────────────────────────────────────────────────────────
# 2. /api/acervo/buscar autenticado — guardião do bloqueante #2
# ─────────────────────────────────────────────────────────────────────────────


def test_web_buscar_autenticado_rag_disponivel(web_admin: httpx.Client):
    """200 + ``disponivel:true`` OBRIGATÓRIO — a rota não pode mais 'desabilitar'.

    Filtro por UUID_NAO_SEMEADO ⇒ 0 chunks ⇒ retorno "Não encontrei..." ANTES de
    qualquer síntese (zero custo). Se ``disponivel`` vier false, o gate de
    embeddings REGREDIU (bloqueante #2 da AUDITORIA-2026-06-10).
    """
    r = web_admin.post(ROTA_BUSCAR, json=_payload_sem_chunks())
    assert r.status_code == 200, f"POST {ROTA_BUSCAR} → HTTP {r.status_code}: {r.text[:300]}"
    data = r.json()
    assert data.get("disponivel") is True, (
        "REGRESSÃO DO BLOQUEANTE #2: rota respondeu RAG indisponível "
        f"(motivo={data.get('motivo')!r}) — o gate deve reconhecer "
        "EMBEDDING_PROVIDER=local/EMBEDDING_BASE_URL (config.acervo.habilitado)."
    )
    # Estrutura canônica da resposta (acervo vazio p/ o filtro ⇒ listas vazias).
    assert set(data) >= {"disponivel", "resposta", "fontes", "trechos"}
    assert data["fontes"] == [] and data["trechos"] == []
    assert isinstance(data["resposta"], str) and data["resposta"].startswith("Não encontrei")


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param({"pergunta": "ab", **FILTRO_SEM_CHUNKS}, id="pergunta-curta-min3"),
        pytest.param({"pergunta": "x" * 2001, **FILTRO_SEM_CHUNKS}, id="pergunta-longa-max2000"),
        pytest.param({"pergunta": PERGUNTA_PADRAO, "licitacaoId": "nao-e-uuid"}, id="licitacaoId-invalido"),
        pytest.param(
            {"pergunta": PERGUNTA_PADRAO, "origemTipo": ["FORA_DO_ENUM"], **FILTRO_SEM_CHUNKS},
            id="origemTipo-fora-do-enum",
        ),
        pytest.param({"pergunta": PERGUNTA_PADRAO, "topK": 0, **FILTRO_SEM_CHUNKS}, id="topK-zero-min1"),
    ],
)
def test_web_buscar_validacao_422(web_admin: httpx.Client, payload: dict):
    """Body fora do zod (pergunta 3..2000; licitacaoId uuid; origemTipo enum;
    topK 1..20) → 422 FLAT ``{error, code:"VALIDATION"}`` (handleApiError)."""
    r = web_admin.post(ROTA_BUSCAR, json=payload)
    assert r.status_code == 422, f"esperado 422, veio {r.status_code}: {r.text[:300]}"
    body = r.json()
    assert body.get("code") == "VALIDATION" and isinstance(body.get("error"), str)


@pytest.mark.skipif(
    bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()),
    reason="ANTHROPIC_API_KEY presente no .env.onprem — retrieval com hits dispararia "
    "síntese PAGA no Claude (regra de ouro: nunca chamar a API Anthropic em teste).",
)
def test_web_buscar_retrieval_chunk_semeado(web_admin: httpx.Client, db, tei: httpx.Client):
    """Round-trip REAL: chunk com embedding TEI no banco → busca devolve o trecho.

    Semeia 1 chunk (UUID sentinela da suíte) vinculado a LIC_ID, embedding gerado
    pelo PRÓPRIO TEI (grátis), e busca com pergunta == texto ⇒ similaridade ≈ 1.0
    passa o corte 0.35. Sem ANTHROPIC_API_KEY o contrato é ``resposta:null`` +
    motivo de síntese indisponível + trechos retornados. Se vier ``resposta``
    string, uma chamada PAGA aconteceu ⇒ FAIL alto (env do web ≠ env do tester).
    Limpeza: DELETE antes (idempotência) e depois (sem resíduo).
    """
    with db.cursor() as cur:
        cur.execute("SELECT 1 FROM licitacoes WHERE id = %s", (fixtures.LIC_ID,))
        if cur.fetchone() is None:
            pytest.skip("seed e2e ausente (LIC_ID não está em licitacoes) — rode make seed-e2e.")

    # Embedding do texto-âncora via TEI (mesmo provider que indexa em produção).
    r_emb = tei.post("/v1/embeddings", json={"model": TEI_MODEL, "input": [TEXTO_ANCORA]})
    assert r_emb.status_code == 200, f"TEI indisponível p/ semear chunk: {r_emb.status_code}"
    vetor = r_emb.json()["data"][0]["embedding"]
    assert len(vetor) == EMBEDDING_DIM

    try:
        with db.cursor() as cur:
            cur.execute("DELETE FROM acervo_chunks WHERE id = %s", (CHUNK_E2E_ID,))
            cur.execute(
                """
                INSERT INTO acervo_chunks
                    (id, origem_tipo, origem_id, licitacao_id, chunk_index, texto, embedding, metadata)
                VALUES (%s, 'DOC_HABILITACAO', %s, %s, 0, %s, %s::vector, '{"e2e":"acervo_rag_api"}'::jsonb)
                """,
                (CHUNK_E2E_ID, ORIGEM_E2E_ID, fixtures.LIC_ID, TEXTO_ANCORA, _vetor_literal(vetor)),
            )
        db.commit()

        r = web_admin.post(
            ROTA_BUSCAR,
            json={"pergunta": TEXTO_ANCORA, "licitacaoId": fixtures.LIC_ID, "topK": 5},
        )
        assert r.status_code == 200, f"HTTP {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("disponivel") is True, f"RAG indisponível: {data.get('motivo')!r}"
        assert len(data.get("trechos") or []) >= 1, (
            "retrieval não devolveu o chunk semeado — k-NN/pgvector quebrado? "
            f"(corte de similaridade={data!r})"
        )
        trecho = data["trechos"][0]
        assert "E2E-G6-ACERVO-RAG" in trecho["texto"]
        assert trecho["similaridade"] >= 0.9, f"similaridade baixa demais: {trecho['similaridade']}"
        assert data["fontes"][0]["numero"] == 1
        assert data["fontes"][0]["licitacaoId"] == fixtures.LIC_ID
        # Sem API key: síntese NÃO roda; trechos vêm com motivo. resposta=string
        # aqui significaria que o web TEM a key (e pagamos tokens) ⇒ fail alto.
        assert data["resposta"] is None and "Síntese indisponível" in (data.get("motivo") or ""), (
            "SÍNTESE EXECUTADA (resposta não-nula) — o web tem ANTHROPIC_API_KEY que o "
            "tester não vê: alinhar .env.onprem antes de rodar esta suíte."
        )
    finally:
        with db.cursor() as cur:
            cur.execute("DELETE FROM acervo_chunks WHERE id = %s", (CHUNK_E2E_ID,))
        db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# 3. Anti-IDOR — contrato real: barreira por PAPEL (EXTERNO) e por SESSÃO
# ─────────────────────────────────────────────────────────────────────────────


def test_web_buscar_externo_403(web_externo: httpx.Client):
    """EXTERNO autenticado → 403 FORBIDDEN (requireAcervo barra ANTES de tudo:
    nem filtro de escopo de licitação alheia chega ao retrieval)."""
    r = web_externo.post(
        ROTA_BUSCAR, json={"pergunta": PERGUNTA_PADRAO, "licitacaoId": fixtures.LIC_ID}
    )
    assert r.status_code == 403, f"esperado 403 p/ EXTERNO, veio {r.status_code}: {r.text[:200]}"
    body = r.json()
    assert body.get("code") == "FORBIDDEN"
    assert body.get("error") == "Sem acesso ao acervo"


def test_bff_buscar_externo_403(bff_externo: httpx.Client):
    """Paridade no BFF: require_acervo (== ROLES_VISUALIZAR) devolve o MESMO
    shape {error:"Sem acesso ao acervo", code:"FORBIDDEN"} do Next."""
    r = bff_externo.post(
        ROTA_BUSCAR, json={"pergunta": PERGUNTA_PADRAO, "licitacaoId": fixtures.LIC_ID}
    )
    assert r.status_code == 403, f"esperado 403 p/ EXTERNO no BFF, veio {r.status_code}"
    body = r.json()
    assert body.get("code") == "FORBIDDEN" and body.get("error") == "Sem acesso ao acervo"


def test_web_buscar_sem_sessao_negada(web_anon: httpx.Client):
    """Sem cookie de sessão → 401 (ou redirect de borda). O filtro licitacaoId
    de escopo alheio na MESMA request prova que filtro nunca bypassa o guard."""
    r = web_anon.post(
        ROTA_BUSCAR, json={"pergunta": PERGUNTA_PADRAO, "licitacaoId": fixtures.LIC_ID}
    )
    assert r.status_code in (401, 302, 303, 307, 308), (
        f"sem sessão deveria ser 401/redirect, veio {r.status_code}: {r.text[:200]}"
    )
    if r.status_code == 401:
        body = r.json()
        assert body.get("code") == "UNAUTHENTICATED"


def test_bff_buscar_sem_token_e_token_vencido_401():
    """BFF: sem Authorization → 401; JWS HS256 com exp no passado → 401."""
    with httpx.Client(base_url=BFF_BASE, timeout=TIMEOUT) as anon:
        r = anon.post(ROTA_BUSCAR, json=_payload_sem_chunks())
        assert r.status_code == 401, f"sem token deveria ser 401, veio {r.status_code}"
        assert r.json().get("code") == "UNAUTHENTICATED"

        vencido = forge_bff_token(role="ADMIN", ttl_segundos=-30)
        r2 = anon.post(
            ROTA_BUSCAR,
            json=_payload_sem_chunks(),
            headers={"Authorization": f"Bearer {vencido}"},
        )
        assert r2.status_code == 401, f"token vencido deveria ser 401, veio {r2.status_code}"


# ─────────────────────────────────────────────────────────────────────────────
# 4. Paridade da rota migrada no BFF (estrangulador, mesmo path /api/acervo/buscar)
# ─────────────────────────────────────────────────────────────────────────────


def test_bff_buscar_paridade_contrato(bff_admin: httpx.Client):
    """BFF autenticado → 200 com o MESMO shape do Next (guardião #2 na porta migrada)."""
    r = bff_admin.post(ROTA_BUSCAR, json=_payload_sem_chunks())
    assert r.status_code == 200, f"POST BFF {ROTA_BUSCAR} → {r.status_code}: {r.text[:300]}"
    data = r.json()
    assert data.get("disponivel") is True, (
        f"BFF respondeu RAG indisponível (motivo={data.get('motivo')!r}) — "
        "embeddings_disponivel() do BFF não reconhece o provider local?"
    )
    assert set(data) >= {"disponivel", "resposta", "fontes", "trechos"}
    assert data["fontes"] == [] and data["trechos"] == []
    assert isinstance(data["resposta"], str) and data["resposta"].startswith("Não encontrei")


def test_bff_buscar_validacao_422_shape_flat(bff_admin: httpx.Client):
    """422 do BFF replica o handleApiError do Next: corpo FLAT {error, code} exato."""
    r = bff_admin.post(ROTA_BUSCAR, json={"pergunta": "ab", **FILTRO_SEM_CHUNKS})
    assert r.status_code == 422, f"esperado 422, veio {r.status_code}: {r.text[:300]}"
    body = r.json()
    assert set(body) == {"error", "code"}, f"shape não-flat: {body!r}"
    assert body["code"] == "VALIDATION"
