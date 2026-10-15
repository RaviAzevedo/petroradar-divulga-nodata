"""
0034 — Guards RBAC das rotas NOVAS/ALTERADAS da reestruturação do acervo,
in-process (sem stack). Espelha o bloco 0034 de ``tests/parity/route_inventory.csv``.

Por que este arquivo existe: as três rotas que nascem no WP-05/WP-09
(vincular-operacao, import/jobs, import/jobs/[id]/desfazer) e as duas que TROCAM
de guard no WP-04 (GET /operacoes vira requireConformidade — P10 — e o PATCH de
operação nasce requireConformidade) entram no inventário de paridade, mas o
``test_route_inventory.py`` só roda contra um alvo HTTP de pé. Sem isto, a ordem
401-antes-de-403, o shape do corpo de erro e a assimetria com/sem ``code`` só
apareceriam em runtime no Gate 2.

Contrato verificado (espelha o Next, byte a byte):
  sem token → 401 {"error": <msg>, "code": "UNAUTHENTICATED"}          (todas)
  guard "conformidade" (requireConformidade — LANÇA via handleApiError):
      VISUALIZADOR/ORCAMENTISTA → 403 {"error":"Apenas Conformidade","code":"FORBIDDEN"}
  guard "admin" (requireAdmin — LANÇA):
      SGI → 403 {"error":"Apenas administrador","code":"FORBIDDEN"}
  guard "manual" (requireAuth + podeGerenciarDocumentosHabilitacao INLINE):
      VISUALIZADOR/EXTERNO → 403 {"error":"Permissão negada"} — SEM ``code``

ASSIMETRIA DE PROPÓSITO (mesma do docstring de test_operacoes_guards.py): guard
que LANÇA sai com ``code``; checagem inline de papel devolve o corpo cru, sem
``code``. Ninguém "uniformiza" um lado só — a paridade Next×BFF compara os dois.

0043 (onda 4) — a SEGUNDA metade deste arquivo cobre as quatro respostas que
mudaram nos DOIS lados (spec ONDA-4 §5.8): os filtros ``disciplinaId`` e
``profissionalId`` do cofre, a chave ``disciplina`` por documento (presente e
``null``) e ``disciplinas`` como ARRAY em R1 e R3. Ali não há guard a exercitar —
o que se prova é o SQL e a serialização, lidos do próprio módulo do BFF, sem
banco: é onde a paridade com o Next quebraria em silêncio.

ORDEM DE ENTREGA (aviso ao integrador):
  1. Enquanto os routers 0034 não existirem no BFF (``conf_cofre_doc_vincular_
     operacao.py``, ``conf_import_jobs.py``, ``conf_import_jobs_id_desfazer.py``
     e o PATCH em ``conf_operacoes_id.py``), estes testes acusam 404/405 — é o
     aceite pendente do WP correspondente, não defeito do teste.
  2. Com o P10 aplicado, a tupla ``("GET", "/api/conformidade/operacoes", False)``
     de ``ROTAS_OPERACAO`` em ``test_operacoes_guards.py`` PRECISA SAIR
     (02-APIS §18.1) — aquela linha espera o guard antigo (requireVisualizar) e
     passa a falhar com razão. A edição pertence ao WP-04 (fora dos arquivos
     desta frente de paridade).

Os guards levantam ANTES de qualquer I/O, então nenhum teste aqui toca banco.
"""
from __future__ import annotations

import pytest

from tests.conftest import auth_headers

# UUID sintaticamente válido (o guard roda antes de qualquer lookup — o id só
# precisa casar o formato da rota dinâmica, nunca existir no banco).
UUID_SONDA = "11111111-1111-4111-8111-111111111111"

# (método, rota, guard) — guard ∈ {"conformidade", "admin", "manual"}.
# É a matriz do 02-APIS §18.1, em forma executável.
ROTAS_ACERVO = [
    ("GET", "/api/conformidade/operacoes", "conformidade"),  # R1/P10
    ("PATCH", f"/api/conformidade/operacoes/{UUID_SONDA}", "conformidade"),  # R4
    ("POST", "/api/conformidade/cofre/documentos/vincular-operacao", "manual"),  # R11
    ("GET", "/api/conformidade/import/jobs", "conformidade"),  # R14
    ("POST", f"/api/conformidade/import/jobs/{UUID_SONDA}/desfazer", "admin"),  # R15
]

CORPO_403 = {
    "conformidade": {"error": "Apenas Conformidade", "code": "FORBIDDEN"},
    "admin": {"error": "Apenas administrador", "code": "FORBIDDEN"},
    # inline: objeto de UMA chave, sem ``code`` (NextResponse.json cru).
    "manual": {"error": "Permissão negada"},
}


@pytest.fixture
def token_orcamentista(jwt_factory):
    """ORCAMENTISTA: gerencia documentos, mas NÃO é Conformidade (barra no P10)."""
    return jwt_factory(role="ORCAMENTISTA", sub="user-orc-0004")


@pytest.fixture
def token_sgi(jwt_factory):
    """SGI: é Conformidade (passa no requireConformidade), mas NÃO é ADMIN."""
    return jwt_factory(role="SGI", sub="user-sgi-0005")


async def _chamar(client, metodo: str, rota: str, headers=None):
    if metodo == "GET":
        return await client.get(rota, headers=headers)
    if metodo == "PATCH":
        return await client.patch(rota, json={}, headers=headers)
    return await client.post(rota, json={}, headers=headers)


@pytest.mark.parametrize("metodo,rota,_guard", ROTAS_ACERVO)
async def test_sem_token_da_401(client, metodo, rota, _guard):
    r = await _chamar(client, metodo, rota)
    assert r.status_code == 401, f"{metodo} {rota}: esperado 401 sem token, veio {r.status_code}"
    corpo = r.json()
    assert corpo.get("code") == "UNAUTHENTICATED"
    assert corpo.get("error")


@pytest.mark.parametrize(
    "metodo,rota",
    [(m, r) for m, r, g in ROTAS_ACERVO if g == "conformidade"],
)
@pytest.mark.parametrize("papel_fixture", ["token_visualizador", "token_orcamentista"])
async def test_conformidade_barra_papel(client, request, papel_fixture, metodo, rota):
    """requireConformidade barra VISUALIZADOR **e** ORCAMENTISTA — é o P10.

    O ORCAMENTISTA é o caso que dói: ele gerencia documento (POST do cofre) mas
    perde o catálogo de operações no GET — consequência declarada e aceita
    (02-APIS §1.1); o front trata no WP-13.
    """
    token = request.getfixturevalue(papel_fixture)
    r = await _chamar(client, metodo, rota, auth_headers(token))
    assert r.status_code == 403, (
        f"{metodo} {rota}: {papel_fixture} deveria tomar 403, veio {r.status_code}"
    )
    assert r.json() == CORPO_403["conformidade"], (
        "guard que LANÇA sai com `code` e a mensagem EXATA do require_conformidade"
    )


