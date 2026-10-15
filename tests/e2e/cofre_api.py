"""
tests/e2e/cofre_api.py — Suíte E2E do COFRE de Documentos de Habilitação (gate G7).

Prova, contra a stack VIVA (perfil "tests" do compose), a cadeia COMPLETA do
cofre — upload → MinIO → Postgres → download → delete — pela rota REAL migrada
ao BFF (estrangulador; o NGINX roteia /api/conformidade/cofre/* para o BFF):

    POST   /api/conformidade/cofre/documentos            (multipart, 201 + registro cru)
    GET    /api/conformidade/cofre/documentos/{id}/download  (proxy stream do MinIO)
    DELETE /api/conformidade/cofre/documentos/{id}        (somente ADMIN; apaga blob)
    DELETE /api/conformidade/cofre/documentos             (bulk; usado na varredura)

Elos do gate (falha de QUALQUER um = G7 reprova):
  (a) upload responde 201 com id + blobKey/sha256 coerentes;
  (b) o OBJETO existe no MinIO (boto3 direto, path-style, creds R2_* do env)
      com bytes idênticos aos enviados;
  (c) a LINHA existe no Postgres (documentos_habilitacao) com blob_key/sha256/
      tamanho consistentes com a resposta da API;
  (d) o download devolve bytes IDÊNTICOS + Content-Type/Disposition corretos;
  (e) o delete via API remove registro E blob (cleanup de verdade, não cosmético).

Contratos replicados do código REAL (não inventados):
  - bff/app/routers/migrated/conf_cofre_documentos.py     (POST/GET lista/DELETE bulk)
  - bff/app/routers/migrated/conf_cofre_documentos_id.py  (GET/PATCH/DELETE por id)
  - bff/app/routers/migrated/conf_cofre_doc_id_download.py (GET download)

REGRAS DE OURO respeitadas:
  - NENHUMA chamada paga: o flag ``ocr`` NÃO é enviado (OCR Anthropic é opt-in
    no POST; sem o flag o caminho de IA nem é tocado).
  - Idempotente/re-executável: título marcado (E2E-COFRE-G7) + nonce por run;
    varredura de sobras de runs anteriores no setup E no teardown (API bulk
    delete, com fallback SQL+S3 best-effort).
  - Auth/fixtures SOMENTE via tests/lib (bff_client/db_conn + fixtures canônicas).
  - Timeouts httpx explícitos; suíte inteira em segundos (PDF ~300 bytes).

Execução: pytest -q tests/e2e/cofre_api.py  (via tests/run_e2e.sh no tester).
"""
from __future__ import annotations

import hashlib
import os
import time
import uuid as uuid_mod

import httpx
import pytest

from tests.lib import fixtures
from tests.lib.auth_helpers import DEFAULT_BFF_BASE, bff_client, db_conn

# ── Constantes da suíte ───────────────────────────────────────────────────────
TIMEOUT = 30.0  # explícito em TODOS os clients (suíte < 120s por contrato)
ROTA_DOCS = "/api/conformidade/cofre/documentos"

# Marcador no título p/ varredura de sobras de runs anteriores (LIKE 'E2E-COFRE-G7%').
MARCADOR = "E2E-COFRE-G7"

# Categoria/subcategoria válidas do CriarDocumentoSchema (validations.ts) que não
# colidem com nada semeado — viram o prefixo determinístico da blob_key:
#   habilitacao/<categoria>/<subcategoria>/<ts_ms>_<nome_sanitizado>
CATEGORIA = "DECLARACAO"
SUBCATEGORIA = "DECL_OUTRA"
# Nome 100% ASCII-seguro: o sanitizeName do upload não altera nada nele, então a
# blob_key termina EXATAMENTE em "_<NOME_ARQUIVO>" (assert determinístico).
NOME_ARQUIVO = "e2e_cofre_g7.pdf"


# ─────────────────────────────────────────────────────────────────────────────
# Helpers de infraestrutura (MinIO via boto3 + Postgres via psycopg)
# ─────────────────────────────────────────────────────────────────────────────
def _s3_bucket() -> str:
    """Bucket do MinIO — R2_BUCKET (nome legado mantido no .env.onprem)."""
    return os.environ.get("R2_BUCKET") or os.environ.get("S3_BUCKET") or "petro-radar"


