"""
0034 — Suíte de VAZAMENTO do ``restrito`` (núcleo do 05-OPERACAO §2.5) no BFF.

Contrato que este arquivo trava: **papel fora de Conformidade (ORCAMENTISTA,
TECNICO, VISUALIZADOR) NUNCA vê documento restrito** — nem a linha na lista, nem
o metadado no detalhe, nem um byte no download — e EXTERNO nem chega ao guard
das superfícies. As superfícies núcleo cobertas aqui (numeração do 05-OPERACAO
§2.2/§2.5):

  S1 lista do cofre (R6) · S2 detalhe (R17) · S3 download (R16) ·
  S5 verificar sha256 (R5) · S6 dossiê da operação (R3) · S7 adoção em lote (R11)

O arquivo tem DUAS camadas, de propósito:

  CAMADA A — guards in-process, SEM banco (roda no ``make test-unit-bff``):
    prova que quem nem deveria alcançar a superfície toma 401/403 com o corpo
    exato ANTES de qualquer I/O. Guard não prova não-vazamento de linha — só
    fecha a porta de quem está fora.

  CAMADA B — cenário SEMEADO, marcada para o **Gate 2** (skipif sem
    ``DATABASE_URL``): semeia 1 operação + 3 documentos (normal, restrito com
    sha conhecido, restrito órfão) via psycopg e afirma a INVISIBILIDADE real:
    linha filtrada da lista com ``total`` coerente, 404 do detalhe/download
    **byte-idêntico ao de id inexistente** (ADR-05 — 403 confirmaria a
    existência), entrada CEGA no verificar, dossiê sem o restrito e
    ``motivo:"RESTRITO"`` na adoção em lote. Rode com o stack do compose
    (Postgres + handlers 0034 no BFF) e ``DATABASE_URL`` exportado no ambiente.

Fora do escopo DESTE arquivo (cobertos pela suíte e2e do 02-APIS §18.2/§18.3 —
``tests/e2e/acervo_operacoes_api.py`` — e pela matriz completa S1–S18 de
``test_restrito_superficies.py`` do 05-OPERACAO §2.5): S4 ZIP e espelho
``audit_download_restrito`` (exigem MinIO real), satélites S8–S18 e a
comparação de paridade Next×BFF dos mesmos cenários.

Tokens: JWS HS256 forjados por papel (``jwt_factory`` do conftest raiz). Nos
testes de ESCRITA da camada B o ``sub`` do token é um ``users.id`` REAL lido do
banco — ``atualizado_por`` tem FK para ``users`` e um sub sintético estouraria
antes de provar qualquer coisa.
"""
from __future__ import annotations

import hashlib
import os
import uuid as _uuid

import pytest

from tests.conftest import auth_headers

MARCADOR = "UNIT-ACERVO-RESTRITO"

# UUID válido e garantidamente não-semeado (v4 fixo) — o 404 "de inexistente"
# que serve de gabarito byte a byte para o 404 "de restrito invisível".
UUID_INEXISTENTE = "22222222-2222-4222-8222-222222222222"

PAPEIS_FORA_DE_CONFORMIDADE = ("ORCAMENTISTA", "TECNICO", "VISUALIZADOR")

GATE2 = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason=(
        "Gate 2: cenário SEMEADO — exige o Postgres do stack (DATABASE_URL no "
        "ambiente) e os handlers 0034 no BFF; guard sozinho não prova o "
        "não-vazamento de linha/metadado"
    ),
)


# ─────────────────────────────────────────────────────────────────────────────
# CAMADA A — guards (sem banco): quem está FORA nem alcança a superfície
# ─────────────────────────────────────────────────────────────────────────────