async def test_admin_barra_sgi(client, token_sgi):
    """SGI lista jobs (R14) mas NÃO desfaz (R15) — matriz RBAC §3.1 da arquitetura."""
    metodo, rota = "POST", f"/api/conformidade/import/jobs/{UUID_SONDA}/desfazer"
    r = await _chamar(client, metodo, rota, auth_headers(token_sgi))
    assert r.status_code == 403, f"SGI deveria tomar 403 no desfazer, veio {r.status_code}"
    assert r.json() == CORPO_403["admin"]


@pytest.mark.parametrize("papel_fixture", ["token_visualizador", "token_externo"])
async def test_manual_403_sem_code(client, request, papel_fixture):
    """Checagem inline (podeGerenciarDocumentosHabilitacao): corpo cru, SEM `code`.

    VISUALIZADOR autentica e para no papel; EXTERNO idem — os dois recebem o
    MESMO corpo de uma chave (paridade com o NextResponse.json do Next).
    """
    token = request.getfixturevalue(papel_fixture)
    r = await _chamar(
        client,
        "POST",
        "/api/conformidade/cofre/documentos/vincular-operacao",
        auth_headers(token),
    )
    assert r.status_code == 403, (
        f"{papel_fixture} deveria tomar 403 no vincular-operacao, veio {r.status_code}"
    )
    corpo = r.json()
    assert corpo == CORPO_403["manual"]
    assert "code" not in corpo, "POST faz checagem inline: corpo sem `code` (paridade com o Next)"


@pytest.mark.parametrize("metodo,rota,_guard", ROTAS_ACERVO)
async def test_401_vem_antes_de_403(client, metodo, rota, _guard):
    """Token inválido é 401 em TODAS as rotas novas — mesmo nas que o papel barraria.

    Réplica do contrato travado em test_operacoes_guards.py:88-96: se a
    autorização rodasse antes da autenticação, um token vencido levaria 403 e o
    front trataria como "sem permissão" em vez de mandar relogar.
    """
    r = await _chamar(client, metodo, rota, {"Authorization": "Bearer lixo.nao.e.jwt"})
    assert r.status_code == 401, f"{metodo} {rota}: esperado 401 com Bearer lixo, veio {r.status_code}"
    assert r.json().get("code") == "UNAUTHENTICATED"


# ═════════════════════════════════════════════════════════════════════════════
# 0043 (onda 4) — os casos GÊMEOS das quatro respostas espelhadas (§5.8)
# ═════════════════════════════════════════════════════════════════════════════
#
# Por que aqui e não num teste de banco: o defeito que esta onda pode produzir
# não é de guard, é de SQL — uma `ORDER BY` fora do `json_agg` (o Postgres não
# ordena o array e os chips saem em ordem diferente de cada lado), um `::uuid`
# colado no bind (não compila no ``text()``), um JOIN no lugar da subconsulta
# correlacionada (multiplicaria linha e corromperia os QUATRO agregados de R1) e
# um predicado de restrito na pré-seleção por profissional (que mudaria o
# recorte). Tudo isso é legível no módulo, sem subir Postgres.
#
# Os gêmeos do lado TS são `disciplinas-validations.test.ts` (zod) e a
# conferência de banco da spec §8.15/§8.19.

# Import DIRETO (não ``importorskip``): nesta suíte "o BFF não importou" é
# regressão, não degradação consciente — é o contrato do tests/unit_bff/conftest.
# O ``sys.path`` com ``bff/`` já foi montado pelo conftest raiz.
from app.routers.migrated import conf_cofre_documentos as _conf_cofre  # noqa: E402
from app.routers.migrated import conf_operacoes as _conf_ops  # noqa: E402
from app.routers.migrated import conf_operacoes_id as _conf_ops_id  # noqa: E402


# ── (i) os dois filtros novos do cofre ───────────────────────────────────────

@pytest.mark.parametrize("campo", ["disciplinaId", "profissionalId"])
async def test_filtro_novo_e_aceito_e_valida_uuid(client, token_visualizador, campo):
    """O BFF CONHECE os dois filtros da 0043 — e recusa uuid malformado como o Next.

    Se o parâmetro fosse ignorado (o defeito silencioso de quem espelha só o
    SELECT), um valor inválido passaria batido e a lista viria INTEIRA: a tela
    diria "filtrado por disciplina" mostrando tudo. O 400 no campo prova que o
    parâmetro chegou ao validador. Formato do erro é o de HOJE nesta rota —
    400 ``{"error":"Parâmetros inválidos","detalhes":{...}}``, não 422.
    """
    r = await client.get(
        f"/api/conformidade/cofre/documentos?{campo}=nao-e-uuid",
        headers=auth_headers(token_visualizador),
    )
    assert r.status_code == 400, f"{campo} inválido deveria dar 400, veio {r.status_code}"
    corpo = r.json()
    assert corpo["error"] == "Parâmetros inválidos"
    assert corpo["detalhes"] == {campo: "ID inválido"}, (
        "mensagem do zod `z.string().uuid(\"ID inválido\")` — vai à tela campo a campo"
    )


def test_filtro_de_disciplina_usa_cast_nunca_dois_pontos_colados():
    """``CAST(:x AS uuid)`` e não ``:x::uuid`` — o ``::`` colado no bind não compila.

    É a armadilha que a spec nomeia (§9): o ``text()`` do SQLAlchemy lê ``:x`` e
    o ``::uuid`` grudado quebra o parse do bind. A nota já existe no filtro de
    operação; aqui ela vira teste.
    """
    assert _conf_cofre._COND_DISCIPLINA_SQL == (
        "d.disciplina_id = CAST(:disciplina_id AS uuid)"
    )
    assert "CAST(:profissional_id AS uuid)" in _conf_cofre._SQL_DOCS_DO_PROFISSIONAL
    assert ":disciplina_id::" not in _conf_cofre._COND_DISCIPLINA_SQL
    assert ":profissional_id::" not in _conf_cofre._SQL_DOCS_DO_PROFISSIONAL


