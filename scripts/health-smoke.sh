#!/usr/bin/env bash
# curl tests for the health backend against the deployed stack. Uses clearly fake data dated
# 2001-02-03 and deletes all of it at the end (even on failure), including the one-time
# "first payload" marker if this run created it, so your first real HAE sync still gets logged.
source "$(dirname "$0")/common.sh"
require_aws

MCP=$(./scripts/url.sh)
ingest_info=$(./scripts/url.sh ingest)
INGEST_URL=$(sed -n 's/^URL: *//p' <<<"$ingest_info")
INGEST_KEY=$(sed -n 's/^Header: X-Ingest-Key: //p' <<<"$ingest_info")
TABLE=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='HealthTableName'].OutputValue" --output text)
MARKER='{"metric":{"S":"_meta"},"ts":{"S":"hae-first-payload-logged"}}'
marker_existed=$(aws dynamodb get-item --table-name "$TABLE" --key "$MARKER" --query 'Item.metric.S' --output text)

failures=0
check() { # label, json, JS condition over r (JSON-RPC result or ingest body) and t (tool text)
  if node -e '
    const r = JSON.parse(process.argv[1]); const res = r.result ?? r;
    const text = res.content?.[0]?.text; let t = text; try { t = JSON.parse(text) } catch {}
    process.exit(eval(process.argv[2]) ? 0 : 1)' "$2" "$3"; then
    echo "  PASS  $1"
  else
    echo "  FAIL  $1"; echo "        $2" | cut -c1-400; failures=$((failures + 1))
  fi
}
# MCP tools/call over curl (a 2025-era client gets one SSE event; print just its JSON).
tool() {
  curl -sS "$MCP" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | sed -n -e 's/^data: //' -e '/^{/p'
}

cleanup() {
  # Every row on the test day, whatever its key suffix.
  for metric in weight bp glucose ketones protein; do
    aws dynamodb query --table-name "$TABLE" --key-condition-expression 'metric = :m AND begins_with(ts, :d)' \
      --expression-attribute-values "{\":m\":{\"S\":\"$metric\"},\":d\":{\"S\":\"2001-02-03\"}}" \
      --query 'Items[].ts.S' --output text | tr '\t' '\n' | grep . | while read -r ts; do
      aws dynamodb delete-item --table-name "$TABLE" --key "{\"metric\":{\"S\":\"$metric\"},\"ts\":{\"S\":\"$ts\"}}"
    done
  done
  if [[ $marker_existed == None ]]; then aws dynamodb delete-item --table-name "$TABLE" --key "$MARKER"; fi
  echo "== cleanup: test rows removed"
}
trap cleanup EXIT

echo "== 1. HAE ingest: weight, BP, glucose, two protein entries at the same second + one Oura sample (skipped)"
payload=$(cat <<'JSON'
{"data": {"metrics": [
  {"name": "weight_body_mass", "units": "lb", "data": [
    {"date": "2001-02-03 06:55:00 -0800", "qty": 180.4, "source": "Test Scale"},
    {"date": "2001-02-03 07:10:00 -0800", "qty": 181.0, "source": "Oura"}]},
  {"name": "blood_pressure", "units": "mmHg", "data": [
    {"date": "2001-02-03 06:58:00 -0800", "systolic": 121, "diastolic": 79, "source": "Test BP Cuff"}]},
  {"name": "blood_glucose", "units": "mg/dL", "data": [
    {"date": "2001-02-03 07:00:00 -0800", "qty": 100, "source": "Test Meter"}]},
  {"name": "protein", "units": "g", "data": [
    {"date": "2001-02-03 12:30:00 -0800", "qty": 42, "source": "Test Food Log"},
    {"date": "2001-02-03 12:30:00 -0800", "qty": 18, "source": "Test Food Log"}]}
]}}
JSON
)
ingest() { curl -sS -X POST "$INGEST_URL" -H 'Content-Type: application/json' -H "X-Ingest-Key: $INGEST_KEY" --data "$payload"; }
res=$(ingest)
echo "  $res"
check "5 accepted and written, Oura sample skipped" "$res" 'r.accepted === 5 && r.rows_written === 5 && r.skipped === 1 && r.skipped_reasons.oura_source === 1'
res=$(ingest)
check "re-sending the same payload writes nothing (5 unchanged)" "$res" 'r.rows_written === 0 && r.rows_unchanged === 5'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INGEST_URL" -H 'Content-Type: application/json' -H 'X-Ingest-Key: wrong' -d '{}')
check "wrong X-Ingest-Key is refused (HTTP $code)" '{}' "'$code' === '401'"

echo "== 2. log_reading: glucose 5 minutes after the Apple Health one, and ketones"
res=$(tool log_reading '{"metric":"glucose","value":102,"unit":"mg/dL","timestamp":"2001-02-03T07:05","context":"fasting","note":"curl test"}')
check "glucose stored" "$res" 't.stored.value === 102 && t.stored.source === "claude-log" && t.stored.timestamp === "2001-02-03T07:05:00-08:00"'
res=$(tool log_reading '{"metric":"ketones","value":1.4,"unit":"mmol/L","timestamp":"2001-02-03T07:06"}')
check "ketones stored" "$res" 't.stored.value === 1.4 && t.stored.unit === "mmol/L"'

echo "== 3. out-of-range and wrong-unit readings are rejected, not written"
res=$(tool log_reading '{"metric":"glucose","value":750,"unit":"mg/dL","timestamp":"2001-02-03T09:00"}')
echo "  $(node -e 'console.log(JSON.parse(process.argv[1]).result.content[0].text)' "$res")"
check "glucose 750 rejected" "$res" 'res.isError === true && /outside the accepted range/.test(text)'
res=$(tool log_reading '{"metric":"ketones","value":1.2,"unit":"mg/dL","timestamp":"2001-02-03T09:00"}')
check "ketones in mg/dL rejected" "$res" 'res.isError === true && /must be reported in mmol\/L/.test(text)'