def _s3_client():
    """Cliente boto3 S3 path-style contra o MinIO (creds R2_* do env do tester).

    Mesma configuração que o BFF usa (conf_cofre_doc_id_download._s3_client):
    addressing_style=path é o equivalente boto3 do ``forcePathStyle`` do SDK JS
    — o MinIO EXIGE path-style. O compose mapeia R2_* → S3_* para o BFF; aqui
    lemos os dois nomes para tolerar qual env_file foi carregado.
    """
    import boto3
    from botocore.config import Config

    endpoint = os.environ.get("R2_ENDPOINT") or os.environ.get("S3_ENDPOINT")
    assert endpoint, (
        "R2_ENDPOINT/S3_ENDPOINT ausentes no ambiente do tester — "
        "o env_file .env.onprem foi carregado no serviço (perfil tests)?"
    )
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ.get("R2_ACCESS_KEY_ID")
        or os.environ.get("S3_ACCESS_KEY"),
        aws_secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY")
        or os.environ.get("S3_SECRET_KEY"),
        region_name=os.environ.get("R2_REGION", "us-east-1"),
        config=Config(s3={"addressing_style": "path"}),
    )


def _gerar_pdf(nonce: str) -> bytes:
    """PDF mínimo VÁLIDO gerado no teste (não é fixture binária no repo).

    Passa o _validar_magic_bytes do upload (%PDF nos 4 primeiros bytes) e carrega
    o nonce do run num comentário — bytes ÚNICOS por execução, então o assert de
    "bytes idênticos" do download prova o roundtrip REAL deste run (não um objeto
    velho de mesmo nome que tenha sobrado no bucket).
    """
    return (
        b"%PDF-1.4\n"
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n"
        + f"% nonce-e2e-g7: {nonce}\n".encode("ascii")
        + b"trailer << /Root 1 0 R /Size 4 >>\n"
        b"%%EOF\n"
    )


def _varrer_sobras(client: httpx.Client) -> None:
    """Remove documentos de runs anteriores (título LIKE 'E2E-COFRE-G7%').

    Caminho preferencial: o bulk DELETE da API (apaga blob + linha + cascatas,
    igual ao produto). Fallback best-effort: SQL + S3 direto — só se a API
    falhar (ex.: doc órfão com FK quebrada). NUNCA propaga erro: a varredura é
    higiene, não um elo do gate.
    """
    try:
        with db_conn(autocommit=True) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id::text, blob_key FROM documentos_habilitacao "
                "WHERE titulo LIKE %s",
                (MARCADOR + "%",),
            )
            sobras = cur.fetchall()
            if not sobras:
                return
            ids = [r[0] for r in sobras]
            try:
                # httpx.Client.delete não aceita body → request("DELETE", json=...).
                r = client.request("DELETE", ROTA_DOCS, json={"ids": ids})
                if r.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            # Fallback: SQL + S3 direto (mesma ordem do produto: blob, depois linha).
            s3 = _s3_client()
            for _id, blob_key in sobras:
                if blob_key:
                    try:
                        s3.delete_object(Bucket=_s3_bucket(), Key=blob_key)
                    except Exception:  # noqa: BLE001 — best-effort
                        pass
            cur.execute(
                "DELETE FROM documentos_habilitacao WHERE titulo LIKE %s",
                (MARCADOR + "%",),
            )
    except Exception:  # noqa: BLE001 — varredura nunca derruba a suíte
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Fixture central: upload REAL feito UMA vez (escopo de módulo) + cleanup
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def ctx():
    """Sobe o contexto da suíte: client ADMIN no BFF + upload real do PDF.

    O upload acontece AQUI (uma vez) e os testes verificam cada elo da cadeia
    sobre o MESMO documento — exatamente o fluxo do produto. Se o POST não vier
    201, falhamos JÁ com diagnóstico (todos os testes dependentes viram error,
    e o gate G7 reprova — comportamento desejado). Stack fora do ar → skip
    (mesma convenção dos fixtures de tests/conftest.py).
    """
    client = bff_client(role="ADMIN", timeout=TIMEOUT)

    nonce = f"{int(time.time() * 1000)}-{uuid_mod.uuid4().hex[:8]}"
    pdf = _gerar_pdf(nonce)
    titulo = f"{MARCADOR} upload {nonce}"

    try:
        _varrer_sobras(client)  # higiene de runs anteriores ANTES de criar o novo
        resp = client.post(
            ROTA_DOCS,
            files={"file": (NOME_ARQUIVO, pdf, "application/pdf")},
            data={
                "categoria": CATEGORIA,
                "subcategoria": SUBCATEGORIA,
                "titulo": titulo,
                # SEM o campo "ocr": o caminho Anthropic (pago) nem é tocado.
            },
        )
    except httpx.TransportError as exc:
        client.close()
        pytest.skip(f"BFF não alcançável ({exc}) — stack no ar? (make up + perfil tests)")

    if resp.status_code != 201:
        client.close()
        pytest.fail(
            f"POST {ROTA_DOCS} → HTTP {resp.status_code} (esperado 201). "
            f"Body: {resp.text[:300]}. Causas típicas: seed e2e não rodou "
            "(FK uploadado_por → users), MinIO fora do ar ou creds R2_* erradas."
        )

    doc = resp.json()
    contexto = {
        "client": client,
        "doc": doc,
        "pdf": pdf,
        "sha256": hashlib.sha256(pdf).hexdigest(),
        "titulo": titulo,
    }
    yield contexto

    # Teardown: o último teste já deletou via API; aqui só varremos qualquer
    # sobra (run interrompido no meio) e fechamos o client.
    _varrer_sobras(client)
    client.close()


