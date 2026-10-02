#!/usr/bin/env bash
# Builds and deploys the stack. Creates any missing secrets in SSM first.
source "$(dirname "$0")/common.sh"
require_aws

BUDGET_EMAIL=${BUDGET_EMAIL:?Set BUDGET_EMAIL in deploy.env}
BUDGET_LIMIT_USD=${BUDGET_LIMIT_USD:-1}
USER_TZ=${USER_TZ:-$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')}
USER_TZ=${USER_TZ:-UTC}
RESERVED=${RESERVED_CONCURRENCY:-5}
echo "Deploying stack '$STACK_NAME' to account $ACCOUNT_ID in $AWS_REGION (timezone $USER_TZ)"

# Lambda must keep at least 10 unreserved concurrency. Brand-new accounts often start with a
# quota of 10 in total, which makes ANY reservation impossible until the quota is raised.
# get-account-settings can briefly report a stale value, so trust the lower of it and Service Quotas.
LIMIT=$(aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions --output text)
QUOTA=$(aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 \
  --query 'Quota.Value' --output text 2>/dev/null || echo "$LIMIT")
QUOTA=${QUOTA%.*}
(( QUOTA < LIMIT )) && LIMIT=$QUOTA
if (( RESERVED > 0 && LIMIT - RESERVED < 10 )); then
  cat >&2 <<EOF

WARNING: this account's Lambda concurrency quota is $LIMIT, and Lambda keeps 10 unreserved,
so reserved concurrency $RESERVED cannot be applied yet. Deploying WITHOUT a reservation for now
(the account-wide quota of $LIMIT still caps it). Ask for the default quota (free), then re-run:
  aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 1000

EOF
  RESERVED=0
fi

# Random secrets: 64 URL-safe chars (384 bits) each, created once. Written via a 0600 temp file
# so they never appear in the process list. Existing values are never changed.
ensure_secret() {
  local name=$PARAM_PREFIX/$1 description=$2 tmp secret
  if aws ssm get-parameter --name "$name" --query Parameter.Name --output text >/dev/null 2>&1; then return; fi
  echo "Creating $name (SecureString)"
  tmp=$(mktemp)
  secret=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
  printf '{"Name":"%s","Type":"SecureString","Value":"%s","Description":"%s"}' "$name" "$secret" "$description" >"$tmp"
  unset secret
  aws ssm put-parameter --cli-input-json "file://$tmp" >/dev/null || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
}
ensure_secret path-secret 'MCP endpoint URL path secret'
ensure_secret ingest-path-secret 'Apple Health ingest URL path secret'
ensure_secret ingest-key 'Apple Health ingest X-Ingest-Key header value'

# A first deploy that failed leaves the stack in ROLLBACK_COMPLETE (no resources), which
# CloudFormation cannot update. Remove it so this run can create it fresh.
status=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)
if [[ $status == ROLLBACK_COMPLETE ]]; then
  echo "Removing empty stack left by a failed first deploy ($status)"
  aws cloudformation delete-stack --stack-name "$STACK_NAME"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
fi

PATH="$PWD/node_modules/.bin:$PATH" sam build
sam deploy \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ParamPrefix=$PARAM_PREFIX" \
    "UserTimezone=$USER_TZ" \
    "ReservedConcurrency=$RESERVED" \
    "BudgetEmail=$BUDGET_EMAIL" \
    "BudgetLimitUsd=$BUDGET_LIMIT_USD" \
    "AllowTestClock=${ALLOW_TEST_CLOCK:-false}"

# The endpoints contain secrets, so they are not printed here (deploy output ends up in terminal
# scrollback, chat transcripts and CI logs).
echo
echo "Deployed. To see the endpoints (they contain secrets):"
echo "  npm run url          # claude.ai connector URL"
echo "  npm run ingest-url   # Health Auto Export URL and X-Ingest-Key header"
if ! aws ssm get-parameter --name "$PARAM_PREFIX/tokens" --query Parameter.Name --output text >/dev/null 2>&1; then
  echo
  echo "Next: connect your Oura account with 'npm run oura-auth'."
fi
