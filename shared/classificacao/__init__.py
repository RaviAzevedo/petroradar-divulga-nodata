"""Motor único de classificação de licitações — compartilhado worker↔BFF.

Uso (com /shared no sys.path):
    from classificacao import classificar_licitacao, classificar_natureza, ...
"""

from .motor import (  # noqa: F401
    THRESH_ALTA,
    THRESH_MEDIA,
    classificar_licitacao,
    classificar_natureza,
    classificar_segmento,
    classificar_tipo_servico,
    match_keywords,
    normalizar,
    pontuar_perfil,
    stats_familia,
)
