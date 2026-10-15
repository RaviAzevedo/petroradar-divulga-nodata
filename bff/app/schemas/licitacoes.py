"""
Schemas de saida para o recurso `licitacoes`.

Espelha (de forma seletiva) a tabela `licitacoes` de src/db/schema.ts. O BFF
expoe apenas o subconjunto de leitura usado pelo feed/lista do front; os campos
pesados (dados_completos jsonb, classificacao_ia) ficam fora do payload de lista.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LicitacaoOut(BaseModel):
    """
    Projecao de leitura de uma licitacao.

    Os nomes seguem o app TS (camelCase) via alias para que o payload JSON case
    com o que o front ja consome. `from_attributes=True` permite construir a
    partir de Row/mapping do SQLAlchemy; `populate_by_name=True` permite tambem
    instanciar pelos nomes Python.
    """

    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
    )

    id: str
    numero: str
    objeto: str | None = None
    objeto_resumido: str | None = Field(default=None, alias="objetoResumido")
    empresa: str | None = None
    empresa_codigo: str | None = Field(default=None, alias="empresaCodigo")
    status: str | None = None
    sub_status: str | None = Field(default=None, alias="subStatus")
    fase: str | None = None
    modalidade: str | None = None
    abrangencia: str | None = None
    data_inicio: str | None = Field(default=None, alias="dataInicio")
    data_fim: str | None = Field(default=None, alias="dataFim")
    data_abertura: str | None = Field(default=None, alias="dataAbertura")
    natureza: str | None = None
    tipo_servico: str | None = Field(default=None, alias="tipoServico")
    segmento: str | None = None
    relevancia: str | None = None
    score_interesse: int | None = Field(default=None, alias="scoreInteresse")
    melhor_perfil: str | None = Field(default=None, alias="melhorPerfil")
    criado_em: datetime | None = Field(default=None, alias="criadoEm")
    atualizado_em: datetime | None = Field(default=None, alias="atualizadoEm")


class Paginacao(BaseModel):
    """Metadados de paginacao por offset/limit."""

    page: int = Field(ge=1, description="Pagina atual (1-based).")
    page_size: int = Field(ge=1, le=100, description="Itens por pagina.")
    total: int = Field(ge=0, description="Total de registros que casam o filtro.")
    total_pages: int = Field(ge=0, description="Total de paginas.")


class PaginaLicitacoes(BaseModel):
    """Envelope paginado de licitacoes."""

    data: list[LicitacaoOut]
    paginacao: Paginacao
