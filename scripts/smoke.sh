#!/usr/bin/env bash
# curl test against the deployed server: auth rejection, initialize, tools/list, prompts/list, one Oura
# tool call, and read-only calls to the two health-table tools. It writes nothing.
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

echo "== prompts/list (one prompt per tool, except get_report_data)"
tools_file=$(mktemp)
trap 'rm -f "$tools_file"' EXIT
rpc '{"jsonrpc":"2.0","id":5,"method":"tools/list"}' > "$tools_file"
rpc '{"jsonrpc":"2.0","id":6,"method":"prompts/list"}' \
  | TOOLS_FILE=$tools_file node -e '
      const fs = require("fs");
      const prompts = JSON.parse(fs.readFileSync(0)).result.prompts;
      // get_report_data serves the report page and has no prompt on purpose.
      const tools = JSON.parse(fs.readFileSync(process.env.TOOLS_FILE)).result.tools.map((t) => t.name).filter((n) => n !== "get_report_data").sort();
      for (const p of prompts) console.log(" -", p.name, "(" + (p.arguments ?? []).map((a) => a.name + (a.required ? "*" : "")).join(", ") + ")");
      const names = prompts.map((p) => p.name).sort();
      if (JSON.stringify(names) !== JSON.stringify(tools)) { console.log("MISMATCH: tools", tools.join(","), "prompts", names.join(",")); process.exit(1) }
      console.log(names.length + " prompts, one per tool except get_report_data")'

echo "== tools/call get_sleep (last 3 days)"
start=$(date -v-2d +%F 2>/dev/null || date -d '2 days ago' +%F)
rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_sleep\",\"arguments\":{\"start_date\":\"$start\"}}}" \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0)).result; const t=r.content[0].text; if (r.isError) { console.log("TOOL ERROR:", t); process.exit(1) } console.log(JSON.stringify(JSON.parse(t), null, 1))'

# The health table, read-only: counts only, so no readings end up in the terminal scrollback.
for name in get_health_metrics get_workouts get_report_data; do
  echo "== tools/call $name (last 3 days, counts only)"
  args="{\"start_date\":\"$start\"}"
  [[ $name == get_health_metrics ]] && args="{\"metric\":\"all\",\"start_date\":\"$start\"}"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}" \
    | node -e '
        const r = JSON.parse(require("fs").readFileSync(0)).result; const t = r.content[0].text;
        if (r.isError) { console.log("TOOL ERROR:", t); process.exit(1) }
        const d = JSON.parse(t);
        const count = (s) => s?.error ? { error: s.error.message.slice(0, 80) } : { days: (s.days ?? s.rows).length, ...(s.workouts ? { workouts: s.workouts.length } : {}) };
        if (!d.health) { console.log(JSON.stringify({ range: d.range, ...count(d) })); process.exit(0) }
        const sections = Object.fromEntries(["health", "sleep", "activity", "readiness", "workouts"].map((k) => [k, count(d[k])]));
        console.log(JSON.stringify({ range: d.range, bytes: t.length, ...sections }));
        if (Object.values(sections).some((s) => s.error)) process.exit(1)'
done
