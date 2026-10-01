# Shared setup for the shell scripts: loads deploy.env and checks AWS credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f deploy.env ]]; then set -a; . ./deploy.env; set +a; fi
export SAM_CLI_TELEMETRY=0
export AWS_REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}
STACK_NAME=${STACK_NAME:-oura-mcp}
PARAM_PREFIX=${PARAM_PREFIX:-/oura-mcp}

require_aws() {
  if ! ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null); then
    echo "No usable AWS credentials. Run 'aws login' (or 'aws configure sso' / 'aws configure') and retry." >&2
    exit 1
  fi
}
