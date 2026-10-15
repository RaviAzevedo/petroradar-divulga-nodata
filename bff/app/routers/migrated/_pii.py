"""Redação de PII (CPF e e-mail) em texto livre do acervo.

POR QUE ESTE MÓDULO EXISTE, E POR QUE A VERSÃO ANTERIOR ERA PERIGOSA
────────────────────────────────────────────────────────────────────
A redação anterior (``conf_cofre_documentos._redigir_pii``) usava
``(?<!\\d)\\d{11}(?!\\d)`` para pegar CPF sem pontuação. O lookbehind exclui
apenas DÍGITO — então, num acervo cheio de número de ART do CREA, ela destruía
identificador legítimo:

    "ART BA12345678901"  →  "ART BA[CPF-REMOVIDO]"

ART é um dos tipos de documento mais comuns do acervo, e o número da ART é
exatamente o que se procura numa busca de habilitação. Na medição, milhares de
chunks tinham sequência de 11 dígitos nua, e a amostra era toda ART — não CPF.

DUAS DEFESAS, e as duas são necessárias
───────────────────────────────────────
1. FRONTEIRA ALFANUMÉRICA, não só de dígito: ``BA12345678901`` tem letra colada,
   então os 11 dígitos de dentro não são candidatos.
2. DÍGITO VERIFICADOR: só é redigido o que realmente fecha como CPF. Sem isso,
   ``protocolo 12345678901`` viraria ``[CPF-REMOVIDO]`` — e um acervo de
   engenharia é feito de números.

A validação também vale para o CPF FORMATADO. Um ``000.000.000-00`` de formulário
em branco não é dado pessoal de ninguém, e redigi-lo só apaga a informação de que
o campo estava vazio.

Espelho exato de app/src/lib/seguranca/pii.ts.
"""

from __future__ import annotations

import re

__all__ = ["cpf_valido", "redigir_pii", "MARCA_CPF", "MARCA_EMAIL"]

MARCA_CPF = "[CPF-REMOVIDO]"
MARCA_EMAIL = "[EMAIL-REMOVIDO]"

# Candidato formatado: 000.000.000-00
_RE_CPF_FMT = re.compile(r"\d{3}\.\d{3}\.\d{3}-\d{2}")
# Candidato nu: 11 dígitos SEM alfanumérico colado — é o que separa CPF de
# "BA12345678901". \b não serve: em regex, "A" e "2" são ambos \w, então
# \b\d{11}\b NÃO casaria dentro de BA1234... mas casaria em "R$ 12345678901,00".
# A classe explícita deixa a intenção legível e o comportamento igual nos dois
# backends (o JS não tem lookbehind em todos os alvos).
_RE_CPF_NU = re.compile(r"(?<![0-9A-Za-z])\d{11}(?![0-9A-Za-z])")
_RE_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def cpf_valido(digitos: str) -> bool:
    """Confere os dois dígitos verificadores. Espelho de cpfValido() no TS."""
    d = re.sub(r"\D", "", digitos or "")
    if len(d) != 11:
        return False
    # 111.111.111-11 e afins passam na conta do DV, mas não são CPF de ninguém.
    if len(set(d)) == 1:
        return False
    for corte in (9, 10):
        soma = sum(int(d[i]) * (corte + 1 - i) for i in range(corte))
        dv = (soma * 10) % 11 % 10
        if dv != int(d[corte]):
            return False
    return True


def _sub_se_cpf(m: re.Match[str]) -> str:
    return MARCA_CPF if cpf_valido(m.group(0)) else m.group(0)


def redigir_pii(texto: str | None) -> str | None:
    """Remove CPF e e-mail de texto livre. Idempotente."""
    if not texto:
        return texto
    t = _RE_CPF_FMT.sub(_sub_se_cpf, texto)
    t = _RE_CPF_NU.sub(_sub_se_cpf, t)
    return _RE_EMAIL.sub(MARCA_EMAIL, t)