# (método, rota) das superfícies de LEITURA guardadas por requireVisualizar.
SUPERFICIES_VISUALIZAR = [
    ("GET", "/api/conformidade/cofre/documentos"),  # S1 lista (R6)
    ("GET", f"/api/conformidade/cofre/documentos/{UUID_INEXISTENTE}"),  # S2 detalhe (R17)
    ("GET", f"/api/conformidade/cofre/documentos/{UUID_INEXISTENTE}/download"),  # S3 download (R16)
    ("POST", "/api/conformidade/cofre/documentos/bulk-download"),  # S4 ZIP (R12) — guard-only aqui
    ("GET", f"/api/conformidade/operacoes/{UUID_INEXISTENTE}"),  # S6 dossiê (R3)
]


async def _chamar(client, metodo: str, rota: str, headers=None, json=None):
    if metodo == "GET":
        return await client.get(rota, headers=headers)
    return await client.post(rota, json=({} if json is None else json), headers=headers)


@pytest.mark.parametrize("metodo,rota", SUPERFICIES_VISUALIZAR)
async def test_sem_token_da_401(client, metodo, rota):
    r = await _chamar(client, metodo, rota)
    assert r.status_code == 401, f"{metodo} {rota}: esperado 401 sem token, veio {r.status_code}"
    assert r.json().get("code") == "UNAUTHENTICATED"


@pytest.mark.parametrize("metodo,rota", SUPERFICIES_VISUALIZAR)
async def test_externo_nao_alcanca_superficie(client, token_externo, metodo, rota):
    """EXTERNO para no requireVisualizar — 403 COM `code` (guard que LANÇA)."""
    r = await _chamar(client, metodo, rota, auth_headers(token_externo))
    assert r.status_code == 403, f"{metodo} {rota}: EXTERNO deveria tomar 403, veio {r.status_code}"
    assert r.json() == {"error": "Permissão negada", "code": "FORBIDDEN"}


async def test_verificar_barra_quem_nao_gerencia(client, token_visualizador):
    """S5 (R5): VISUALIZADOR para na checagem inline — 403 SEM `code`, antes de
    qualquer SELECT: nenhum metadado (cego ou não) é alcançável por ele."""
    r = await _chamar(
        client,
        "POST",
        "/api/conformidade/cofre/documentos/verificar",
        auth_headers(token_visualizador),
        json={"sha256": ["a" * 64]},
    )
    assert r.status_code == 403
    corpo = r.json()
    assert corpo == {"error": "Permissão negada"}
    assert "code" not in corpo


async def test_vincular_barra_quem_nao_gerencia(client, token_visualizador):
    """S7 (R11): mesma checagem inline do verificar — 403 SEM `code`."""
    r = await _chamar(
        client,
        "POST",
        "/api/conformidade/cofre/documentos/vincular-operacao",
        auth_headers(token_visualizador),
        json={"ids": [UUID_INEXISTENTE], "operacaoId": UUID_INEXISTENTE},
    )
    assert r.status_code == 403
    corpo = r.json()
    assert corpo == {"error": "Permissão negada"}
    assert "code" not in corpo


