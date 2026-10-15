"""
WP12 G10/G11 — Guard de EGRESS por destino.

Prova o contrato de rede do "pitstop" (ENV.md §2.4, INTEGRACOES.md, ROTAS.md §13):

  PROIBIDO (presença = FAIL): qualquer conexão de saída a destinos que o on-prem
  deve ter ELIMINADO:
    - api.github.com           (sync trigger virou Celery — WIRING #2)
    - *.upstash.io             (Redis virou container)
    - api.voyageai.com         (embeddings viraram BGE-m3 local — Decisão 1)
    - api.openai.com           (idem)
    - api.resend.com           (SDK deletado do app — proibido incondicional)

  OBRIGATÓRIO QUANDO EXIGIDO (ausência = FAIL no cenário que o usa):
    - api.anthropic.com        (IA — se ANTHROPIC_API_KEY presente)
    - login.microsoftonline.com + graph.microsoft.com
                               (E-MAIL — se GRAPH_MAIL_SENDER presente. O Graph é
                                o transporte ÚNICO: sem estes dois hosts NÃO SAI
                                e-mail nenhum, e o único sinal é um logger.warn.)

  OPCIONAL/GATED (presença OK; ausência = SKIP consciente):
    - sistematransparencia.petrobras.com.br (TRANSPARENCIA_ENABLED)
    (Web Push/VAPID e NOTIFY_WEBHOOK_URL saíram em 2026-09-18.)

Estratégia de evidência (combináveis — qualquer uma alimenta o veredito):
  (1) PASSIVA: tcpdump/conntrack no host durante a janela de teste, despejado em
      tests/_artifacts/conntrack.txt (uma linha por host:porta observado);
  (2) ATIVA: tests/lib/egress_probe.sh (HOST) tenta TCP:443 de DENTRO de cada
      container (web/bff/worker) para cada destino e grava
      tests/_artifacts/egress_probe.json {"host": {"alcancavel", "por_container"}}.
      Proibido INALCANÇÁVEL em todos os containers => "provado_bloqueado": true
      (permite veredito GO mesmo sem conntrack). Proibido alcançável => violação.
      Exigido alcançável => status "alcancavel" (satisfaz o G11).

Saída: tests/_artifacts/egress.json — CONTRATO CANÔNICO lido pelo go_no_go (G10/G11):
  {"proibidos": {host: {"observado": bool, "esperado": false,
                        "provado_bloqueado": bool|null}},
   "exigidos":  {host: {"status": "observado"|"alcancavel"|"nao-verificado"|"FALTANDO"}},
   "gated":     {host: {"env_presente": bool}},
   "veredito":  str}
Critério G10: nenhum PROIBIDO observado/alcançável (PASS exige prova: veredito GO
ou todos provado_bloqueado). G11: todo EXIGIDO observado/alcançável.
"""
from __future__ import annotations

import json
import os
import pathlib

# _artifacts relativo a tests/ (tests/lib/.. = tests) — funciona no tester
# (/tests/_artifacts) e no host; override por env p/ cenários especiais.
ART = pathlib.Path(os.environ.get("GNG_ARTIFACTS", str(pathlib.Path(__file__).resolve().parents[1] / "_artifacts")))
ART.mkdir(parents=True, exist_ok=True)

PROIBIDOS = [
    "api.github.com",
    "upstash.io",
    "api.voyageai.com",
    "api.openai.com",
    # Resend: o SDK foi DELETADO do app (send.ts). Nao ha mais env que o religue,
    # entao ele e proibido INCONDICIONALMENTE — antes era condicionado a ausencia
    # de RESEND_API_KEY, uma env que nao existe mais em lugar nenhum.
    "api.resend.com",
]

EXIGIDOS = []
if os.environ.get("ANTHROPIC_API_KEY"):
    EXIGIDOS.append("api.anthropic.com")
# (www.petronect.com.br saiu de EXIGIDOS: o coletor do portal de compras nao faz
#  parte deste repositorio — nenhum servico daqui depende desse egress.)

# E-MAIL — o transporte e o Microsoft Graph e SO ELE (send.ts:23-25: "sem egress
# para login.microsoftonline.com + graph.microsoft.com nao sai e-mail NENHUM").
# Sem estes dois hosts em EXIGIDOS, o G11 passava VERDE com o firewall bloqueando
# o Graph — o cutover era aprovado e o sistema ficava MUDO, sem nada acusar.
# Condicionado a GRAPH_MAIL_SENDER (mesmo padrao do ANTHROPIC_API_KEY): sem a
# caixa configurada nao ha e-mail para exigir egress.
if os.environ.get("GRAPH_MAIL_SENDER"):
    EXIGIDOS.append("login.microsoftonline.com")  # token client-credentials
    EXIGIDOS.append("graph.microsoft.com")        # sendMail

GATED = {
    # ("smtp" -> SMTP_HOST saiu: o transporte SMTP foi removido do app; o e-mail
    #  nao e mais opcional/gated, e EXIGIDO via Graph — ver EXIGIDOS acima.)
    # Portal da Transparencia Petrobras (valores reais de disputas fechadas) —
    # publico/read-only; so sai egress quando TRANSPARENCIA_ENABLED=1.
    "sistematransparencia.petrobras.com.br": "TRANSPARENCIA_ENABLED",
}


def observed_connections() -> set[str]:
    """Captura PASSIVA (compat): hosts observados em conntrack.txt, se existir
    (uma linha por host:porta, despejada por tcpdump/conntrack na janela de teste)."""
    f = ART / "conntrack.txt"
    if not f.exists():
        return set()
    return {ln.strip().split(":")[0] for ln in f.read_text().splitlines() if ln.strip()}