def test_pre_selecao_por_profissional_nao_filtra_restrito():
    """A pré-seleção só JUNTA ids; quem recorta é o predicado do WHERE.

    Se ela filtrasse restrito por conta própria, o recorte passaria a existir em
    DOIS lugares — e bastaria alguém esquecer um deles na query de contagem para
    ``total`` denunciar o documento oculto (o defeito que ADR-05 proíbe).
    """
    sql = _conf_cofre._SQL_DOCS_DO_PROFISSIONAL
    assert "profissional_documentos" in sql
    assert "restrito" not in sql
    assert "is_conformidade" not in sql


def test_join_de_disciplina_no_cofre_e_left():
    """LEFT, nunca INNER: documento sem disciplina é a MAIORIA do acervo.

    Um INNER faria sumir da lista exatamente as linhas que a tela D4 existe para
    completar — e ainda mudaria ``total``.
    """
    assert _conf_cofre._DISCIPLINA_JOIN_SQL.startswith("LEFT JOIN disciplinas")
    assert "disc.id = d.disciplina_id" in _conf_cofre._DISCIPLINA_JOIN_SQL


# ── (ii) `disciplina` aninhada: presente e `null` ────────────────────────────

@pytest.mark.parametrize(
    "modulo",
    ["conf_cofre_documentos", "conf_operacoes_id"],
)
def test_disciplina_aninhada_presente_e_nula(modulo):
    """Documento COM disciplina traz o objeto; documento SEM traz ``null``.

    Nunca um objeto de campos nulos — é o mesmo contrato que ``operacao`` já tem
    na lista do cofre, e o front distingue `null` de `{id:null,...}`. Os dois
    módulos respondem igual de propósito: a mesma chave sai das duas rotas.
    """
    aninhar = {
        "conf_cofre_documentos": _conf_cofre._disciplina_aninhada,
        "conf_operacoes_id": _conf_ops_id._disciplina_aninhada,
    }[modulo]

    import uuid as _uuid

    ident = _uuid.UUID("5000f1eb-3343-4d95-87f3-59c70bd96ee0")
    assert aninhar(ident, "TUB", "Tubulação") == {
        "id": "5000f1eb-3343-4d95-87f3-59c70bd96ee0",
        "codigo": "TUB",
        "nome": "Tubulação",
    }, "uuid sai como STRING (o Drizzle entrega texto)"
    assert aninhar(None, None, None) is None
    # Defesa contra LEFT JOIN que casou meio: sem rótulo não há objeto.
    assert aninhar(ident, None, None) is None


# ── (iii) `disciplinas` é ARRAY em R1 e R3 — nunca null ──────────────────────

def test_r1_usa_subconsulta_correlacionada_com_order_by_dentro_do_agg():
    """A subconsulta é CORRELACIONADA e a ordem vai DENTRO do ``json_agg``.

    Dois erros que este teste tranca:
      - trocar a subconsulta por ``LEFT JOIN operacao_disciplinas`` multiplicaria
        as linhas e, com elas, totalDocumentos/Atestados/ArtCat/Contratos (§1h);
      - ``ORDER BY`` FORA do ``json_agg``: o Postgres não aplica a ordem ao
        array, e os chips saem em ordem diferente entre Next e BFF — divergência
        que nenhum status code acusa.
    """
    sql = _conf_ops._DISCIPLINAS_SQL
    assert "FROM operacao_disciplinas od" in sql
    assert "WHERE od.operacao_id = o.id" in sql, "correlacionada pela operação da linha"
    agg_ini = sql.index("json_agg(")
    agg_fim = sql.index(")", sql.index("ORDER BY d.ordem, d.codigo"))
    assert agg_ini < sql.index("ORDER BY d.ordem, d.codigo") < agg_fim
    assert "coalesce(" in sql and "'[]'::json" in sql, "operação sem disciplina → []"


@pytest.mark.parametrize(
    "bruto",
    [
        [],
        "[]",
        None,
    ],
)
def test_r1_disciplinas_sem_vinculo_vira_lista_vazia(bruto):
    """``disciplinas: []`` — nunca ``null``, nunca a string "[]".

    O codec de json do dialeto asyncpg normalmente já entrega lista; o caso
    ``str`` está aqui porque um ambiente sem o codec devolveria TEXTO e a chave
    viraria uma string no JSON — divergência silenciosa do Next.
    """
    assert _conf_ops._disciplinas_do_agg(bruto) == []


def test_r1_disciplinas_saem_com_uuid_em_texto():
    assert _conf_ops._disciplinas_do_agg(
        [{"id": "5000f1eb-3343-4d95-87f3-59c70bd96ee0", "codigo": "TUB", "nome": "Tubulação"}]
    ) == [{"id": "5000f1eb-3343-4d95-87f3-59c70bd96ee0", "codigo": "TUB", "nome": "Tubulação"}]


def test_r3_disciplinas_da_obra_vazia_e_ordenada_pelo_catalogo():
    """R3 traz as disciplinas da OBRA em query própria, ordenadas como R1.

    Sem vínculo → ``[]`` (a chave é contrato de array). A ordem é ``ordem`` e
    depois ``codigo`` — a MESMA do ``json_agg`` de R1 e a MESMA dos chips da
    ficha; ordens diferentes fariam a mesma obra aparecer diferente conforme a
    tela que a abriu.
    """
    assert _conf_ops_id._serializar_disciplinas([]) == []
    sql = str(_conf_ops_id._DISCIPLINAS_DA_OPERACAO_SQL)
    assert "JOIN disciplinas d ON d.id = od.disciplina_id" in sql
    assert "ORDER BY d.ordem ASC, d.codigo ASC" in sql
    assert "ativo" not in sql, (
        "SEM filtro por `ativo`: disciplina desativada que a obra teve continua "
        "sendo verdade sobre a obra (espelha getDisciplinasByOperacao)"
    )


# ═════════════════════════════════════════════════════════════════════════════
# 0044 (onda 5) — os CINCO grupos de casos gêmeos das respostas espelhadas
# (spec ONDA-5 §5.10). Mesmo princípio da seção 0043 acima: o defeito que esta
# onda pode produzir não é de guard, é de SQL e de ORDEM DE CHAVE — e os dois
# são legíveis no próprio módulo, sem subir Postgres.
#
# O que cada grupo tranca:
#   (i)   B5  `area` em R1 e R3 — e a posição dela (entre `unidade` e
#         `detentora`), porque chave certa no lugar errado JÁ quebrou a
#         comparação byte a byte antes (§0.2).
#   (ii)  B6  `revisao` nos QUATRO lugares (lista do cofre, detalhe/PATCH,
#         dossiê e 201 do POST), presente e `null`.
#   (iii) D8  o desempate `, d.id ASC` — a ÚNICA mudança desta onda que altera
#         uma resposta já publicada sem acrescentar campo.
#   (iv)  C6  `arvore` no BODY: valor inválido → 422; árvore por disciplina com
#         a pasta `0_Sem_disciplina`.
#   (v)   C6  `arvore` sem `operacaoId` → 422 (nunca ignorada em silêncio).
#
# Os gêmeos do lado TS são `operacoes-validations.test.ts` (zod de `area` e do
# tri-estado), `cofre-adocao-edicao.test.ts` (`revisao` no diff) e as
# conferências de banco de §8.16/§8.18/§8.19.
import inspect  # noqa: E402

