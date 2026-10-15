#!/usr/bin/env bash
# =============================================================================
# deploy/gen-cert.sh — gera um certificado TLS para o NGINX da borda.
# =============================================================================
# O nginx/conf.d/petro-radar.conf (server 443) exige .crt/.key. Em produção o
# IDEAL é um cert emitido pela CA interna da Proponente. Este script é o FALLBACK
# self-signed p/ subir o pitstop sem depender da PKI (troque depois pelo da CA).
#
# Saída (default): nginx/certs/petro-radar.crt + petro-radar.key
# Uso:  deploy/gen-cert.sh [--cn=radar.example.local] [--days=825] [--out=DIR]
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${HERE}/.." && pwd)"
CN="radar.example.local"; DAYS="825"; OUT="${REPO_DIR}/nginx/certs"
for arg in "$@"; do
  case "$arg" in
    --cn=*)   CN="${arg#--cn=}" ;;
    --days=*) DAYS="${arg#--days=}" ;;
    --out=*)  OUT="${arg#--out=}" ;;
    -h|--help) grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 1 ;;
  esac
done
mkdir -p "${OUT}"
CRT="${OUT}/petro-radar.crt"; KEY="${OUT}/petro-radar.key"
if [[ -s "${CRT}" && -s "${KEY}" ]]; then
  echo ">> cert ja existe em ${OUT} (nao sobrescrevo). Remova p/ regenerar."; exit 0
fi
echo ">> gerando cert self-signed p/ CN=${CN} (validade ${DAYS}d) ..."
# Usa openssl do host se houver; senao via container alpine/openssl.
if command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey rsa:2048 -nodes -days "${DAYS}" \
    -keyout "${KEY}" -out "${CRT}" \
    -subj "/C=BR/O=Proponente/CN=${CN}" \
    -addext "subjectAltName=DNS:${CN}"
else
  docker run --rm -v "${OUT}:/c" alpine/openssl:latest req -x509 -newkey rsa:2048 -nodes -days "${DAYS}" \
    -keyout "/c/petro-radar.key" -out "/c/petro-radar.crt" \
    -subj "/C=BR/O=Proponente/CN=${CN}" -addext "subjectAltName=DNS:${CN}"
fi
chmod 600 "${KEY}" 2>/dev/null || true
echo ">> OK: ${CRT} + ${KEY}"
echo ">> Monte-os no nginx (ssl_certificate/ssl_certificate_key apontam p/ /etc/nginx/certs/)."
echo ">> PRODUCAO: substitua pelo certificado emitido pela CA interna da Proponente."
