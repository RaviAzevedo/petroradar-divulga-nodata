"""
Services do Petro Radar BFF.

Encapsulam integracoes externas (providers de embedding, Anthropic) que antes
viviam em src/lib/acervo/embeddings.ts e src/lib/licitacoes/claude.ts no app Next.
Os routers dependem destes modulos; manter aqui a logica de IO isola os endpoints
de detalhes de provider e facilita o teste/mocking.
"""

from app.services import anthropic, embeddings

__all__ = ["embeddings", "anthropic"]