from app.routers.migrated import conf_cofre_bulk_download as _conf_zip  # noqa: E402
from app.routers.migrated import conf_cofre_documentos_id as _conf_cofre_id  # noqa: E402


def _entre(fonte: str, antes: str, meio: str, depois: str) -> bool:
    """True quando ``meio`` aparece ENTRE ``antes`` e ``depois`` na fonte."""
    for parte in (antes, meio, depois):
        assert parte in fonte, f"trecho ausente do módulo: {parte!r}"
    return fonte.index(antes) < fonte.index(meio) < fonte.index(depois)


# ── (i) B5 — `area` nas operações ────────────────────────────────────────────

def test_area_e_detentora_cnpj_nas_duas_operacao_cols():
    """As DUAS ``_OPERACAO_COLS`` têm ``area`` e ``detentora_cnpj``, na posição.

    A ordem das chaves do JSON é contrato de paridade (§0.2): o Next devolve a
    linha inteira (``select()`` cru no GET, ``.returning()`` no POST/PATCH) e o
    BFF monta a resposta por esta lista fechada — chave nova no FIM "porque
    funciona" quebraria a comparação byte a byte. E as duas listas têm de ser
    IGUAIS entre si: R1/POST (conf_operacoes) e R3/PATCH (conf_operacoes_id)
    descrevem a MESMA tabela.
    """
    for modulo in (_conf_ops, _conf_ops_id):
        cols = [c for c, _camel in modulo._OPERACAO_COLS]
        assert cols.index("unidade") + 1 == cols.index("area"), (
            "`area` vem logo DEPOIS de `unidade` (schema.ts:1107)"
        )
        assert cols.index("area") + 1 == cols.index("detentora")
        assert cols.index("detentora") + 1 == cols.index("detentora_cnpj"), (
            "drift fechado na 0044: `detentora_cnpj` logo depois de `detentora`"
        )
    assert _conf_ops._OPERACAO_COLS == _conf_ops_id._OPERACAO_COLS, (
        "as duas listas descrevem a MESMA tabela — divergir é publicar duas "
        "respostas diferentes para a mesma operação"
    )


def test_serializar_operacao_poe_area_entre_unidade_e_detentora():
    """``area`` sai na posição do pgTable e ``null`` quando vazia (nunca "")."""
    for modulo in (_conf_ops, _conf_ops_id):
        linha = {col: None for col, _camel in modulo._OPERACAO_COLS}
        linha["area"] = "U-32"
        out = list(modulo._serializar_operacao(linha).items())
        chaves = [k for k, _v in out]
        assert chaves[chaves.index("unidade") + 1] == "area"
        assert chaves[chaves.index("area") + 1] == "detentora"
        assert dict(out)["area"] == "U-32"
        linha["area"] = None
        assert modulo._serializar_operacao(linha)["area"] is None


def test_r1_projeta_e_serializa_area_na_posicao_do_pgtable():
    """R1 é montada à mão (SELECT + dict literal): a posição se prova na fonte.

    ``listOperacoes`` do Next projeta ``area`` entre ``unidade`` e ``detentora``
    (queries.ts:176). Aqui o SELECT e o dict do item são texto no handler — sem
    este teste, alguém acrescenta a chave no fim e a paridade quebra em silêncio,
    com 200 dos dois lados.
    """
    src = inspect.getsource(_conf_ops.listar_operacoes)
    assert _entre(src, "o.unidade,", "o.area,", "o.detentora,"), (
        "`o.area` entre `o.unidade` e `o.detentora` no SELECT de R1"
    )
    assert _entre(
        src, '"unidade": r["unidade"],', '"area": r["area"],', '"detentora": r["detentora"],'
    ), "`area` entre `unidade` e `detentora` no item da lista"


# ── (i-b) D11 — o recorte explícito que NÃO corta por omissão ────────────────

def _qp(query: str):
    """QueryParams de verdade (o mesmo objeto que o handler recebe)."""
    from starlette.datastructures import QueryParams

    return QueryParams(query)


@pytest.mark.parametrize(
    "query,esperado",
    [
        ("", None),
        ("ativo=1", True),
        ("ativo=true", True),
        ("ativo=0", False),
        ("ativo=false", False),
        # Valor desconhecido NÃO corta: cair no `false` esconderia as ativas, e
        # cair no `true` esconderia as inativas — as duas seriam o corte
        # escondido que o D11 existe para não repetir (§1c).
        ("ativo=xpto", None),
        ("ativo=", None),
    ],
)
def test_d11_ativo_e_tri_estado_e_o_default_nao_corta(query, esperado):
    filtros, detalhes = _conf_ops._validar_filtros(_qp(query))
    assert detalhes == {}, "`ativo` é lido FORA do zod: nunca gera erro de validação"
    assert filtros["ativo"] is esperado


def test_d11_sem_parametro_nenhum_recorte_e_empilhado():
    """Ausente = TODAS (ativas E inativas) — o conjunto de antes da onda."""
    filtros, detalhes = _conf_ops._validar_filtros(_qp(""))
    assert detalhes == {}
    assert filtros["ativo"] is None and filtros["de"] is None and filtros["ate"] is None


@pytest.mark.parametrize(
    "query,campo,mensagem",
    [
        # Formato E calendário: "2020-13-01" passa em regex e o Postgres
        # recusaria com 22008 — 500 em vez de 400.
        ("de=2020-13-01", "de", "Data no formato AAAA-MM-DD"),
        ("de=2019-02-31", "de", "Data no formato AAAA-MM-DD"),
        ("ate=31/12/2024", "ate", "Data no formato AAAA-MM-DD"),
        ("de=", "de", "Data no formato AAAA-MM-DD"),
        ("de=2024-01-01&ate=2023-01-01", "ate", "Data inicial maior que a final"),
        # `ate` inválido E invertido: o zod v4 roda o superRefine MESMO com o
        # campo em erro, e o `formatZodErrors` é um reduce — a ÚLTIMA issue do
        # mesmo path vence. Medido executando o schema real.
        ("de=2024-01-01&ate=2023-13-01", "ate", "Data inicial maior que a final"),
    ],
)
def test_d11_janela_invalida_reporta_no_campo(query, campo, mensagem):
    _filtros, detalhes = _conf_ops._validar_filtros(_qp(query))
    assert detalhes.get(campo) == mensagem


