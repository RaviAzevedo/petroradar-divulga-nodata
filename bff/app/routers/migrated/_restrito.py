"""Predicado restrito + espelho 0035 — homônimos de ``cofre/queries.ts`` (§3.2).

Helpers compartilhados pelas rotas do cofre/dossiê (02-APIS §0.6-a/b). O prefixo
``_`` é de propósito: ``include_migrated`` ignora módulos com esse prefixo ao
descobrir routers — isto NÃO é uma rota.

Regra única do ``restrito`` (00-ARQUITETURA §3.2): documento com
``restrito = true`` só é visível para Conformidade (ADMIN/LIDER/SGI) — em TODAS
as superfícies de leitura do cofre (lista, busca, dossiê, ZIP; o ``verificar``
não filtra a linha, oculta o metadado). O espelho 0035
(``audit_download_restrito``) grava TODO download de documento restrito FORA do
expurgo de 12 meses do ``audit_log`` (P7/D-7): a linha é prova, não
relacionamento — sobrevive ao DELETE do usuário e do documento.
"""

from __future__ import annotations

from sqlalchemy import text

# Espelho de ``ROLES_CONFORMIDADE`` (permissions.ts / security.py) — cópia local
# no padrão dos irmãos migrados, para o predicado não depender de import de rota.
ROLES_CONFORMIDADE = ("ADMIN", "LIDER", "SGI")


def is_conformidade(role: str) -> bool:
    """``isConformidade(role)`` — ADMIN, LIDER, SGI."""
    return role in ROLES_CONFORMIDADE


def restricao_visivel_sql(alias: str = "d") -> str:
    """Fragmento WHERE do predicado restrito (homônimo de ``restricaoVisivel``).

    O chamador SEMPRE binda ``:is_conformidade`` (bool). Para Conformidade o
    fragmento é sempre verdadeiro; para os demais papéis só passa a linha com
    ``restrito = false`` — contagens e ``total`` acompanham (não denunciam o
    oculto).
    """
    return f"({alias}.restrito = false OR :is_conformidade)"


async def registrar_download_restrito(
    db,
    *,
    documento_id: str,
    titulo: str,
    operacao_codigo: str | None,
    user_id: str,
    user_email: str | None,
    role: str,
    via: str,
) -> None:
    """P7: espelha o download de documento restrito em ``audit_download_restrito``.

    NÃO commita — o commit é do handler, na mesma sessão da escrita principal
    (mania 0.3-7). Nas rotas de STREAM sem transação, o chamador executa esta
    função e commita ANTES de servir o corpo, em try/except com log (falha loga
    e o download segue — mesma política do audit LGPD de download).

    ``via`` ∈ {'DOWNLOAD','ZIP_DOSSIE','ZIP_SELECAO','DOWNLOAD_ANEXO'} — a
    coluna é ``text`` sem CHECK (0035), então o valor novo de anexo é
    compatível (00-ARQ §1.4 / 02-APIS §16-B.1). Proibido aqui (§0.4): IP e
    user-agent NÃO entram — quem precisar cruza com o ``audit_log`` na janela
    de 12 meses.
    """
    await db.execute(
        text(
            """
            INSERT INTO audit_download_restrito
              (documento_id, titulo, operacao_codigo, user_id, user_email, role, via)
            VALUES
              (CAST(:documento_id AS uuid), :titulo, :operacao_codigo,
               CAST(:user_id AS uuid), :user_email, :role, :via)
            """
        ),
        {
            "documento_id": documento_id,
            "titulo": titulo,
            "operacao_codigo": operacao_codigo,
            "user_id": user_id,
            # user_email é NOT NULL na 0035; o claim pode vir sem e-mail em token
            # de teste — string vazia preserva a linha sem inventar identidade.
            "user_email": user_email or "",
            "role": role,
            "via": via,
        },
    )