# ─────────────────────────────────────────────────────────────────────────────
# CAMADA B — cenário semeado (Gate 2): a invisibilidade REAL, linha a linha
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def dossie_restrito():
    """Semeia a fixture do 05-OPERACAO §2.5 (variante mínima desta suíte):
    1 operação + doc_normal, doc_restrito (sha conhecido) e doc_restrito_orfao.

    Idempotente/re-executável: títulos carregam MARCADOR + nonce e o teardown
    varre por eles (SQL best-effort). O ``uploadado_por`` vem de um usuário REAL
    do seed base — a FK não aceita sub sintético.
    """
    psycopg = pytest.importorskip("psycopg", reason="psycopg (deps do tester) para semear")
    dsn = os.environ["DATABASE_URL"]
    nonce = _uuid.uuid4().hex[:10]
    sha_restrito = hashlib.sha256(f"{MARCADOR}-{nonce}-restrito".encode()).hexdigest()
    conn = psycopg.connect(dsn, autocommit=True)
    dados: dict[str, str] = {"nonce": nonce, "shaRestrito": sha_restrito}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users ORDER BY criado_em ASC LIMIT 1")
            row = cur.fetchone()
            assert row, "seed base ausente: nenhum usuário no banco (rode make seed-e2e)"
            dados["userId"] = str(row[0])

            dados["codigo"] = f"9T{nonce}"
            cur.execute(
                "INSERT INTO operacoes (codigo, cliente_nome, detentora) "
                "VALUES (%s, %s, 'PROPONENTE') RETURNING id",
                (dados["codigo"], f"{MARCADOR} CLIENTE {nonce}"),
            )
            dados["operacaoId"] = str(cur.fetchone()[0])

            def _doc(sufixo: str, *, restrito: bool, operacao_id: str | None, sha: str | None) -> str:
                titulo = f"{MARCADOR} {nonce} {sufixo}"
                cur.execute(
                    """
                    INSERT INTO documentos_habilitacao
                      (categoria, subcategoria, titulo, nome_arquivo, blob_url, blob_key,
                       sha256, restrito, operacao_id, papel, uploadado_por)
                    VALUES ('TECNICA', 'ATESTADO_ACT', %s, %s, %s, %s,
                            %s, %s, %s, 'ATESTADO', %s)
                    RETURNING id
                    """,
                    (
                        titulo,
                        f"{titulo}.pdf",
                        f"blob://{MARCADOR}/{nonce}/{sufixo}",
                        f"conformidade/cofre/TECNICA/ATESTADO_ACT/{MARCADOR}-{nonce}-{sufixo}.pdf",
                        sha,
                        restrito,
                        operacao_id,
                        dados["userId"],
                    ),
                )
                return str(cur.fetchone()[0])

            dados["docNormal"] = _doc("NORMAL", restrito=False, operacao_id=dados["operacaoId"], sha=None)
            dados["docRestrito"] = _doc(
                "RESTRITO", restrito=True, operacao_id=dados["operacaoId"], sha=sha_restrito
            )
            dados["docRestritoOrfao"] = _doc("RESTRITO ORFAO", restrito=True, operacao_id=None, sha=None)
        yield dados
    finally:
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM documentos_habilitacao WHERE titulo LIKE %s",
                    (f"{MARCADOR} {nonce}%",),
                )
                cur.execute("DELETE FROM operacoes WHERE codigo = %s", (dados.get("codigo"),))
                # audit da adoção em lote (dual ADMIN) — best-effort, nunca falha o teardown.
                cur.execute(
                    "DELETE FROM audit_log WHERE acao = 'VINCULAR_OPERACAO_EM_LOTE' "
                    "AND detalhes::text LIKE %s",
                    (f"%{dados.get('operacaoId', 'nunca')}%",),
                )
        except Exception:  # noqa: BLE001 — teardown best-effort (padrão das suítes e2e)
            pass
        conn.close()


def _token(jwt_factory, role: str, user_id: str) -> str:
    """Token com sub = users.id REAL (as rotas de escrita gravam FK do autor)."""
    return jwt_factory(role=role, sub=user_id)


@GATE2
@pytest.mark.parametrize("papel", PAPEIS_FORA_DE_CONFORMIDADE)
async def test_s1_lista_filtra_linha_e_total(client, jwt_factory, dossie_restrito, papel):
    """S1 (R6): a linha restrita SOME da lista e o `total` conta só o visível —
    contagem que denuncia o oculto é vazamento (00-ARQ §3.2)."""
    d = dossie_restrito
    r = await client.get(
        "/api/conformidade/cofre/documentos",
        params={"busca": f"{MARCADOR} {d['nonce']}"},
        headers=auth_headers(_token(jwt_factory, papel, d["userId"])),
    )
    assert r.status_code == 200, r.text
    corpo = r.json()
    ids = {item["id"] for item in corpo["data"]}
    assert d["docNormal"] in ids
    assert d["docRestrito"] not in ids, f"{papel} viu a linha restrita na lista"
    assert d["docRestritoOrfao"] not in ids
    assert corpo["total"] == 1, "total deve contar SÓ o visível (não denunciar o oculto)"