def test_d11_terceira_query_so_existe_com_janela_e_conta_int():
    """``semPeriodo`` custa uma query — e só quando há janela (§4.7).

    Sem ``de``/``ate`` a lista tem de continuar com as MESMAS duas queries de
    antes da onda: quem não recorta não paga nada. E a contagem leva ``::int``,
    senão o bigint chega como STRING no Next e o JSON diverge.
    """
    src = inspect.getsource(_conf_ops.listar_operacoes)
    assert "if de or ate:" in src, "a 3ª query é condicional à janela"
    assert "count(*)::int AS total FROM operacoes o " in src
    assert "(o.periodo_inicio IS NULL OR o.periodo_fim IS NULL)" in src
    # A fotografia é do recorte SEM a janela — senão o número que "explica a
    # diferença" seria de outro conjunto.
    assert "conds_sem_janela" in src and "params_sem_janela" in src


def test_d11_datas_vao_por_cast_nunca_por_dois_pontos_colados():
    """``CAST(:de AS date)`` e não ``:de::date`` — o ``::`` colado não compila."""
    src = inspect.getsource(_conf_ops.listar_operacoes)
    assert "CAST(:de AS date)" in src and "CAST(:ate AS date)" in src
    assert ":de::" not in src and ":ate::" not in src


def test_d11_eco_dos_filtros_omite_a_chave_ausente():
    """`filtros` traz SÓ o aplicado: chave ausente = filtro ausente, nunca null.

    É o contrato de §5.7 e o que deixa a tela escrever a frase do cabeçalho sem
    adivinhar. Um `"ativo": null` no corpo faria a tela dizer "só ativas" para
    quem não pediu recorte nenhum.
    """
    src = inspect.getsource(_conf_ops.listar_operacoes)
    assert 'if ativo is not None:\n        filtros_aplicados["ativo"] = ativo' in src
    assert 'filtros_aplicados["comProva"] = com_prova' in src
    assert '"semPeriodo": sem_periodo,' in src


# ── (ii) B6 — `revisao` nos quatro lugares ───────────────────────────────────

def test_revisao_no_detalhe_entre_versao_e_documento_anterior():
    """``_doc_to_json`` (GET e PATCH de documento): posição e `null`."""
    src = inspect.getsource(_conf_cofre_id._doc_to_json)
    assert _entre(src, '"versao": r["versao"],', '"revisao": r["revisao"],',
                  '"documentoAnteriorId"')
    linha = {
        "id": None, "categoria": None, "subcategoria": None, "titulo": None,
        "descricao": None, "operacao_id": None, "papel": None,
        "tipo_documento": None, "situacao_prova": None, "detentora": None,
        "detentora_cnpj": None, "restrito": False, "import_job_id": None,
        "disciplina_id": None, "origem_path": None, "nome_arquivo": None,
        "blob_url": None, "blob_key": None, "tamanho_bytes": None,
        "content_type": None, "sha256": None, "numero_documento": None,
        "emitido_em": None, "validade_fim": None, "validade_indeterminada": False,
        "status": "VIGENTE", "versao": 1, "revisao": "R1",
        "documento_anterior_id": None, "ocr_texto": None, "ocr_metadata": None,
        "ocr_confianca": None, "tags": None, "uploadado_por": None,
        "atualizado_por": None, "criado_em": None, "atualizado_em": None,
    }
    out = _conf_cofre_id._doc_to_json(linha)
    chaves = list(out.keys())
    assert chaves[chaves.index("versao") + 1] == "revisao"
    assert out["revisao"] == "R1"
    linha["revisao"] = None
    assert _conf_cofre_id._doc_to_json(linha)["revisao"] is None


@pytest.mark.parametrize(
    "body,esperado",
    [
        # `.trim()` do zod roda ANTES do `.max()` — e o valor GRAVADO é o
        # aparado: " R1 " vira "R1", não fica com os espaços do formulário.
        ({"revisao": "  R1  "}, ("ok", "R1")),
        ({"revisao": "x" * 20}, ("ok", "x" * 20)),
        # `null` LIMPA a coluna (é o único jeito de apagar a revisão).
        ({"revisao": None}, ("ok", None)),
        # Whitespace puro vira STRING VAZIA e é válido — não vira `null`.
        ({"revisao": "   "}, ("ok", "")),
        ({"revisao": "x" * 21}, ("erro", "Revisão muito longa")),
        ({"revisao": 5}, ("erro", "Invalid input: expected string, received number")),
    ],
)
def test_revisao_no_patch_de_documento(body, esperado):
    data, erros = _conf_cofre_id._validar_editar(body)
    tipo, valor = esperado
    if tipo == "ok":
        assert erros is None, erros
        assert data["revisao"] == valor
    else:
        assert data is None
        assert erros == {"revisao": valor}


def test_revisao_ausente_nao_entra_no_update():
    """Ausente NÃO mexe — o PATCH é parcial e `revisao` não é exceção."""
    data, erros = _conf_cofre_id._validar_editar({"titulo": "Atestado 10008"})
    assert erros is None
    assert "revisao" not in data
    src = inspect.getsource(_conf_cofre_id.patch_documento)
    assert 'if "revisao" in data:' in src and 'set_cols.append("revisao = :revisao")' in src


def test_revisao_na_lista_do_cofre_entre_versao_e_tags():
    src = inspect.getsource(_conf_cofre._list_documentos)
    assert _entre(src, "d.versao", "d.revisao", "d.tags"), "SELECT na posição do Drizzle"
    assert _entre(src, '"versao": r["versao"],', '"revisao": r["revisao"],',
                  '"tags": r["tags"],'), "item da lista na posição do Drizzle"


def test_revisao_no_documento_do_dossie_entre_versao_e_criado_em():
    src = inspect.getsource(_conf_ops_id.obter_operacao)
    assert _entre(src, "d.versao,", "d.revisao,", "d.criado_em,")
    assert _entre(src, '"versao": r["versao"],', '"revisao": r["revisao"],',
                  '"criadoEm": _js_to_iso_string(r["criado_em"]),')


