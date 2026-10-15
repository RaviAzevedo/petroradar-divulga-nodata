"""
Utilitarios de banco compartilhados pelos jobs de coleta do worker.

Conexao psycopg2 (RealDictCursor), leitura dos perfis de interesse, registro
em ``sync_log`` e o motor de classificacao compartilhado (``/shared``).
"""

from __future__ import annotations

import json
import os
import sys as _sys

import psycopg2
import psycopg2.extras

if "/shared" not in _sys.path:
    _sys.path.insert(0, "/shared")

from classificacao import classificar_licitacao as classificar_licitacao_db  # noqa: E402,F401


def get_db_conn():
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        # RuntimeError (nao sys.exit): este modulo roda DENTRO de task Celery —
        # sys.exit(1) derrubaria o processo do worker e, com acks_late +
        # reject_on_worker_lost, a task seria re-entregue em loop (poison-pill).
        raise RuntimeError("DATABASE_URL não definida — configure a env antes de rodar o job")
    conn = psycopg2.connect(
        db_url,
        cursor_factory=psycopg2.extras.RealDictCursor,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
    )
    conn.autocommit = False
    return conn


def carregar_perfis(conn) -> list:
    with conn.cursor() as cur:
        cur.execute("SELECT id, nome, ativo, filtros FROM perfis_interesse WHERE ativo = true")
        rows = cur.fetchall()
    perfis = []
    for row in rows:
        p = dict(row)
        if isinstance(p["filtros"], str):
            # Um perfil com JSON malformado nao pode abortar o job inteiro —
            # loga e pula so esse perfil.
            try:
                p["filtros"] = json.loads(p["filtros"])
            except (ValueError, TypeError) as e:
                print(f"[PERFIS] Perfil {p.get('id')} ({p.get('nome')}) com filtros inválidos — pulando: {e}")
                continue
        perfis.append(p)
    return perfis


def registrar_sync_log(conn, tipo: str, total: int, novas: int, atualizadas: int, erros: int, detalhes: str):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO sync_log (tipo, total_encontradas, novas, atualizadas, erros, detalhes, executado_em)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
        """, (tipo, total, novas, atualizadas, erros, detalhes))
    conn.commit()