@GATE2
async def test_s1_lista_admin_ve_tudo(client, jwt_factory, dossie_restrito):
    d = dossie_restrito
    r = await client.get(
        "/api/conformidade/cofre/documentos",
        params={"busca": f"{MARCADOR} {d['nonce']}"},
        headers=auth_headers(_token(jwt_factory, "ADMIN", d["userId"])),
    )
    assert r.status_code == 200, r.text
    corpo = r.json()
    ids = {item["id"] for item in corpo["data"]}
    assert {d["docNormal"], d["docRestrito"], d["docRestritoOrfao"]} <= ids
    assert corpo["total"] == 3


@GATE2
@pytest.mark.parametrize("papel", PAPEIS_FORA_DE_CONFORMIDADE)
async def test_s2_detalhe_404_identico_ao_inexistente(client, jwt_factory, dossie_restrito, papel):
    """S2 (R17): 404 do restrito BYTE-IDÊNTICO ao 404 de id inexistente (ADR-05)."""
    d = dossie_restrito
    headers = auth_headers(_token(jwt_factory, papel, d["userId"]))
    r_restrito = await client.get(
        f"/api/conformidade/cofre/documentos/{d['docRestrito']}", headers=headers
    )
    r_inexistente = await client.get(
        f"/api/conformidade/cofre/documentos/{UUID_INEXISTENTE}", headers=headers
    )
    assert r_restrito.status_code == 404, f"{papel}: esperado 404, veio {r_restrito.status_code}"
    assert r_inexistente.status_code == 404
    assert r_restrito.content == r_inexistente.content, (
        "o 404 do restrito deve ser INDISTINGUÍVEL do 404 de inexistente"
    )
    assert r_restrito.json() == {"error": "Documento não encontrado"}


@GATE2
async def test_s2_detalhe_admin_ve_com_flag(client, jwt_factory, dossie_restrito):
    d = dossie_restrito
    r = await client.get(
        f"/api/conformidade/cofre/documentos/{d['docRestrito']}",
        headers=auth_headers(_token(jwt_factory, "ADMIN", d["userId"])),
    )
    assert r.status_code == 200, r.text
    corpo = r.json()
    assert corpo["id"] == d["docRestrito"]
    assert corpo["restrito"] is True


@GATE2
@pytest.mark.parametrize("papel", PAPEIS_FORA_DE_CONFORMIDADE)
async def test_s3_download_404_identico_sem_nenhum_byte(client, jwt_factory, dossie_restrito, papel):
    """S3 (R16): a barreira vem ANTES do storage — 404 idêntico ao de
    inexistente e nenhum byte de blob no corpo."""
    d = dossie_restrito
    headers = auth_headers(_token(jwt_factory, papel, d["userId"]))
    r_restrito = await client.get(
        f"/api/conformidade/cofre/documentos/{d['docRestrito']}/download", headers=headers
    )
    r_inexistente = await client.get(
        f"/api/conformidade/cofre/documentos/{UUID_INEXISTENTE}/download", headers=headers
    )
    assert r_restrito.status_code == 404, f"{papel}: esperado 404, veio {r_restrito.status_code}"
    assert r_inexistente.status_code == 404
    assert r_restrito.content == r_inexistente.content
    assert r_restrito.headers.get("content-type", "").startswith("application/json"), (
        "404 é JSON de erro — jamais um stream"
    )


@GATE2
@pytest.mark.parametrize("papel", PAPEIS_FORA_DE_CONFORMIDADE)
async def test_s6_dossie_sem_o_restrito(client, jwt_factory, dossie_restrito, papel):
    """S6 (R3): a ficha da operação lista só o visível."""
    d = dossie_restrito
    r = await client.get(
        f"/api/conformidade/operacoes/{d['operacaoId']}",
        headers=auth_headers(_token(jwt_factory, papel, d["userId"])),
    )
    assert r.status_code == 200, r.text
    ids = {doc["id"] for doc in r.json()["documentos"]}
    assert d["docNormal"] in ids
    assert d["docRestrito"] not in ids, f"{papel} viu o restrito no dossiê"


