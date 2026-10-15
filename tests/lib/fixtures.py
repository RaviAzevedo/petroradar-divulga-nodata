"""
Fixtures canônicas do harness on-prem (WP12 §1.2) — FONTE ÚNICA DE VERDADE.

Constantes determinísticas consumidas por TODAS as suítes (tests/e2e/*,
tests/parity/*, tests/smoke/*) e por tests/lib/auth_helpers.py. Importar
SEMPRE como::

    from tests.lib import fixtures

(PYTHONPATH=/ no container tester; ``tests`` é regular package com __init__.py.)

SINCRONIA OBRIGATÓRIA: ``tests/fixtures/seed.sql`` materializa ESTES valores no
Postgres (mesmos UUIDs, e-mails, papéis e senha — hash bcrypt gerado em SQL via
pgcrypto ``crypt(E2E_PASSWORD, gen_salt('bf', 12))``, Decisão 4). Toda alteração
aqui DEVE ser refletida lá no MESMO commit — e vice-versa. Quem semeia é o alvo
``make seed-e2e`` (psql -v ON_ERROR_STOP=1 < tests/fixtures/seed.sql).

Esquema de UUIDs fixos (v4-like, válidos p/ colunas ``uuid``):
``00000000-0000-4000-8000-<12 dígitos>``, sufixo numerando a entidade:

    users          01..07  (um por papel, na ordem de permissions.ts)
    licitações     0101 / 0102
    participação   0201
    famílias CRC   0301 / 0302
    perfil         0401
    circular       0501
    ff             reservado: uuid VÁLIDO e garantidamente NÃO-semeado

Papéis: espelham ``app/src/lib/permissions.ts`` (ROLES — 7 papéis).
"""
from __future__ import annotations

__all__ = [
    "PAPEIS", "E2E_PASSWORD", "ADMIN_EMAIL", "USERS", "USER_IDS",
    "LIC_ID", "LIC_ID_2", "LIC_NUMERO", "LIC_NUMERO_2",
    "PART_ID", "FAM_ID", "FAM_ID_2", "FAM_CODIGO_CRC", "FAM_CODIGO_CRC_2",
    "PERFIL_ID", "CIRCULAR_ID", "UUID_NAO_SEMEADO", "CNPJ_CONCORRENTE",
    "uuid_fixo",
]


def uuid_fixo(sufixo: int) -> str:
    """UUID determinístico do padrão do seed: 00000000-0000-4000-8000-<12 díg>."""
    return f"00000000-0000-4000-8000-{sufixo:012d}"


# ── Papéis (ordem espelha app/src/lib/permissions.ts::ROLES) ─────────────────
PAPEIS: tuple[str, ...] = (
    "ADMIN", "LIDER", "ORCAMENTISTA", "TECNICO", "SGI", "VISUALIZADOR", "EXTERNO",
)

# Senha ÚNICA de e2e p/ todos os papéis (NUNCA usar em produção).
E2E_PASSWORD = "E2e!PetroRadar2026"

# papel → e-mail ("<papel-minúsculo>.e2e@example.invalid")
#
# DOMÍNIO `.invalid` (RFC 2606), NUNCA `example.com` — 2026-07-13.
# Estas caixas não existem no Exchange, mas os crons resolvem destinatário por
# PAPEL e o transporte Graph envia de verdade (pela caixa de produção
# no-reply@example.com). Com o domínio real, um `make test-seed`
# fazia o cron de prazos disparar e-mail para 7 endereços inexistentes @proponente
# → bounce em cima da caixa remetente de produção. `.invalid` é reservado por
# RFC e garantidamente não-resolvível: mesmo semeado, nada sai para ninguém.
#
# O login por senha NÃO valida domínio (auth.ts::signIn só barra domínio no
# provider microsoft-entra-id; Credentials retorna `true` antes disso), então
# `.invalid` não afeta a autenticação das suítes.
USERS: dict[str, str] = {
    "ADMIN":        "admin.e2e@example.invalid",
    "LIDER":        "lider.e2e@example.invalid",
    "ORCAMENTISTA": "orcamentista.e2e@example.invalid",
    "TECNICO":      "tecnico.e2e@example.invalid",
    "SGI":          "sgi.e2e@example.invalid",
    "VISUALIZADOR": "visualizador.e2e@example.invalid",
    "EXTERNO":      "externo.e2e@example.invalid",
}

ADMIN_EMAIL = USERS["ADMIN"]

# papel → uuid (users 01..07, mesma ordem de PAPEIS)
USER_IDS: dict[str, str] = {
    "ADMIN":        uuid_fixo(1),   # ...000000000001
    "LIDER":        uuid_fixo(2),   # ...000000000002
    "ORCAMENTISTA": uuid_fixo(3),   # ...000000000003
    "TECNICO":      uuid_fixo(4),   # ...000000000004
    "SGI":          uuid_fixo(5),   # ...000000000005
    "VISUALIZADOR": uuid_fixo(6),   # ...000000000006
    "EXTERNO":      uuid_fixo(7),   # ...000000000007
}

# ── Licitações-âncora ────────────────────────────────────────────────────────
# 0101: recebendo propostas (futuro), com circular e participação vinculadas.
# 0102: concluída (passado) — busca/resultados/histórico.
LIC_ID       = uuid_fixo(101)   # ...000000000101
LIC_ID_2     = uuid_fixo(102)   # ...000000000102
LIC_NUMERO   = "7004990101"     # formato Petronect (10 dígitos); casa o regex de /api/resultados/[id]
LIC_NUMERO_2 = "7004990102"

# ── Participação (FK licitacao_petro_radar_id → LIC_ID) ─────────────────────
PART_ID = uuid_fixo(201)        # ...000000000201

# ── Famílias CRC (cofre/gap-habilitação) ─────────────────────────────────────
# Códigos FICTÍCIOS (faixa 9999xxxx): familias.codigo_crc tem UNIQUE real no
# schema e o seed roda também sobre banco RESTAURADO de dump de produção — um
# código CRC verdadeiro da Proponente existiria
# lá com OUTRO uuid e a unique_violation (não coberta pelo ON CONFLICT (id))
# abortaria o seed inteiro sob ON_ERROR_STOP=1. NUNCA usar códigos reais aqui.
FAM_ID            = uuid_fixo(301)  # ...000000000301
FAM_ID_2          = uuid_fixo(302)  # ...000000000302
FAM_CODIGO_CRC    = "99990066"      # fictício — eng. de processo (âncora match)
FAM_CODIGO_CRC_2  = "99990070"      # fictício — montagem eletromecânica (renovação)

# ── Perfil de interesse (reclassify / cron oportunidades-novas) ──────────────
PERFIL_ID = uuid_fixo(401)      # ...000000000401

# ── Circular (ligada a LIC_ID; crons circulares-watch / notificações) ────────
CIRCULAR_ID = uuid_fixo(501)    # ...000000000501

# ── Sentinelas p/ rotas cujo recurso NÃO é semeado ───────────────────────────
# uuid VÁLIDO (não estoura 22P02 em coluna uuid) e ausente do seed → a rota
# autorizada responde 404, nunca 400/500 por cast.
UUID_NAO_SEMEADO = "00000000-0000-4000-8000-0000000000ff"

# CNPJ formato válido (Petrobras matriz, dígitos puros) p/ placeholders [cnpj]
# do inventário de rotas — o dado pode não existir on-prem.
CNPJ_CONCORRENTE = "33000167000101"