def probe_results() -> dict:
    """Sonda ATIVA (tests/lib/egress_probe.sh): {"host": {"alcancavel": bool,
    "por_container": {web/bff/worker: bool}}}. Dict vazio = sonda não rodou."""
    f = ART / "egress_probe.json"
    if not f.exists():
        return {}
    try:
        data = json.loads(f.read_text())
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _probe_lookup(probe: dict, host: str) -> dict | None:
    """Entrada da sonda para um host (match exato ou por sufixo — *.upstash.io)."""
    if host in probe:
        return probe[host]
    for h, v in probe.items():
        if h.endswith(host) or host.endswith(h):
            return v
    return None


def run() -> dict:
    observed = observed_connections()
    probe = probe_results()
    result = {"proibidos": {}, "exigidos": {}, "gated": {}, "veredito": "DESCONHECIDO"}

    # ── PROIBIDOS: violação por conntrack OU por sonda ativa alcançável ───────
    proibido_violado = False
    todos_provados_bloqueados = bool(PROIBIDOS)
    for host in PROIBIDOS:
        viol_conntrack = any(host in c for c in observed)
        entrada = _probe_lookup(probe, host)
        provado_bloqueado: bool | None = None
        viol_probe = False
        if entrada is not None:
            por_container = entrada.get("por_container") or {}
            if entrada.get("alcancavel") is True:
                viol_probe = True          # destino proibido CONECTOU de algum container
                provado_bloqueado = False
            elif por_container and all(v is False for v in por_container.values()):
                provado_bloqueado = True   # inalcançável em TODOS os containers sondados
        viol = viol_conntrack or viol_probe
        result["proibidos"][host] = {
            "observado": viol,
            "esperado": False,
            "provado_bloqueado": provado_bloqueado,
        }
        proibido_violado = proibido_violado or viol
        if provado_bloqueado is not True:
            todos_provados_bloqueados = False

    # ── EXIGIDOS: observado (conntrack) > alcancavel (sonda) > nao-verificado ─
    exigido_faltando = False
    for host in EXIGIDOS:
        seen = any(host in c for c in observed)
        entrada = _probe_lookup(probe, host)
        if seen:
            status = "observado"
        elif entrada is not None and entrada.get("alcancavel") is True:
            status = "alcancavel"          # sonda provou que o destino responde
        elif entrada is not None and entrada.get("alcancavel") is False:
            status = "FALTANDO"            # sonda provou que está BLOQUEADO
        elif observed:
            status = "FALTANDO"            # houve captura e o host não apareceu
        else:
            status = "nao-verificado"      # sem captura nem sonda: não dá pra provar
        result["exigidos"][host] = {"status": status}
        if status == "FALTANDO":
            exigido_faltando = True

    for host, env in GATED.items():
        result["gated"][host] = {"env_presente": bool(os.environ.get(env))}

    exigidos_ok = all(v["status"] in ("observado", "alcancavel") for v in result["exigidos"].values())
    if proibido_violado:
        result["veredito"] = "NO-GO (egress proibido observado)"
    elif exigido_faltando:
        result["veredito"] = "NO-GO (egress obrigatório ausente no cenário que o usa)"
    elif todos_provados_bloqueados and exigidos_ok:
        # Prova ATIVA completa: GO mesmo sem conntrack (todos proibidos bloqueados).
        result["veredito"] = "GO (sonda ativa: todos os proibidos provados bloqueados; exigidos alcançáveis)"
    elif not observed and not probe:
        result["veredito"] = "INCONCLUSIVO (sem captura conntrack nem egress_probe — rodar tests/lib/egress_probe.sh)"
    elif observed and exigidos_ok:
        result["veredito"] = "GO (egress conforme contrato)"
    else:
        result["veredito"] = (
            "INCONCLUSIVO (evidência parcial — exigidos não verificados ou "
            "proibidos sem prova de bloqueio)"
        )

    (ART / "egress.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    return result


def _modo_strict() -> bool:
    """INCONCLUSIVO deve falhar? EGRESS_STRICT=1/0 manda; sem ela, CI => strict.

    Em DEV (make test-egress) o INCONCLUSIVO pode ser legítimo (ex.: sonda ainda
    não rodou) => exit 0 com aviso, como sempre foi. Em CI, um INCONCLUSIVO
    silencioso viraria falso GO do pipeline — default strict (a env CI=true é
    setada pelo GitHub Actions e afins). Override explícito: EGRESS_STRICT=0.
    """
    flag = os.environ.get("EGRESS_STRICT", "").strip()
    if flag:
        return flag not in ("0", "false", "no")
    return bool(os.environ.get("CI"))


if __name__ == "__main__":
    out = run()
    print(json.dumps(out, ensure_ascii=False))
    veredito = out["veredito"]
    if veredito.startswith("GO"):
        raise SystemExit(0)
    if veredito.startswith("INCONCLUSIVO"):
        # exit 2 = "sem evidência" (≠ 1 = violação provada), p/ o chamador
        # distinguir. Só propaga em modo strict (CI ou EGRESS_STRICT=1).
        if _modo_strict():
            print("EGRESS_STRICT: veredito INCONCLUSIVO tratado como falha (exit 2).")
            raise SystemExit(2)
        print("AVISO: veredito INCONCLUSIVO (exit 0 em dev; strict no CI ou com EGRESS_STRICT=1).")
        raise SystemExit(0)
    raise SystemExit(1)