# ═════════════════════════════════════════════════════════════════════════════
# Elo (a) — resposta 2xx com id e metadados coerentes
# ═════════════════════════════════════════════════════════════════════════════
def test_upload_responde_201_com_id_e_blob_key(ctx):
    """POST multipart → 201 com o registro cru: id UUID, blobKey no padrão
    habilitacao/<cat>/<sub>/<ts>_<nome>, sha256 do CONTEÚDO e tamanho exatos."""
    doc = ctx["doc"]

    # id é um UUID válido (PK gerada pelo banco).
    uuid_mod.UUID(doc["id"])

    # blob_key determinística do uploadHabilitacao (nome ASCII → sanitize no-op).
    blob_key = doc["blobKey"]
    assert blob_key.startswith(f"habilitacao/{CATEGORIA}/{SUBCATEGORIA}/"), (
        f"blobKey fora do padrão habilitacao/<cat>/<sub>/: {blob_key!r}"
    )
    assert blob_key.endswith(f"_{NOME_ARQUIVO}"), blob_key

    # Integridade declarada na resposta == bytes que ENVIAMOS.
    assert doc["sha256"] == ctx["sha256"], "sha256 da resposta != sha256 do PDF enviado"
    assert doc["tamanhoBytes"] == len(ctx["pdf"])
    assert doc["contentType"] == "application/pdf"
    assert doc["nomeArquivo"] == NOME_ARQUIVO
    assert doc["titulo"] == ctx["titulo"]
    # blobUrl canônica path-style: <endpoint>/<bucket>/<key> (endswith tolera
    # diferença de endpoint interno/externo entre tester e BFF).
    assert doc["blobUrl"].endswith(f"/{_s3_bucket()}/{blob_key}"), doc["blobUrl"]
    # Autoria: o sub do token forjado é o uuid canônico do ADMIN e2e.
    assert doc["uploadadoPor"] == fixtures.USER_IDS["ADMIN"]


# ═════════════════════════════════════════════════════════════════════════════
# Elo (b) — objeto EXISTE no MinIO (boto3 direto, sem passar pela API)
# ═════════════════════════════════════════════════════════════════════════════
def test_objeto_existe_no_minio_com_bytes_identicos(ctx):
    """head_object + get_object direto no MinIO: o blob_key da resposta aponta
    para um objeto REAL com ContentType/ContentLength/bytes exatos."""
    blob_key = ctx["doc"]["blobKey"]
    s3 = _s3_client()

    head = s3.head_object(Bucket=_s3_bucket(), Key=blob_key)
    assert head["ContentLength"] == len(ctx["pdf"])
    assert head.get("ContentType") == "application/pdf"

    corpo = s3.get_object(Bucket=_s3_bucket(), Key=blob_key)["Body"].read()
    assert corpo == ctx["pdf"], (
        "bytes no MinIO != bytes enviados (upload corrompeu/objeto errado)"
    )


