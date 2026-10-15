#!/usr/bin/env python3
"""
B4 — Guard HEURÍSTICO de drift de contrato Next ↔ BFF (roda nos DOIS CIs).

PROBLEMA: o app Next (app/src/app/api/**) e o BFF (bff/app/routers/migrated/)
— ambos NESTE repo — espelham as MESMAS ~102 rotas /api/*,
mas cada CI só enxerga o próprio diff — nenhum job consegue PROVAR que o espelho
do outro lado acompanhou a mudança. Este guard, então, é deliberadamente
heurístico: quando a superfície de API muda num range de commits, ele FALHA com
instrução de espelhamento, a menos que o autor declare a exceção no commit.

USO:
  python tests/lib/drift_guard.py --side bff  --range <BASE_SHA>..<HEAD>   # repo raiz
  python tests/lib/drift_guard.py --side next --range <BASE_SHA>..<HEAD>
  (--repo <dir> aponta o git a inspecionar; default = cwd.)
  NOTA: app/ e bff/ agora vivem NESTE mesmo repo (o app deixou de ser separado).
  Ao rodar --side next, os paths do app estao sob app/src/app/api/** — ajuste
  API_SURFACE["next"]/ALLOWLIST p/ o prefixo app/ se for reativar esse lado.

REGRAS:
  side=bff : mudanças em bff/app/routers/migrated/** exigem espelho no app
             (app/src/app/api/**) — que este repo NÃO enxerga => exige token.
  side=next: mudanças em src/app/api/** exigem espelho no BFF — idem.
  ALLOWLIST (mudança liberada SEM espelho — deliberadas, ver
  nginx/conf.d/petro-radar.conf):
    - src/app/api/auth/[...nextauth]/** : NextAuth (emissor de sessão) SÓ existe
      no Next — o NGINX fixa `location ^~ /api/auth` no web e o BFF apenas
      VALIDA o token (não há rota espelho no migrated/). (auth/setup TEM espelho
      — auth_setup.py — e fica fora da allowlist.)
    - As rotas XLSX (conformidade/import/template/familias,
      licitacoes/[id]/pacote-orcamento): o NGINX as fixa no Next (bytes
      exceljs != openpyxl) e os espelhos do BFF foram REMOVIDOS em 2026-07-02 —
      são Next-only. (relatorios/executivo saiu com o hub em 2026-09-18.)
    - (crons ficam FORA da allowlist de propósito: o NGINX roteia /api/cron/*
      p/ o Next, mas TODOS têm espelho real no BFF (cron_*.py) e o CRON_TARGET
      pode fazer o flip p/ bff; mudou, tem que espelhar.)
    - bff: __init__.py (plumbing de include) NÃO dispara o guard; _shared.py
      DISPARA (helpers canônicos mudam bytes de resposta de dezenas de rotas).

ESCAPE HATCH: se QUALQUER mensagem de commit do range contiver ``[drift-ok]``
(espelho já aplicado/confirmado no outro repo) ou ``[no-mirror]`` (mudança
deliberadamente sem espelho — ex.: rota nova de um lado só, correção de paridade
do BFF), o guard passa registrando o token usado. Sem token => exit 1.

Exit codes: 0 = sem drift/token presente; 1 = drift sem token; 0 com aviso se o
range não é resolvível (primeiro push de branch etc. — sem base p/ comparar).
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys

TOKENS = ("[drift-ok]", "[no-mirror]")

# Padrões (regex sobre o path RELATIVO à raiz do repo inspecionado).
API_SURFACE = {
    "bff": r"^bff/app/routers/migrated/(?!__init__\.py$).+",
    "next": r"^src/app/api/.+",
}
ALLOWLIST = {
    "bff": [],
    "next": [
        # NextAuth core: emissor de sessão, sem espelho no BFF por design
        # (nginx: location ^~ /api/auth -> web; BFF só valida o JWT).
        r"^src/app/api/auth/\[\.\.\.nextauth\]/",
        # Rotas XLSX Next-only (nginx fixa no web; espelhos BFF removidos
        # em 2026-07-02 — bytes exceljs != openpyxl).
        r"^src/app/api/conformidade/import/template/familias/",
        r"^src/app/api/licitacoes/\[id\]/pacote-orcamento/",
    ],
}
MIRROR_HINT = {
    "bff": "app/src/app/api/** (neste repo)",
    "next": "bff/app/routers/migrated/** (repo petro-radar-onprem)",
}


def _git(repo: str, *args: str) -> str:
    out = subprocess.run(
        ["git", "-C", repo, *args], capture_output=True, text=True, check=True
    )
    return out.stdout


def run(side: str, range_: str, repo: str) -> int:
    try:
        changed = [
            linha for linha in _git(repo, "diff", "--name-only", range_).splitlines() if linha
        ]
    except subprocess.CalledProcessError as exc:
        # Base inexistente (primeiro push do branch, shallow clone, SHA 000...):
        # não há o que comparar — passa com aviso (nunca bloqueia por acidente).
        print(f"drift-guard: range '{range_}' não resolvível ({exc.stderr.strip() or exc}); pulando.")
        return 0

    surface = re.compile(API_SURFACE[side])
    allow = [re.compile(p) for p in ALLOWLIST[side]]
    hits = [
        f for f in changed
        if surface.match(f) and not any(a.match(f) for a in allow)
    ]
    if not hits:
        print(f"drift-guard[{side}]: nenhuma mudança de superfície de API em {range_}. OK.")
        return 0

    mensagens = _git(repo, "log", "--format=%B", range_)
    token = next((t for t in TOKENS if t in mensagens), None)
    if token:
        print(
            f"drift-guard[{side}]: {len(hits)} arquivo(s) de API mudaram, mas o range "
            f"declara '{token}' — liberado. Arquivos:\n  " + "\n  ".join(hits)
        )
        return 0

    print(
        f"drift-guard[{side}]: FALHA — rotas de API mudaram em {range_} sem confirmação "
        "de espelhamento:\n  " + "\n  ".join(hits) + "\n\n"
        f"Confirme o espelho em {MIRROR_HINT[side]} e adicione ao commit o token "
        "'[drift-ok]' (espelho aplicado/confirmado) ou '[no-mirror]' (mudança "
        "deliberadamente sem espelho — justifique na mensagem). Contexto: os dois "
        "repos não se enxergam; este guard é a trava heurística de paridade (B4)."
    )
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--side", choices=("bff", "next"), required=True)
    ap.add_argument("--range", dest="range_", required=True, help="BASE_SHA..HEAD")
    ap.add_argument("--repo", default=".", help="diretório do repo git (default: cwd)")
    args = ap.parse_args()
    return run(args.side, args.range_, args.repo)


if __name__ == "__main__":
    sys.exit(main())
