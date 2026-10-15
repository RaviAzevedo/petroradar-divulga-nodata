"""
WP12 G4 — migrate_check: prova que o schema on-prem está migrado e íntegro.

Roda DENTRO do container `tester` (perfil "tests"), com psycopg + DATABASE_URL do
.env.onprem. NÃO depende do diretório do app (o tester não monta app/src) — o nº
esperado de migrations é uma CONSTANTE auditável abaixo.

Checagens (gate G4 do go_no_go.py — Decisão 1 / migration 0015):
  1. journal do drizzle: conta as migrations APLICADAS (tabela __drizzle_migrations,
     normalmente no schema "drizzle"; descoberta dinâmica via information_schema
     para tolerar migrationsSchema customizado) e exige >= MIN_MIGRATIONS;
  2. extensões `vector` e `pgcrypto` instaladas (scripts/parity/00_check_extensions.sql);
  3. acervo_chunks.embedding com atttypmod == 1024 (pgvector guarda a DIMENSÃO
     direto no typmod — vector(1024) => atttypmod 1024);
  4. counts vs golden: se tests/_artifacts/origin_counts.csv existir (capturado por
     deploy/snapshot-prod.sh na ORIGEM; linhas "tabela,linhas"), compara o count
     real de cada tabela via SQL — excluindo as DERIVADAS reconstruídas no on-prem
     (acervo_chunks/acervo_index_log re-embed; consultas_certidoes anonimizada —
     mesma exclusão do `make parity-diff`). Sem golden => counts_match=null.

Saída: tests/_artifacts/migrate_check.json (CONTRATO CANÔNICO do G4):
  {"ok": bool, "embedding_dim": int, "migrations_aplicadas": int,
   "extensoes": [str], "counts_match": bool|null, "detalhe": str}

Exit 0 se ok, 1 caso contrário. Uso: python tests/migrate_check.py
"""
from __future__ import annotations

import csv
import json
import os
import pathlib
import sys

import psycopg

# Nº MÍNIMO de migrations esperadas no journal: 0000..0015 do app (app/src/db/
# migrations tem 16 arquivos .sql em 2026-06-10). O tester NÃO enxerga o app no
# container, então o valor é encodado aqui — ao criar a 0016+, suba a constante.
MIN_MIGRATIONS = 17  # 0000..0016 (0016 = mascaramento de PII LGPD, auditoria 02/07)

# Mesma lista de exclusão do `make parity-diff` (WP02 §9.3): tabelas DERIVADAS,
# reconstruídas no on-prem (re-embed/anonimização) — count diferente é esperado.
TABELAS_DERIVADAS = {"acervo_chunks", "acervo_index_log", "consultas_certidoes"}

ART = pathlib.Path(os.environ.get("GNG_ARTIFACTS", str(pathlib.Path(__file__).resolve().parent / "_artifacts")))
ART.mkdir(parents=True, exist_ok=True)


def _one(cur, sql: str, params=()) -> object:
    cur.execute(sql, params)
    row = cur.fetchone()
    return row[0] if row else None


def _migrations_aplicadas(cur) -> tuple[int, str]:
    """Conta entradas no journal do drizzle. A tabela padrão do drizzle-kit é
    __drizzle_migrations (schema "drizzle" no driver pg); procura em qualquer
    schema para tolerar configuração customizada de migrationsSchema/Table."""
    cur.execute(
        """
        SELECT table_schema, table_name
          FROM information_schema.tables
         WHERE table_name ILIKE '%drizzle%migrations%'
         ORDER BY (table_schema = 'drizzle') DESC
         LIMIT 1
        """
    )
    row = cur.fetchone()
    if not row:
        return 0, "journal do drizzle NÃO encontrado (make migrate rodou?)"
    schema, tabela = row
    n = _one(cur, f'SELECT count(*) FROM "{schema}"."{tabela}"')
    return int(n or 0), f'journal {schema}.{tabela}: {n} migration(s)'


def _extensoes(cur) -> list[str]:
    cur.execute("SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto') ORDER BY extname")
    return [r[0] for r in cur.fetchall()]