# ═════════════════════════════════════════════════════════════════════════════
# Elo (c) — linha no Postgres com blob_key consistente
# ═════════════════════════════════════════════════════════════════════════════
def test_linha_no_postgres_com_blob_key_consistente(ctx):
    """SELECT direto em documentos_habilitacao: blob_key/sha256/tamanho/MIME da
    LINHA == resposta da API == bytes enviados (DB e storage apontam o mesmo)."""
    doc = ctx["doc"]
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT blob_key, sha256, tamanho_bytes, content_type, nome_arquivo, "
            "       uploadado_por::text "
            "FROM documentos_habilitacao WHERE id = %s",
            (doc["id"],),
        )
        row = cur.fetchone()

    assert row is not None, f"linha {doc['id']} não existe em documentos_habilitacao"
    blob_key, sha256, tamanho, content_type, nome_arquivo, uploadado_por = row
    assert blob_key == doc["blobKey"], (
        f"blob_key do banco ({blob_key!r}) != blobKey da API ({doc['blobKey']!r})"
    )
    assert sha256 == ctx["sha256"]
    assert tamanho == len(ctx["pdf"])
    assert content_type == "application/pdf"
    assert nome_arquivo == NOME_ARQUIVO
    assert uploadado_por == fixtures.USER_IDS["ADMIN"]


# ═════════════════════════════════════════════════════════════════════════════
# Elo (d) — download devolve bytes idênticos + content-type
# ═════════════════════════════════════════════════════════════════════════════
def test_download_devolve_bytes_identicos_e_content_type(ctx):
    """GET .../{id}/download: 200, bytes == enviados, headers do proxy corretos
    (Content-Type, Content-Length, Cache-Control e Disposition RFC 6266)."""
    doc = ctx["doc"]
    r = ctx["client"].get(f"{ROTA_DOCS}/{doc['id']}/download")

    assert r.status_code == 200, f"download → HTTP {r.status_code}: {r.text[:200]}"
    assert r.content == ctx["pdf"], "bytes do download != bytes enviados no upload"
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers.get("cache-control") == "private, no-store"
    assert r.headers.get("content-length") == str(len(ctx["pdf"]))
    # Default SEM ?inline=1 → attachment com o nome original (ASCII = fallback).
    dispo = r.headers.get("content-disposition", "")
    assert dispo.startswith("attachment"), dispo
    assert f'filename="{NOME_ARQUIVO}"' in dispo, dispo


def test_download_inline_1_serve_pdf_inline(ctx):
    """?inline=1 com MIME na whitelist segura (pdf) → Content-Disposition inline
    (réplica de buildContentDisposition / INLINE_SAFE_MIMES)."""
    doc = ctx["doc"]
    r = ctx["client"].get(f"{ROTA_DOCS}/{doc['id']}/download", params={"inline": "1"})
    assert r.status_code == 200
    assert r.headers.get("content-disposition", "").startswith("inline"), (
        r.headers.get("content-disposition")
    )
    assert r.content == ctx["pdf"]


def test_download_404_para_uuid_nao_semeado(ctx):
    """UUID válido porém inexistente → 404 {"error":"Documento não encontrado"}
    (o 404 é da LINHA do banco; objeto faltando no MinIO seria 500)."""
    r = ctx["client"].get(f"{ROTA_DOCS}/{fixtures.UUID_NAO_SEMEADO}/download")
    assert r.status_code == 404
    assert r.json() == {"error": "Documento não encontrado"}


# ═════════════════════════════════════════════════════════════════════════════
# Gates de contrato (RBAC + validação de conteúdo) — sem efeito colateral
# ═════════════════════════════════════════════════════════════════════════════
def test_upload_sem_token_retorna_401(ctx):
    """POST sem Authorization → 401 (requireAuth ANTES de qualquer parse/insert).
    Depende de ctx só p/ herdar o skip quando a stack está fora do ar."""
    base = (os.environ.get("BFF_BASE_URL") or DEFAULT_BFF_BASE).rstrip("/")
    with httpx.Client(base_url=base, timeout=TIMEOUT) as anon:
        r = anon.post(ROTA_DOCS)
    assert r.status_code == 401, f"esperado 401 sem token, veio {r.status_code}"