def test_revisao_no_post_multipart_e_validada_gravada_e_devolvida():
    """O upload GRAVA a revisão (aparada) e o 201 a devolve na posição do pgTable.

    Os três pontos do campo no POST, e o motivo de cada um:
      - validação: 422 "Revisão muito longa" acima de 20 DEPOIS do trim (o
        ``.trim()`` do zod roda antes do ``.max()``);
      - INSERT: sem a coluna, o campo seria validado e jogado fora — o 201
        traria ``revisao: null`` com o carimbo preenchido no formulário, e só
        um PATCH depois salvaria o dado;
      - 201: a chave entre ``versao`` e ``documentoAnteriorId``, que é onde o
        ``.returning()`` do Drizzle a entrega.
    """
    src = inspect.getsource(_conf_cofre.post_documento)
    assert 'detalhes["revisao"] = "Revisão muito longa"' in src
    assert 'revisao_final = revisao_form.strip() if revisao_form is not None else None' in src
    # A coluna entra no INSERT — e com o valor APARADO, não o do formulário.
    ini = src.index("INSERT INTO documentos_habilitacao (")
    colunas = src[ini:src.index(") VALUES", ini)]
    assert "revisao" in colunas, "o POST grava a revisão (o Next também — §5.4)"
    assert '"revisao": revisao_final,' in src
    # RETURNING e corpo do 201 têm a chave, na posição do pgTable.
    assert "status, versao, revisao, documento_anterior_id," in src
    assert _entre(src, '"versao": novo["versao"],', '"revisao": novo["revisao"],',
                  '"documentoAnteriorId"')


# ── (iii) D8 — a paginação estável ──────────────────────────────────────────

def test_order_by_da_lista_tem_desempate_por_id_e_nao_declara_nulls():
    """``ORDER BY <col> <dir>, d.id ASC`` — espelho do ``asc(id)`` do Drizzle.

    Sem o desempate, ``order=validade`` (o default) empata em milhares de linhas
    com ``validade_fim`` NULL e o LIMIT/OFFSET devolve páginas que se repetem e
    se pulam. Com paginação numerada quase não se vê; com a rolagem infinita da
    onda 5 vira documento duplicado na tela e documento sumido.

    ``NULLS FIRST/LAST`` fica FORA de propósito: os dois lados são Postgres e é
    o default (ASC → NULLS LAST) que os mantém idênticos — escrevê-lo em um só
    lado seria criar a divergência que este teste existe para impedir.
    """
    src = inspect.getsource(_conf_cofre._list_documentos)
    # A linha do ORDER BY, e não o módulo inteiro: o comentário logo acima dela
    # EXPLICA por que `NULLS` fica de fora, e um `not in src` cru reprovaria a
    # explicação junto com o defeito.
    linhas = [ln.strip() for ln in src.splitlines() if ln.strip().startswith("ORDER BY")]
    assert linhas == ["ORDER BY {order_col} {order_dir}, d.id ASC"], linhas
    assert "NULLS" not in linhas[0]


# ── (iv)/(v) C6 — `arvore` no bulk-download ─────────────────────────────────

@pytest.mark.parametrize("valor", ["xpto", "SECAO", "", None, 3])
async def test_arvore_invalida_da_422_antes_de_qualquer_io(client, token_visualizador, valor):
    """Valor fora de ``secao|disciplina`` → 422, sem tocar banco nem storage.

    ``null`` entra aqui de propósito: em JS ``corpo.arvore !== undefined`` é
    TRUE para ``null``, então ``{"arvore": null}`` é pedido EXPLÍCITO inválido —
    não pode cair no default e devolver a árvore por seção calado.
    """
    r = await client.post(
        "/api/conformidade/cofre/documentos/bulk-download",
        json={"operacaoId": UUID_SONDA, "arvore": valor},
        headers=auth_headers(token_visualizador),
    )
    assert r.status_code == 422, r.text
    assert r.json() == {"error": "arvore deve ser secao ou disciplina"}


async def test_arvore_invalida_vence_a_forma_por_ids(client, token_visualizador):
    """Valor inválido é erro de FORMATO nas duas formas — e ele vem primeiro.

    ``{ids, arvore:"xpto"}`` tem dois defeitos; o 422 que sai é o do valor,
    porque a validação do valor roda ANTES de escolher a forma (route.ts:144).
    Inverter a ordem faria a mesma requisição responder coisas diferentes de
    cada lado, com o mesmo status.
    """
    r = await client.post(
        "/api/conformidade/cofre/documentos/bulk-download",
        json={"ids": [UUID_SONDA], "arvore": "xpto"},
        headers=auth_headers(token_visualizador),
    )
    assert r.status_code == 422, r.text
    assert r.json() == {"error": "arvore deve ser secao ou disciplina"}


@pytest.mark.parametrize("valor", ["disciplina", "secao"])
async def test_arvore_sem_operacao_id_da_422(client, token_visualizador, valor):
    """A forma por ids agrupa por CATEGORIA e não sabe montar árvore nenhuma.

    Ignorar o campo em silêncio entregaria ao usuário uma árvore que ele não
    pediu — pior que recusar (§1a). Vale inclusive para ``arvore:"secao"``: o
    que a forma por ids monta não é a árvore por SEÇÃO da ficha.
    """
    r = await client.post(
        "/api/conformidade/cofre/documentos/bulk-download",
        json={"ids": [UUID_SONDA], "arvore": valor},
        headers=auth_headers(token_visualizador),
    )
    assert r.status_code == 422, r.text
    assert r.json() == {
        "error": "arvore só se aplica ao dossiê da operação (informe operacaoId)"
    }


def test_arvore_e_campo_do_body_nunca_query_string():
    """Esta rota NÃO lê query string em ponto nenhum — nos dois lados.

    Um ``?arvore=disciplina`` seria ignorado em silêncio no Next e aqui, e a
    tela pareceria funcionar em desenvolvimento porque a árvore por seção é a
    padrão (§1a).
    """
    src = inspect.getsource(_conf_zip.bulk_download)
    assert 'tem_arvore = isinstance(body, dict) and "arvore" in body' in src
    assert "query_params" not in src, "a rota lê SÓ o body"


def test_join_de_disciplina_no_zip_e_left_e_a_pasta_zero_existe():
    """LEFT, nunca INNER — e a pasta dos sem-disciplina começa com "0_".

    Um INNER faria o ZIP sair SEM a maioria dos documentos (disciplina é NULL na
    maior parte do acervo), que é o pior erro possível num download de dossiê. O
    "0_" põe a pasta em PRIMEIRO em qualquer descompactador: o que falta
    classificar aparece antes do que já está.
    """
    src = inspect.getsource(_conf_zip.bulk_download)
    assert "LEFT JOIN disciplinas disc ON disc.id = d.disciplina_id" in src
    assert '"0_Sem_disciplina"' in src
    assert 'if arvore == "disciplina":' in src