def _embedding_dim(cur) -> int:
    """pgvector guarda a dimensão diretamente em atttypmod (sem o offset +4 do
    varchar): acervo_chunks.embedding vector(1024) => atttypmod == 1024."""
    dim = _one(
        cur,
        """
        SELECT a.atttypmod
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'acervo_chunks'
           AND a.attname = 'embedding' AND NOT a.attisdropped
        """,
    )
    return int(dim or 0)


def _counts_match(cur) -> tuple[bool | None, str]:
    """Compara counts reais vs golden origin_counts.csv (se existir em _artifacts)."""
    golden = ART / "origin_counts.csv"
    if not golden.exists():
        return None, "sem golden origin_counts.csv em _artifacts (counts_match=null)"
    esperado: dict[str, int] = {}
    for row in csv.reader(golden.read_text().splitlines()):
        if not row or row[0].lstrip().startswith("#") or row[0] in ("tabela", "table"):
            continue
        if len(row) >= 2 and row[1].strip().isdigit():
            esperado[row[0].strip()] = int(row[1])
    divergentes: list[str] = []
    for tabela, linhas in esperado.items():
        if tabela in TABELAS_DERIVADAS:
            continue
        # Confirma que a tabela existe antes do count (golden pode ter tabela a mais).
        existe = _one(
            cur,
            "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=%s",
            (tabela,),
        )
        if not existe:
            divergentes.append(f"{tabela}: AUSENTE no on-prem (origem={linhas})")
            continue
        real = int(_one(cur, f'SELECT count(*) FROM "{tabela}"') or 0)
        if real != linhas:
            divergentes.append(f"{tabela}: origem={linhas} on-prem={real}")
    if divergentes:
        return False, "counts divergentes: " + "; ".join(divergentes[:10])
    return True, f"counts batem com o golden ({len(esperado)} tabelas, derivadas excluídas)"


def run() -> dict:
    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        out = {
            "ok": False, "embedding_dim": 0, "migrations_aplicadas": 0,
            "extensoes": [], "counts_match": None,
            "detalhe": "DATABASE_URL ausente no ambiente do tester",
        }
        (ART / "migrate_check.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
        return out

    detalhes: list[str] = []
    with psycopg.connect(dsn, connect_timeout=15) as conn, conn.cursor() as cur:
        migrations, det_mig = _migrations_aplicadas(cur)
        detalhes.append(det_mig)
        extensoes = _extensoes(cur)
        dim = _embedding_dim(cur)
        counts_match, det_counts = _counts_match(cur)
        detalhes.append(det_counts)

    falhas: list[str] = []
    if migrations < MIN_MIGRATIONS:
        falhas.append(f"{migrations} migrations no journal (< {MIN_MIGRATIONS} = 0000..0015)")
    if "vector" not in extensoes:
        falhas.append("extensão vector AUSENTE")
    if "pgcrypto" not in extensoes:
        falhas.append("extensão pgcrypto AUSENTE")
    if dim != 1024:
        falhas.append(f"acervo_chunks.embedding atttypmod={dim} (esperado 1024 — migration 0015)")
    if counts_match is False:
        falhas.append("counts != golden origin_counts.csv")

    ok = not falhas
    out = {
        "ok": ok,
        "embedding_dim": dim,
        "migrations_aplicadas": migrations,
        "extensoes": extensoes,
        "counts_match": counts_match,
        "detalhe": "; ".join(falhas) if falhas else "; ".join(detalhes),
    }
    (ART / "migrate_check.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    return out


if __name__ == "__main__":
    try:
        resultado = run()
    except psycopg.Error as exc:
        resultado = {
            "ok": False, "embedding_dim": 0, "migrations_aplicadas": 0,
            "extensoes": [], "counts_match": None,
            "detalhe": f"erro de conexão/SQL: {exc}",
        }
        (ART / "migrate_check.json").write_text(json.dumps(resultado, indent=2, ensure_ascii=False))
    print(json.dumps(resultado, ensure_ascii=False))
    sys.exit(0 if resultado["ok"] else 1)