@GATE2
async def test_s6_dossie_admin_ve_o_restrito(client, jwt_factory, dossie_restrito):
    d = dossie_restrito
    r = await client.get(
        f"/api/conformidade/operacoes/{d['operacaoId']}",
        headers=auth_headers(_token(jwt_factory, "ADMIN", d["userId"])),
    )
    assert r.status_code == 200, r.text
    ids = {doc["id"] for doc in r.json()["documentos"]}
    assert {d["docNormal"], d["docRestrito"]} <= ids


@GATE2
async def test_s5_verificar_entrada_cega(client, jwt_factory, dossie_restrito):
    """S5 (R5): p/ ORCAMENTISTA (gerencia, mas não é Conformidade) a entrada do
    sha restrito vem CEGA — 5 chaves na ORDEM do contrato, metadados null. A
    linha não é filtrada: o uploader precisa saber que é duplicata."""
    d = dossie_restrito
    r = await client.post(
        "/api/conformidade/cofre/documentos/verificar",
        json={"sha256": [d["shaRestrito"]]},
        headers=auth_headers(_token(jwt_factory, "ORCAMENTISTA", d["userId"])),
    )
    assert r.status_code == 200, r.text
    entrada = r.json()["existentes"][d["shaRestrito"]]
    assert list(entrada.keys()) == ["id", "restrito", "titulo", "criadoEm", "operacaoCodigo"], (
        "ordem das chaves é contrato (02-APIS §5.2)"
    )
    assert entrada == {
        "id": d["docRestrito"],
        "restrito": True,
        "titulo": None,
        "criadoEm": None,
        "operacaoCodigo": None,
    }


@GATE2
async def test_s5_verificar_admin_ve_pleno(client, jwt_factory, dossie_restrito):
    d = dossie_restrito
    r = await client.post(
        "/api/conformidade/cofre/documentos/verificar",
        json={"sha256": [d["shaRestrito"]]},
        headers=auth_headers(_token(jwt_factory, "ADMIN", d["userId"])),
    )
    assert r.status_code == 200, r.text
    entrada = r.json()["existentes"][d["shaRestrito"]]
    assert entrada["restrito"] is True
    assert entrada["titulo"] == f"{MARCADOR} {d['nonce']} RESTRITO"
    assert entrada["operacaoCodigo"] == d["codigo"]


@GATE2
async def test_s7_vincular_pula_restrito_com_motivo(client, jwt_factory, dossie_restrito):
    """S7 (R11): TECNICO tentando adotar o órfão restrito recebe
    `motivo:"RESTRITO"` e NADA muda no banco."""
    psycopg = pytest.importorskip("psycopg")
    d = dossie_restrito
    r = await client.post(
        "/api/conformidade/cofre/documentos/vincular-operacao",
        json={"ids": [d["docRestritoOrfao"]], "operacaoId": d["operacaoId"]},
        headers=auth_headers(_token(jwt_factory, "TECNICO", d["userId"])),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "ok": True,
        "vinculados": 0,
        "pulados": [{"id": d["docRestritoOrfao"], "motivo": "RESTRITO"}],
    }
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT operacao_id FROM documentos_habilitacao WHERE id = %s",
            (d["docRestritoOrfao"],),
        )
        assert cur.fetchone()[0] is None, "o órfão restrito NÃO pode ter sido vinculado"


@GATE2
async def test_s7_vincular_admin_adota_o_restrito(client, jwt_factory, dossie_restrito):
    """Dual do S7: para Conformidade o restrito órfão vincula normalmente."""
    psycopg = pytest.importorskip("psycopg")
    d = dossie_restrito
    r = await client.post(
        "/api/conformidade/cofre/documentos/vincular-operacao",
        json={"ids": [d["docRestritoOrfao"]], "operacaoId": d["operacaoId"]},
        headers=auth_headers(_token(jwt_factory, "ADMIN", d["userId"])),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "vinculados": 1, "pulados": []}
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT operacao_id::text FROM documentos_habilitacao WHERE id = %s",
            (d["docRestritoOrfao"],),
        )
        assert cur.fetchone()[0] == d["operacaoId"]
