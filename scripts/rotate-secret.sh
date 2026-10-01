#!/usr/bin/env bash
# Rotates one of the URL/header secrets and makes running Lambda instances pick it up.
#   scripts/rotate-secret.sh path-secret           # MCP connector URL (then update claude.ai)
#   scripts/rotate-secret.sh ingest-path-secret    # Health Auto Export URL (then update HAE)
#   scripts/rotate-secret.sh ingest-key            # Health Auto Export X-Ingest-Key header
#   add --dry-run to print what would happen without changing anything.
# The old value stops working as soon as the new instances start (a few seconds).
# New values are never printed here; see them locally with `npm run url` / `npm run ingest-url`.
source "$(dirname "$0")/common.sh"
require_aws

name=${1:-}
dry=${2:-}
case "$name" in
  path-secret | ingest-path-secret | ingest-key) ;;
  *) echo "usage: $0 path-secret|ingest-path-secret|ingest-key [--dry-run]" >&2; exit 2 ;;
esac
param="$PARAM_PREFIX/$name"
fn=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text)
desc=$(aws lambda get-function-configuration --function-name "$fn" --query Description --output text)

if [[ $dry == --dry-run ]]; then
  echo "Would overwrite $param with a new random 64-character value,"
  echo "then briefly change the description of $fn so every instance reloads it, and restore it."
  exit 0
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
secret=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
printf '{"Name":"%s","Type":"SecureString","Value":"%s","Overwrite":true}' "$param" "$secret" >"$tmp"
unset secret
aws ssm put-parameter --cli-input-json "file://$tmp" >/dev/null
echo "Rotated $param."

# Instances cache secrets for their lifetime; any configuration change replaces them. The
# description is set back afterwards so the stack does not drift from the template.
aws lambda update-function-configuration --function-name "$fn" --description "$desc (rotated $(date +%s))" >/dev/null
aws lambda wait function-updated-v2 --function-name "$fn"
aws lambda update-function-configuration --function-name "$fn" --description "$desc" >/dev/null
aws lambda wait function-updated-v2 --function-name "$fn"
echo "Lambda instances recycled; the old value no longer works."
echo
case "$name" in
  path-secret)
    echo "Next: run 'npm run url' and put that URL in claude.ai (Settings > Connectors: remove the Oura connector, add it again)." ;;
  ingest-path-secret)
    echo "Next: run 'npm run ingest-url' and replace the URL in the Health Auto Export automation." ;;
  ingest-key)
    echo "Next: run 'npm run ingest-url' and replace the X-Ingest-Key header value in the Health Auto Export automation." ;;
esac
