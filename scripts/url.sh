#!/usr/bin/env bash
# Prints endpoints that contain credentials:
#   url.sh          MCP endpoint <FunctionUrl>mcp/<path-secret> (the claude.ai connector URL)
#   url.sh ingest   Apple Health ingest URL and the X-Ingest-Key header for Health Auto Export
source "$(dirname "$0")/common.sh"
require_aws

param() { aws ssm get-parameter --name "$PARAM_PREFIX/$1" --with-decryption --query Parameter.Value --output text; }
base=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text)

if [[ ${1:-} == ingest ]]; then
  echo "URL:    ${base%/}/ingest/$(param ingest-path-secret)"
  echo "Header: X-Ingest-Key: $(param ingest-key)"
else
  echo "${base%/}/mcp/$(param path-secret)"
fi
