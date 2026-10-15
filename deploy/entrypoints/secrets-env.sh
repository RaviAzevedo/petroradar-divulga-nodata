#!/bin/sh
# =============================================================================
# deploy/entrypoints/secrets-env.sh — wrapper de entrypoint p/ Docker secrets (G7)
# =============================================================================
# As imagens web/bff/worker leem process.env/os.environ e NAO suportam a
# convencao *_FILE. Este wrapper fecha o gap SEM mudar codigo de app:
#   para TODA env "<VAR>_FILE=<path>" cujo <path> exista e seja legivel,
#   exporta <VAR>=$(conteudo do arquivo) e entao `exec "$@"` (o CMD original).
#
# Montado read-only pelos servicos no docker-compose.secrets.yml:
#   entrypoint: ["/bin/sh", "/secrets-env.sh"]
#   command:    <CMD original da imagem — o override de entrypoint LIMPA o CMD>
#
# POSIX sh (funciona em busybox/ash do node:alpine, dash do python:slim e
# bash do playwright/jammy). O $(cat) descarta \n final — desejavel p/ segredo.
# =============================================================================
set -eu

for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*_FILE\)=.*/\1/p'); do
  target="${name%_FILE}"
  file="$(eval "printf '%s' \"\${$name}\"")"
  [ -n "${file}" ] && [ -r "${file}" ] || continue
  export "${target}"="$(cat "${file}")"
done

exec "$@"
