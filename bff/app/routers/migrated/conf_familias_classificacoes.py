"""PATCH /api/conformidade/familias/classificacoes/{id} — revisa UM indício.

ESPELHO de app/src/app/api/conformidade/familias/classificacoes/[id]/route.ts.

⚠️ ESTE É O LADO QUE ATENDE PRODUÇÃO. O NGINX manda todo ``/api/`` para o BFF e
este path não está entre as exceções — sem este arquivo o botão de revisão da
tela recebe 404.

POR QUE ELA EXISTE
──────────────────
A classificação grava centenas de indícios por carga. Nenhum vira prova sozinho:
por decisão da migração 0041, prova é ``documentos_familias``, e lá só se entra
pela mão de uma pessoa. Até esta rota existir, ``revisao`` estava NULL em todas
as linhas — a fila era só de leitura, e o mapa não tinha como sair de "com
indício" para "com prova" em família nenhuma.

O QUE CADA DECISÃO FAZ
──────────────────────
  CONFIRMADA  cria o vínculo em ``documentos_familias`` e aponta ``vinculo_id``.
              É o único caminho de indício → prova. Se a família NÃO está
              cadastrada não há a que vincular (a FK exige ``familias.id``): a
              revisão fica gravada e a resposta diz ``viraProva: false`` — o
              indício confirmado passa a ser o ARGUMENTO do pedido de CRC.
  PARCIAL     sustenta em parte. Não cria vínculo — meia prova não habilita.
  REJEITADA   não sustenta. PERSISTE (não some): representar o "não" por ausência
              de linha faria a próxima carga ressuscitar a sugestão.
  null        devolve o indício para a fila (desfaz um clique errado).

REJEITAR NÃO APAGA VÍNCULO. Se já havia prova vinculada, ela fica e a resposta
devolve ``vinculoMantido: true``: o vínculo pode ter sido criado à mão, no cofre,
por outra pessoa e por outra razão. Apagar não é reversível; deixar é.

Guard: ``is_conformidade`` — mesmo ``podeGerenciarFamilias`` do Next.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import is_conformidade
from app.routers.migrated._pii import redigir_pii
from app.services.audit import registrar_audit

router = APIRouter()

_RE_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
_REVISOES = ("CONFIRMADA", "REJEITADA", "PARCIAL")

_OBS_PADRAO = "Confirmado a partir de indício da classificação do acervo"


def _js(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat().replace("+00:00", "Z")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v


def _not_found() -> JSONResponse:
    return JSONResponse({"error": "Indício não encontrado"}, status_code=404)


@router.patch("/api/conformidade/familias/classificacoes/{id}")
async def revisar_indicio(id: str, request: Request) -> JSONResponse:
    # Import tardio: espelha o guard manual do Next (requireConformidade) sem
    # amarrar este módulo à ordem de import dos outros routers migrados.
    from app.db.session import SessionLocal
    from app.routers.migrated.conf_familias_id import _usuario_ou_401

    user, resp401 = await _usuario_ou_401(request)
    if resp401 is not None:
        return resp401
    assert user is not None

    if not is_conformidade(user.role):
        return JSONResponse({"error": "Permissão negada"}, status_code=403)

    if not _RE_UUID.match(id or ""):
        return _not_found()

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — qualquer falha de parse = JSON inválido
        return JSONResponse({"code": "VALIDACAO", "error": "JSON inválido"}, status_code=422)

    campos: dict[str, list[str]] = {}
    if not isinstance(body, dict):
        campos["revisao"] = ["obrigatório"]
        body = {}

    revisao = body.get("revisao", "__ausente__")
    if revisao == "__ausente__":
        campos.setdefault("revisao", []).append("obrigatório")
        revisao = None
    elif revisao is not None and revisao not in _REVISOES:
        campos.setdefault("revisao", []).append("inválido")

    motivo_bruto = body.get("motivo")
    if motivo_bruto is not None and not isinstance(motivo_bruto, str):
        campos.setdefault("motivo", []).append("inválido")
    elif isinstance(motivo_bruto, str) and len(motivo_bruto.strip()) > 2000:
        campos.setdefault("motivo", []).append("máximo 2000 caracteres")

    if campos:
        return JSONResponse(
            {"code": "VALIDACAO", "error": "Revisão inválida", "campos": campos},
            status_code=422,
        )

    motivo = (motivo_bruto or "").strip() or None

    async with SessionLocal() as db:
        try:
            # FOR UPDATE: duas pessoas revisando o mesmo indício ao mesmo tempo
            # criariam dois vínculos para o mesmo par — o índice único barraria o
            # segundo com 23505, um 500 em vez de uma segunda decisão coerente.
            atual = (
                await db.execute(
                    text(
                        "SELECT fc.id, fc.documento_id, fc.familia_codigo, fc.veredito, "
                        "       fc.revisao, fc.vinculo_id, d.restrito "
                        "  FROM familias_classificacoes fc "
                        "  JOIN documentos_habilitacao d ON d.id = fc.documento_id "
                        " WHERE fc.id = CAST(:id AS uuid) "
                        " FOR UPDATE OF fc"
                    ),
                    {"id": id},
                )
            ).first()
            if atual is None:
                await db.rollback()
                return _not_found()

            codigo = str(atual.familia_codigo)
            documento_id = str(atual.documento_id)
            revisao_antes = None if atual.revisao is None else str(atual.revisao)
            vinculo_antes = None if atual.vinculo_id is None else str(atual.vinculo_id)

            # f_codigo_crc dos dois lados: o indício grava o código já normalizado
            # e o cadastro grava com o padding do SAP — comparar cru erraria em
            # toda família com zero à esquerda.
            fam = (
                await db.execute(
                    text(
                        "SELECT id FROM familias "
                        " WHERE deletado_em IS NULL AND f_codigo_crc(codigo_crc) = :cod "
                        " LIMIT 1"
                    ),
                    {"cod": codigo},
                )
            ).first()
            familia_id = str(fam.id) if fam else None

            vinculo_id = vinculo_antes
            vinculo_mantido = False

            if revisao == "CONFIRMADA" and familia_id:
                # ON CONFLICT: o par pode já estar vinculado à mão pelo cofre. A
                # confirmação então ADOTA o vínculo existente — criar outro é
                # impossível (índice único) e falhar seria absurdo, já que o
                # estado desejado é exatamente o que está lá.
                v = (
                    await db.execute(
                        text(
                            "WITH novo AS ( "
                            "  INSERT INTO documentos_familias (documento_id, familia_id, observacao) "
                            "  VALUES (CAST(:doc AS uuid), CAST(:fam AS uuid), CAST(:obs AS text)) "
                            "  ON CONFLICT (documento_id, familia_id) DO NOTHING "
                            "  RETURNING id) "
                            "SELECT id FROM novo "
                            "UNION ALL "
                            "SELECT id FROM documentos_familias "
                            " WHERE documento_id = CAST(:doc AS uuid) "
                            "   AND familia_id = CAST(:fam AS uuid) "
                            "LIMIT 1"
                        ),
                        {"doc": documento_id, "fam": familia_id, "obs": motivo or _OBS_PADRAO},
                    )
                ).first()
                vinculo_id = str(v.id) if v else None
            elif revisao != "CONFIRMADA":
                # Solta o ponteiro, preserva a linha de prova. Ver cabeçalho.
                if vinculo_antes:
                    vinculo_mantido = True
                vinculo_id = None

            linha = (
                await db.execute(
                    text(
                        # CAST explícito em TODO parâmetro anulável, e um
                        # :tem_revisao próprio em vez de reusar :revisao dentro
                        # do CASE. O asyncpg PREPARA o statement antes de ver o
                        # valor: um mesmo $1 servindo de valor de coluna e de
                        # operando de IS NULL não tem tipo inferível, e o banco
                        # responde AmbiguousParameterError em TODA chamada — não
                        # só nas de valor nulo. O lado Next não tem o problema
                        # porque lá o now()/NULL entra como fragmento literal,
                        # não como parâmetro; é o tipo de divergência que só
                        # aparece exercitando o BFF, que é quem atende produção.
                        "UPDATE familias_classificacoes "
                        "   SET revisao        = CAST(:revisao AS text), "
                        "       revisado_por   = CAST(:revisor AS uuid), "
                        "       revisado_em    = CASE WHEN CAST(:tem_revisao AS boolean) "
                        "                             THEN now() ELSE NULL END, "
                        "       motivo_revisao = CAST(:motivo AS text), "
                        "       vinculo_id     = CAST(:vinculo AS uuid) "
                        " WHERE id = CAST(:id AS uuid) "
                        "RETURNING id, familia_codigo, documento_id, veredito, confianca, "
                        "          justificativa, revisao, revisado_em, motivo_revisao, vinculo_id"
                    ),
                    {
                        "id": id,
                        "revisao": revisao,
                        "tem_revisao": revisao is not None,
                        "revisor": user.id if revisao else None,
                        "motivo": motivo,
                        "vinculo": vinculo_id,
                    },
                )
            ).first()

            await registrar_audit(
                db,
                user_id=user.id,
                acao="REVISAR_INDICIO_FAMILIA",
                entidade="familia_classificacao",
                entidade_id=id,
                detalhes={
                    "familiaCodigo": codigo,
                    "documentoId": documento_id,
                    "veredito": str(atual.veredito),
                    "antes": {"revisao": revisao_antes, "vinculoId": vinculo_antes},
                    "depois": {"revisao": revisao, "vinculoId": vinculo_id},
                    "familiaCadastrada": bool(familia_id),
                    "motivo": motivo,
                },
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    indicio = None
    if linha is not None:
        indicio = {
            "id": str(linha.id),
            "familia_codigo": linha.familia_codigo,
            "documento_id": str(linha.documento_id),
            "veredito": linha.veredito,
            "confianca": None if linha.confianca is None else float(linha.confianca),
            "justificativa": redigir_pii(linha.justificativa),
            "revisao": linha.revisao,
            "revisado_em": _js(linha.revisado_em),
            "motivo_revisao": linha.motivo_revisao,
            "vinculo_id": None if linha.vinculo_id is None else str(linha.vinculo_id),
        }

    return JSONResponse(
        json.loads(
            json.dumps(
                {
                    "status": 200,
                    "indicio": indicio,
                    "familiaCadastrada": bool(familia_id),
                    # A distinção que a tela precisa dizer em voz alta: confirmar
                    # um indício de família NÃO cadastrada não gera prova — gera
                    # argumento para pedir o CRC. Sem isto a pessoa confirma vários
                    # indícios e acha que habilitou.
                    "viraProva": revisao == "CONFIRMADA" and bool(familia_id),
                    "vinculoMantido": vinculo_mantido,
                },
                default=str,
            )
        )
    )
