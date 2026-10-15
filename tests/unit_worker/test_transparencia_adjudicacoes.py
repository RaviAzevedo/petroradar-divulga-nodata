"""
Classificadores do modo "adjudicacoes" do worker (transparencia_sweep.py).

Os OBJETOS aqui são strings reais colhidas do Portal da Transparência (dado
público); os nomes de fornecedor e os valores são FICTÍCIOS. Servem de
golden: o texto do portal é curto e idiossincrático ("EPC TANCAGEM REFXA" tem 18
caracteres e nenhuma palavra que case com /engenharia|projeto/), e foi
exatamente isso que derrubou a primeira heurística. Se alguém "melhorar" as
regex sem rodar isto, os principais alvos somem da fila.

A tese comercial que os testes congelam:
  • vencedor de EPC/obra que NÃO vende projeto  → parceiro (fit alto)
  • vencedor de contrato de projeto puro        → concorrente (fit baixo)
  • andaime, motobomba, manutenção              → ruído (fit baixo)
"""
from __future__ import annotations

import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "worker"))

ts = pytest.importorskip("transparencia_sweep")


# ── Objetos reais do portal (2026-07-09) ──────────────────────────────────────
EPC_TANCAGEM = "EPC TANCAGEM REFXA"
EPC_UFN3 = (
    "FORNECIMENTO DE BENS E A PRESTAÇÃO DE SERVIÇOS PELA CONTRATADA NA "
    "MODALIDADE EPC, EPC 09, UFN-III"
)
OBRA_DUTO = (
    "SERVIÇO DE CONSTRUÇÃO CIVIL E MONTAGEM ELETROMECÂNICA DO NOVO DUTO DE "
    "ESCOAMENTO DA CONCESSÃO DE ARARA AZUL"
)
FISCALIZACAO = (
    "PRESTAÇÃO DOS SERVIÇOS DE SUPORTE TÉCNICO ÀS ATIVIDADES DE FISCALIZAÇÃO "
    "PARA A IMPLANTAÇÃO DE PROJETOS DESENVOLVIDOS PELA SRGE/SI-IV"
)
ANDAIMES = "SERVIÇOS TÉCNICOS DE PLATAFORMAS ARTICULADAS E MONTAGEM/DESMONTAGEM DE ANDAIMES NO APCAB."
MOTOBOMBAS = (
    "LOCAÇÃO DE MOTOBOMBAS COM ACIONAMENTO POR MOTOR DIESEL PARA ATENDIMENTO "
    "AS UNIDADES ONSHORE DA PETROBRAS"
)
MANUTENCAO = "SERVIÇOS DE MANUTENÇÃO DE CALDEIRARIA, TUBULAÇÕES, TANQUES"
PROJETO_PURO = "ELABORAÇÃO DE PROJETO BÁSICO E PROJETO EXECUTIVO DE TUBULAÇÃO"


class TestTipoEscopo:
    def test_epc_sem_a_palavra_engenharia(self):
        """O caso que quebrou a heurística de regex sobre `objeto`."""
        assert ts._tipo_escopo(EPC_TANCAGEM) == "epc"

    def test_epc_vence_fornecimento(self):
        # A string começa com "FORNECIMENTO DE BENS" — se `fornecimento` tivesse
        # precedência, o maior contrato de EPC do trimestre viraria compra.
        assert ts._tipo_escopo(EPC_UFN3) == "epc"

    def test_obra(self):
        assert ts._tipo_escopo(OBRA_DUTO) == "obra"

    def test_servico_vence_obra(self):
        # Casa "IMPLANTAÇÃO" (obra) e "FISCALIZAÇÃO" (serviço). É fiscalização.
        assert ts._tipo_escopo(FISCALIZACAO) == "servico"

    def test_projeto_tem_precedencia_maxima(self):
        assert ts._tipo_escopo(PROJETO_PURO) == "projeto"

    def test_ruido_nao_vira_obra(self):
        # "MONTAGEM/DESMONTAGEM DE ANDAIMES" não é montagem industrial.
        assert ts._tipo_escopo(ANDAIMES) == "outro"
        assert ts._tipo_escopo(MOTOBOMBAS) == "fornecimento"

    def test_objeto_vazio_ou_nulo(self):
        assert ts._tipo_escopo(None) == "outro"
        assert ts._tipo_escopo("") == "outro"