echo "== 4. duplicate glucose (Apple Health 07:00 = 100, chat 07:05 = 102) is returned once"
res=$(tool get_health_metrics '{"metric":"glucose","start_date":"2001-02-03","end_date":"2001-02-03"}')
echo "  $(node -e 'console.log(JSON.parse(process.argv[1]).result.content[0].text)' "$res")"
check "one glucose reading, the claude-log one" "$res" \
  't.days[0].glucose.length === 1 && t.days[0].glucose[0].source === "claude-log" && /hidden as duplicates/.test(t.notes[0])'

echo "== 5. get_health_metrics all"
res=$(tool get_health_metrics '{"metric":"all","start_date":"2001-02-03","end_date":"2001-02-03"}')
echo "  $(node -e 'console.log(JSON.parse(process.argv[1]).result.content[0].text)' "$res")"
check "weight, bp, glucose, ketones, and both same-second protein entries counted (60 g)" "$res" \
  'const d = t.days[0]; d.weight[0].value === 180.4 && d.bp[0].systolic === 121 && d.glucose.length === 1 && d.ketones[0].value === 1.4 && d.protein_g === 60'

echo "== 6. delete_reading: chat readings are deleted, Apple Health readings are marked removed"
glucose_day() { tool get_health_metrics '{"metric":"glucose","start_date":"2001-02-03","end_date":"2001-02-03"}'; }
res=$(tool delete_reading '{"metric":"glucose","timestamp":"2001-02-03T07:05:00-08:00"}')
check "chat reading deleted" "$res" 't.deleted.value === 102'
res=$(glucose_day)
check "the Apple Health reading shows again (no chat reading hides it now)" "$res" 't.days[0].glucose[0].source === "Test Meter"'
res=$(tool delete_reading '{"metric":"glucose","timestamp":"2001-02-03T07:00"}')
echo "  $(node -e 'console.log(JSON.parse(process.argv[1]).result.content[0].text)' "$res" | cut -c1-230)"
check "Apple Health reading (found to the minute) marked removed, with the delete-it-in-Apple-Health note" "$res" \
  't.removed.value === 100 && /delete it there first/.test(t.note)'
res=$(glucose_day)
check "removed reading no longer counts" "$res" '!t.days.length || !t.days[0].glucose'
res=$(tool delete_reading '{"metric":"glucose","timestamp":"2001-02-03T07:00","undo":true}')
check "undo restores it" "$res" 't.restored.value === 100'
res=$(tool delete_reading '{"metric":"glucose","timestamp":"2001-02-03T07:00"}')
res=$(ingest)
check "removed again, then a push that still contains it clears the mark" "$res" 'r.restored === 1'
res=$(glucose_day)
check "so it counts again (delete it in Apple Health first for the mark to stick)" "$res" 't.days[0].glucose[0].value === 100'

echo "== 7. reconciliation: an edit (the 18 g entry is replaced by 20 g in the food app)"
# Full "Previous 7 Days" pushes at a fake 2001 clock (the server only accepts x-smoke-test-now
# before 2010), so 2001-02-03 is a full day inside the window and no real data is involved.
push() {
  curl -sS -X POST "$INGEST_URL" -H 'Content-Type: application/json' -H "X-Ingest-Key: $INGEST_KEY" \
    -H 'automation-period: Previous 7 Days' -H "x-smoke-test-now: $2" --data "$1"
}
metrics_day() {
  tool get_health_metrics "{\"metric\":\"$1\",\"start_date\":\"2001-02-03\",\"end_date\":\"2001-02-03\"}"
}
edited=${payload/\"qty\": 18,/\"qty\": 20,}
res=$(push "$edited" 2001-02-06T12:00:00-08:00)
if [[ $res == *"test clock is off"* ]]; then
  echo "  SKIP  sections 7 and 8 need the test clock: set ALLOW_TEST_CLOCK=true in deploy.env and redeploy"
  echo
  if (( failures )); then echo "$failures check(s) FAILED"; exit 1; fi
  echo "All other checks passed."
  exit 0
fi
check "first push after the edit: new 20 g written, old 18 g marked missing (not superseded yet)" "$res" \
  'r.reconcile === "on" && r.rows_written === 1 && r.marked_missing === 1 && r.superseded === 0'
res=$(push "$edited" 2001-02-06T12:16:00-08:00)
check "16 minutes later, still missing: 18 g superseded" "$res" 'r.superseded === 1'
res=$(metrics_day protein)
check "protein for the day is 62 g (42 + 20), the replaced 18 g is ignored" "$res" 't.days[0].protein_g === 62'

echo "== 8. reconciliation: a push with a metric missing marks nothing"
res=$(push '{"data":{"metrics":[{"name":"weight_body_mass","units":"lb","data":[{"date":"2001-02-03 06:55:00 -0800","qty":180.4,"source":"Test Scale"}]}]}}' 2001-02-06T12:40:00-08:00)
check "protein left out of the push: nothing marked" "$res" 'r.marked_missing === 0 && r.superseded === 0 && r.rows_unchanged === 1'
res=$(push '{"data":{"metrics":[{"name":"protein","units":"g","data":[]}]}}' 2001-02-06T13:00:00-08:00)
check "protein present but empty (a failed HealthKit query): nothing marked" "$res" 'r.marked_missing === 0 && r.superseded === 0'
res=$(metrics_day protein)
check "protein still 62 g" "$res" 't.days[0].protein_g === 62'

echo
if (( failures )); then echo "$failures check(s) FAILED"; exit 1; fi
echo "All checks passed."