def test_nome_do_zip_combina_secao_e_arvore():
    """Os QUATRO nomes de §5.3 saem da mesma regra dos dois lados."""
    src = inspect.getsource(_conf_zip.bulk_download)
    assert 'parte_secao = "" if secao is None else f"_secao{secao}"' in src
    assert 'parte_arvore = "_disciplina" if arvore == "disciplina" else ""' in src
    assert 'filename = f"dossie_{codigo_san}{parte_secao}{parte_arvore}_{stamp}.zip"' in src


def test_mensagem_de_teto_avisa_que_a_disciplina_e_do_dossie_inteiro():
    """Quem pediu "por disciplina" e ouve "Baixe por seção." precisa do porquê.

    Sem a frase entre parênteses a mensagem parece ignorar o que o usuário
    pediu. Só o dossiê INTEIRO ganha a variante: com ``secao`` a instrução já é
    outra ("Baixe em partes pela ficha.").
    """
    src = inspect.getsource(_conf_zip.bulk_download)
    assert "o ZIP por disciplina é sempre " in src and "do dossiê inteiro)." in src
    assert src.count("Baixe em partes pela ficha.") >= 2


# ═════════════════════════════════════════════════════════════════════════════
# CAMADA B (Gate 2) — o que SÓ o banco prova: a posição da chave na resposta
# REAL e a estabilidade das páginas. Marcada com skipif sem ``DATABASE_URL``,
# no molde de ``test_acervo_restrito.py``: guard e leitura de fonte não provam
# que a página 2 não repete a 1.
# ═════════════════════════════════════════════════════════════════════════════
import os  # noqa: E402
import uuid as _uuid  # noqa: E402

MARCADOR_0044 = "UNIT-0044-REFINO"

GATE2_0044 = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason=(
        "Gate 2: cenário SEMEADO — exige o Postgres do stack (DATABASE_URL) com "
        "a migration 0044 aplicada; fonte e guard não provam paginação nem "
        "posição de chave na resposta real"
    ),
)


@pytest.fixture
def cenario_0044():
    """Semeia o cenário da onda 5: 2 obras (uma SEM período) e 130 documentos
    com ``validade_fim`` NULL em TODOS — o caso real (atestado não vence) e o
    único em que o empate do ``ORDER BY`` aparece.

    Idempotente: tudo carrega ``nonce`` no código/título e o teardown varre por
    ele. ``uploadado_por`` vem de um usuário REAL (a FK não aceita sub sintético).
    """
    psycopg = pytest.importorskip("psycopg", reason="psycopg (deps do tester) para semear")
    nonce = _uuid.uuid4().hex[:8]
    conn = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)
    d = {"nonce": nonce, "cliente": f"{MARCADOR_0044} {nonce}"}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users ORDER BY criado_em ASC LIMIT 1")
            row = cur.fetchone()
            assert row, "seed base ausente: nenhum usuário no banco (rode make seed-e2e)"
            d["userId"] = str(row[0])

            d["codigoComPeriodo"] = f"9Q{nonce}A"
            cur.execute(
                "INSERT INTO operacoes (codigo, cliente_nome, unidade, area, detentora, "
                "periodo_inicio, periodo_fim, ativo) "
                "VALUES (%s, %s, 'REFINARIA-X', 'U-32', 'PROPONENTE', '2019-01-01', '2020-12-31', true) "
                "RETURNING id",
                (d["codigoComPeriodo"], d["cliente"]),
            )
            d["operacaoId"] = str(cur.fetchone()[0])

            # A obra SEM período é a que faz ``semPeriodo`` ser > 0 na janela.
            d["codigoSemPeriodo"] = f"9Q{nonce}B"
            cur.execute(
                "INSERT INTO operacoes (codigo, cliente_nome, area, detentora, ativo) "
                "VALUES (%s, %s, NULL, 'PROPONENTE', false) RETURNING id",
                (d["codigoSemPeriodo"], d["cliente"]),
            )
            d["operacaoSemPeriodoId"] = str(cur.fetchone()[0])

            cur.execute(
                """
                INSERT INTO documentos_habilitacao
                  (categoria, subcategoria, titulo, nome_arquivo, blob_url, blob_key,
                   status, uploadado_por, operacao_id, papel, tipo_documento,
                   revisao, validade_fim)
                SELECT 'TECNICA', 'ATESTADO_ACT',
                       %s || ' ' || lpad(i::text, 3, '0'),
                       'doc' || i || '.pdf', 'blob://' || %s || '/' || i,
                       'k/' || %s || '/' || i, 'VIGENTE', %s::uuid, %s::uuid,
                       'ATESTADO', 'ATESTADO',
                       -- metade COM revisão, metade sem: as duas formas na mesma lista
                       CASE WHEN i %% 2 = 0 THEN NULL ELSE 'R' || (i %% 5) END,
                       NULL           -- validade_fim NULL em TODOS (o empate)
                FROM generate_series(1, 130) AS i
                """,
                (f"{MARCADOR_0044} {nonce}", nonce, nonce, d["userId"], d["operacaoId"]),
            )
        yield d
    finally:
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM documentos_habilitacao WHERE titulo LIKE %s",
                    (f"{MARCADOR_0044} {nonce}%",),
                )
                cur.execute("DELETE FROM operacoes WHERE codigo IN (%s, %s)",
                            (d.get("codigoComPeriodo"), d.get("codigoSemPeriodo")))
        except Exception:  # noqa: BLE001 — teardown best-effort (padrão das suítes)
            pass
        conn.close()


@GATE2_0044
async def test_b5_area_em_r1_e_r3_na_posicao_e_null_quando_vazia(
    client, token_admin, cenario_0044
):
    """`area` sai nas DUAS respostas, entre `unidade` e `detentora`, `null` se vazia."""
    d = cenario_0044
    r1 = await client.get(
        "/api/conformidade/operacoes",
        params={"busca": d["cliente"]},
        headers=auth_headers(token_admin),
    )
    assert r1.status_code == 200, r1.text
    itens = {o["codigo"]: o for o in r1.json()["operacoes"]}
    assert set(itens) == {d["codigoComPeriodo"], d["codigoSemPeriodo"]}
    com = itens[d["codigoComPeriodo"]]
    chaves = list(com.keys())
    assert chaves[chaves.index("unidade") + 1] == "area"
    assert chaves[chaves.index("area") + 1] == "detentora"
    assert com["area"] == "U-32"
    assert itens[d["codigoSemPeriodo"]]["area"] is None, "vazia é null, nunca ''"

    r3 = await client.get(
        f"/api/conformidade/operacoes/{d['operacaoId']}",
        headers=auth_headers(token_admin),
    )
    assert r3.status_code == 200, r3.text
    corpo = r3.json()
    ks = list(corpo.keys())
    assert ks[ks.index("unidade") + 1] == "area" and corpo["area"] == "U-32"
    assert ks[ks.index("detentora") + 1] == "detentoraCnpj", (
        "drift de §1k fechado nesta onda: a chave EXISTE no BFF"
    )