class TestPapelVencedor:
    @pytest.mark.parametrize("nome", [
        "ACME CONSTRUCAO E MONTAGENS S.A.",
        "CONSTRUTORA ALFA LTDA",
        "DELTA ENGENHARIA E CONSTRUÇÃO LTDA",  # engenharia + construção → obra manda
    ])
    def test_construtora(self, nome):
        assert ts._papel_vencedor(nome) == "construtora"

    def test_projetista(self):
        assert ts._papel_vencedor("OMEGA TECH ENGINEERING CONSULTING") == "projetista"
        assert ts._papel_vencedor("XYZ PROJETOS LTDA") == "projetista"

    def test_hibrido(self):
        assert ts._papel_vencedor("ALFA CONSTRUTORA E PROJETOS LTDA") == "hibrido"

    @pytest.mark.parametrize("nome", [
        "GAMA ENGENHARIA E INSPECAO INDUSTRIAL",  # é manutenção industrial
        "SIGMA ENGENHARIA, SERVICOS E COMERCIO",      # é apoio administrativo
    ])
    def test_engenharia_sozinha_e_ambigua(self, nome):
        """"ENGENHARIA" na razão social não define papel — preferimos admitir
        que não sabemos a rotular errado. É o CNAE que resolve (ver 0027)."""
        assert ts._papel_vencedor(nome) == "desconhecido"

    def test_nulo(self):
        assert ts._papel_vencedor(None) == "desconhecido"


class TestFitParceria:
    def _fit(self, objeto, fornecedor, valor, aderencia=1):
        _, c = ts._classificacao(objeto, fornecedor, valor, aderencia)
        return c["fit"]

    def test_epc_de_construtora_e_o_alvo_maximo(self):
        assert self._fit(EPC_TANCAGEM, "ACME CONSTRUCAO E MONTAGENS S.A.", 750_000_000) == 100

    def test_projeto_puro_de_projetista_pontua_baixo(self):
        """Quem ganha projeto puro é CONCORRENTE, não parceiro."""
        fit = self._fit(PROJETO_PURO, "XYZ PROJETOS E CONSULTORIA LTDA", 5_000_000)
        assert fit <= 30

    def test_ruido_fica_abaixo_dos_alvos(self):
        alvo = self._fit(OBRA_DUTO, "CONSTRUTORA ALFA LTDA", 75_000_000)
        for objeto, forn, valor in [
            (ANDAIMES, "BETA SOLUCOES INDUSTRIAIS LTDA", 35_000_000),
            (MOTOBOMBAS, "ZETA LOCACAO, COMERCIO", 45_000_000),
            (MANUTENCAO, "GAMA ENGENHARIA E INSPECAO", 550_000_000),
        ]:
            assert self._fit(objeto, forn, valor) < alvo

    def test_fit_e_clampado(self):
        assert 0 <= self._fit(EPC_TANCAGEM, "ACME CONSTRUCAO E MONTAGENS", 1e12) <= 100
        assert 0 <= self._fit("PATROCINIO CULTURAL", "OMEGA CONSULTING", 0, 0) <= 100

    def test_valor_nulo_nao_explode(self):
        assert self._fit(EPC_TANCAGEM, "ACME CONSTRUCAO", None) > 0


class TestClassificacaoPayload:
    def test_formato_do_jsonb(self):
        papel, c = ts._classificacao(EPC_TANCAGEM, "ACME CONSTRUCAO E MONTAGENS", 7.6e8, 1)
        assert papel == "construtora"
        assert c["v"] == 1
        # `fonte` é a costura: um classificador LLM sobrescreve com 'llm' e o
        # UPSERT passa a preservar a linha (ver _UPSERT em transparencia_sweep).
        assert c["fonte"] == "regex"
        assert c["contem_engenharia"] is True
        assert set(c) == {"v", "fonte", "tipo_escopo", "contem_engenharia", "fit"}


class TestMesesAtras:
    def test_tres_meses(self):
        hoje = date.today()
        d = date.fromisoformat(ts._meses_atras(3))
        assert (hoje.year - d.year) * 12 + (hoje.month - d.month) == 3

    def test_zero_e_hoje(self):
        assert ts._meses_atras(0) == date.today().isoformat()

    def test_nao_estoura_dia_em_mes_curto(self):
        """31/03 − 1 mês não pode virar 31/02."""
        # Exercita o clamp diretamente: qualquer N deve produzir data válida.
        for n in range(0, 25):
            date.fromisoformat(ts._meses_atras(n))  # ValueError se inválida


class TestModalidadesLicitadas:
    def test_so_disputa_real(self):
        """DISPENSA/INEXIGIBILIDADE/CONVÊNIO são adjudicação direta: não houve
        licitação ganha, logo não há parceria a propor."""
        assert ts.MODALIDADES_LICITADAS == {"LICITAÇÃO", "PREGÃO"}
        for m in ("DISPENSA", "INEXIGIBIL", "CONVÊNIO", "INAPLICAB"):
            assert m not in ts.MODALIDADES_LICITADAS