def test_upload_visualizador_retorna_403_permissao_negada(ctx):
    """VISUALIZADOR autenticado mas FORA de podeGerenciarDocumentosHabilitacao
    ({ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}) → 403 com a mensagem do Next.
    O gate dispara antes do multipart — nada é gravado."""
    with bff_client(role="VISUALIZADOR", timeout=TIMEOUT) as viz:
        r = viz.post(ROTA_DOCS)
    assert r.status_code == 403
    assert r.json() == {"error": "Permissão negada"}


def test_upload_rejeita_conteudo_sem_magic_bytes_pdf(ctx):
    """Arquivo .pdf cujo CONTEÚDO não é PDF/ZIP/OLE2 → 422 do validarMagicBytes,
    ANTES do PUT no MinIO e do INSERT (nenhum efeito colateral a limpar)."""
    r = ctx["client"].post(
        ROTA_DOCS,
        files={"file": ("fake.pdf", b"NAO-E-PDF-de-verdade", "application/pdf")},
        data={
            "categoria": CATEGORIA,
            "subcategoria": SUBCATEGORIA,
            "titulo": f"{MARCADOR} magic-bytes (nunca deve persistir)",
        },
    )
    assert r.status_code == 422
    assert r.json()["error"] == (
        "O conteúdo do arquivo não corresponde ao tipo declarado. "
        "Apenas PDF, XLS, XLSX, DOC e DOCX são permitidos."
    )


def test_delete_nao_admin_retorna_403(ctx):
    """DELETE por LIDER (qualquer não-ADMIN) → 403 'Somente administradores...'
    (podeExcluirDocumentoHabilitacao = isAdmin). Gate antes do 404/efeitos."""
    doc = ctx["doc"]
    with bff_client(role="LIDER", timeout=TIMEOUT) as lider:
        r = lider.delete(f"{ROTA_DOCS}/{doc['id']}")
    assert r.status_code == 403
    assert r.json() == {"error": "Somente administradores podem excluir documentos"}


# ═════════════════════════════════════════════════════════════════════════════
# Elo (e) — delete via API remove registro E blob (ÚLTIMO teste: consome o doc)
# ═════════════════════════════════════════════════════════════════════════════
def test_delete_via_api_remove_registro_e_blob(ctx):
    """DELETE /{id} como ADMIN: 200 ok → linha some do Postgres → objeto some do
    MinIO. O delete do blob é best-effort NO PRODUTO (catch engolido), então o
    assert do head_object é a ÚNICA prova de que as creds/endpoint de delete
    funcionam de verdade — por isso é assert duro, não tolerado."""
    from botocore.exceptions import ClientError

    doc = ctx["doc"]
    blob_key = doc["blobKey"]

    r = ctx["client"].delete(f"{ROTA_DOCS}/{doc['id']}")
    assert r.status_code == 200, f"DELETE → HTTP {r.status_code}: {r.text[:200]}"
    assert r.json() == {"ok": True, "message": "Documento removido com sucesso"}

    # Linha sumiu do Postgres.
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM documentos_habilitacao WHERE id = %s",
            (doc["id"],),
        )
        assert cur.fetchone()[0] == 0, "linha continua no banco após DELETE 200"

    # Blob sumiu do MinIO (head → 404/NoSuchKey).
    s3 = _s3_client()
    try:
        s3.head_object(Bucket=_s3_bucket(), Key=blob_key)
        pytest.fail(
            f"objeto {blob_key!r} AINDA existe no MinIO após o DELETE — o delete "
            "de blob (best-effort no produto) está falhando silenciosamente "
            "(creds/endpoint S3 do BFF?)"
        )
    except ClientError as exc:
        codigo = exc.response.get("Error", {}).get("Code", "")
        assert codigo in ("404", "NoSuchKey"), f"erro inesperado do MinIO: {codigo}"

    # Download do id apagado agora é 404 (linha do banco é a fonte do 404).
    r2 = ctx["client"].get(f"{ROTA_DOCS}/{doc['id']}/download")
    assert r2.status_code == 404