@GATE2_0044
async def test_b6_revisao_na_lista_no_detalhe_e_no_dossie(client, token_admin, cenario_0044):
    """`revisao` sai nos três GETs, na posição do pgTable, presente e `null`."""
    d = cenario_0044
    lista = await client.get(
        "/api/conformidade/cofre/documentos",
        # limit alto de propósito: os 130 documentos, para a asserção das duas
        # formas (com e sem revisão) ser determinística e não um sorteio.
        params={"busca": f"{MARCADOR_0044} {d['nonce']}", "limit": 130},
        headers=auth_headers(token_admin),
    )
    assert lista.status_code == 200, lista.text
    itens = lista.json()["data"]
    ks = list(itens[0].keys())
    assert ks[ks.index("versao") + 1] == "revisao"
    assert ks[ks.index("revisao") + 1] == "tags"
    assert {("R" in (i["revisao"] or "")) for i in itens} == {True, False}, (
        "a lista tem documento COM e SEM revisão — as duas formas exercitadas"
    )

    doc_id = itens[0]["id"]
    det = await client.get(
        f"/api/conformidade/cofre/documentos/{doc_id}", headers=auth_headers(token_admin)
    )
    assert det.status_code == 200, det.text
    kd = list(det.json().keys())
    assert kd[kd.index("versao") + 1] == "revisao"
    assert kd[kd.index("revisao") + 1] == "documentoAnteriorId"

    dossie = await client.get(
        f"/api/conformidade/operacoes/{d['operacaoId']}", headers=auth_headers(token_admin)
    )
    kdoc = list(dossie.json()["documentos"][0].keys())
    assert kdoc[kdoc.index("versao") + 1] == "revisao"
    assert kdoc[kdoc.index("revisao") + 1] == "criadoEm"


@GATE2_0044
async def test_d8_paginas_consecutivas_nao_se_repetem_nem_se_pulam(
    client, token_admin, cenario_0044
):
    """130 documentos com `validade_fim` NULL: páginas 1 e 2 SEM id em comum.

    ⚠️ Conferência do próprio teste (manual, §8.16): tire o ``, d.id ASC`` do
    ``ORDER BY`` de ``_list_documentos`` e rode de novo — com edição concorrente
    ele QUEBRA. Um teste de estabilidade que passa dos dois jeitos não está
    testando nada; aqui o que se trava é o contrato observável (sem interseção,
    mesma ordem em chamadas repetidas), que é o que a rolagem infinita consome.
    """
    d = cenario_0044
    params = {
        "busca": f"{MARCADOR_0044} {d['nonce']}",
        "order": "validade", "dir": "asc", "limit": 50,
    }

    async def pagina(n):
        r = await client.get(
            "/api/conformidade/cofre/documentos",
            params={**params, "page": n},
            headers=auth_headers(token_admin),
        )
        assert r.status_code == 200, r.text
        return r.json()

    p1, p2 = await pagina(1), await pagina(2)
    ids1 = [i["id"] for i in p1["data"]]
    ids2 = [i["id"] for i in p2["data"]]
    assert p1["total"] == 130
    assert len(ids1) == 50 and len(ids2) == 50
    assert not (set(ids1) & set(ids2)), "página 2 repetiu linha da página 1"
    assert len(set(ids1) | set(ids2)) == 100

    # Cinco repetições devolvem EXATAMENTE as mesmas listas, na mesma ordem.
    for _ in range(5):
        assert [i["id"] for i in (await pagina(1))["data"]] == ids1
        assert [i["id"] for i in (await pagina(2))["data"]] == ids2

    # E a rolagem inteira não perde nem duplica ninguém.
    todos: list[str] = []
    for n in range(1, 4):
        todos += [i["id"] for i in (await pagina(n))["data"]]
    assert len(todos) == 130 and len(set(todos)) == 130


@GATE2_0044
async def test_d11_eco_do_recorte_e_sem_periodo(client, token_admin, cenario_0044):
    """O recorte é explícito, ecoado, e o default preserva o conjunto de hoje."""
    d = cenario_0044

    async def r1(**qs):
        r = await client.get(
            "/api/conformidade/operacoes",
            params={"busca": d["cliente"], **qs},
            headers=auth_headers(token_admin),
        )
        assert r.status_code == 200, r.text
        return r.json()

    sem_param = await r1()
    assert sem_param["total"] == 2, "sem parâmetro: ativas E inativas"
    assert sem_param["semPeriodo"] == 0, "sem janela, semPeriodo é 0 literal"
    assert "ativo" not in sem_param["filtros"], "chave AUSENTE = filtro ausente"
    assert "de" not in sem_param["filtros"] and "ate" not in sem_param["filtros"]
    assert sem_param["filtros"]["comProva"] is False

    so_ativas = await r1(ativo="1")
    so_inativas = await r1(ativo="0")
    assert so_ativas["filtros"]["ativo"] is True
    assert so_inativas["filtros"]["ativo"] is False
    assert so_ativas["total"] + so_inativas["total"] == sem_param["total"], (
        "a soma dos dois recortes tem de fechar com o conjunto sem recorte"
    )

    janela = await r1(de="2018-01-01", ate="2024-12-31")
    assert janela["total"] == 1, "só a obra com período dentro da janela"
    assert janela["semPeriodo"] == 1, "a obra sem período é CONTADA, nunca sumida"
    assert janela["filtros"]["de"] == "2018-01-01"
    assert janela["filtros"]["ate"] == "2024-12-31"


@GATE2_0044
@pytest.mark.parametrize(
    "qs,campo,mensagem",
    [
        ({"de": "2020-13-01"}, "de", "Data no formato AAAA-MM-DD"),
        ({"de": "2024-01-01", "ate": "2023-01-01"}, "ate", "Data inicial maior que a final"),
    ],
)
async def test_d11_janela_invalida_e_400_nao_422(client, token_admin, qs, campo, mensagem):
    """400 ``Parâmetros inválidos`` — o contrato DESTA rota, não 422 (§0.2)."""
    r = await client.get(
        "/api/conformidade/operacoes", params=qs, headers=auth_headers(token_admin)
    )
    assert r.status_code == 400, r.text
    corpo = r.json()
    assert corpo["error"] == "Parâmetros inválidos"
    assert corpo["detalhes"][campo] == mensagem
