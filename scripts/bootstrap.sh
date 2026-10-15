#!/bin/sh
# =============================================================================
# Petro Radar — bootstrap on-premise (MinIO buckets)
# =============================================================================
# Uso:
#   scripts/bootstrap.sh minio   -> cria bucket + service account no MinIO (mc)
# O servico 'createbuckets' do compose chama com arg 'minio'.
# Idempotente: ignora "ja existe".
#
# NOTA: o Elasticsearch foi REMOVIDO da stack em 2026-07-02 (a busca usa o
# Postgres). Este script cuida apenas do MinIO.
# =============================================================================
set -eu

TARGET="${1:-minio}"

# -----------------------------------------------------------------------------
bootstrap_minio() {
  echo "[bootstrap] MinIO: configurando bucket e service account..."
  : "${MINIO_ROOT_USER:?defina MINIO_ROOT_USER}"
  : "${MINIO_ROOT_PASSWORD:?defina MINIO_ROOT_PASSWORD}"
  BUCKET="${R2_BUCKET:-petro-radar}"
  APP_KEY="${R2_ACCESS_KEY_ID:-petro-radar-app}"
  APP_SECRET="${R2_SECRET_ACCESS_KEY:?defina R2_SECRET_ACCESS_KEY}"
  ENDPOINT="http://minio:9000"

  # Alias admin com as credenciais ROOT.
  mc alias set local "$ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

  # Bucket PRIVADO + versionamento (retencao/auditoria LGPD de DFP/PPU/habilitacao).
  mc mb --ignore-existing "local/${BUCKET}"
  mc version enable "local/${BUCKET}" || true
  mc anonymous set none "local/${BUCKET}"   # garante que NAO ha acesso publico

  # Service account de MENOR PRIVILEGIO p/ o backend (so este bucket).
  cat > /tmp/petro-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${BUCKET}","arn:aws:s3:::${BUCKET}/*"]
    }
  ]
}
EOF
  # Cria a access key dedicada (idempotente: ignora se ja existe).
  mc admin user svcacct add local "$MINIO_ROOT_USER" \
      --access-key "$APP_KEY" \
      --secret-key "$APP_SECRET" \
      --policy /tmp/petro-policy.json 2>/dev/null \
    || echo "[bootstrap] service account '${APP_KEY}' ja existe — ok."

  echo "[bootstrap] MinIO pronto: bucket='${BUCKET}', service account='${APP_KEY}'."
}

# -----------------------------------------------------------------------------
case "$TARGET" in
  minio) bootstrap_minio ;;
  *)     echo "uso: $0 {minio}"; exit 1 ;;
esac

echo "[bootstrap] concluido (${TARGET})."
