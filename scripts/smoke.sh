#!/usr/bin/env bash
# curl test against the deployed server: auth rejection, initialize, tools/list, one tool call.
# Usage: npm run smoke [-- <mcp-url>]
source "$(dirname "$0")/common.sh"
URL=${1:-$(./scripts/url.sh)}
BASE=${URL%/mcp/*}

# 2025-era clients (like this curl) get a one-event SSE body; print just the JSON.
rpc() {
  curl -sS --fail-with-body "$URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$1" | sed -n -e 's/^data: //' -e '/^{/p'
}

echo "== wrong secret must be 404"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp/not-the-secret" -H 'Content-Type: application/json' -d '{}')
echo "HTTP $code"; [[ $code == 404 ]]

echo "== initialize"
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0)).result; console.log(r.serverInfo, r.protocolVersion)'

echo "== tools/list"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node -e 'for (const t of JSON.parse(require("fs").readFileSync(0)).result.tools) console.log(" -", t.name)'

echo "== tools/call get_sleep (last 3 days)"
start=$(date -v-2d +%F 2>/dev/null || date -d '2 days ago' +%F)
rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_sleep\",\"arguments\":{\"start_date\":\"$start\"}}}" \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0)).result; const t=r.content[0].text; if (r.isError) { console.log("TOOL ERROR:", t); process.exit(1) } console.log(JSON.stringify(JSON.parse(t), null, 1))'
