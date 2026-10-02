# Runbook

Operating the health MCP backend: the Oura tools, the Apple Health ingest endpoint, and the chat-logged readings. Every command runs from the project folder (`~/oura-mcp`) with AWS credentials for the account that holds the stack, in `us-east-1`.

```bash
cd ~/oura-mcp
aws login --region us-east-1    # if any command says "No usable AWS credentials"
npm ci                          # after a fresh clone
```

## What runs where

| Piece | Where |
|---|---|
| Code, template, docs | this repo |
| Lambda + Function URL | CloudFormation stack `oura-mcp` (us-east-1). Runtime `nodejs24.x`, reserved concurrency 5 (see [Concurrency](#concurrency)) |
| Health readings and workouts | DynamoDB table in stack output `HealthTableName`. Retained if the stack is deleted |
| Secrets | SSM Parameter Store, SecureString, under `/oura-mcp/`: `path-secret`, `ingest-path-secret`, `ingest-key`, `oauth-client`, `tokens`. Never in the repo |
| Settings | `deploy.env` (git-ignored; copy `deploy.env.example`): region, stack name, timezone, reserved concurrency, budget amount and email |
| Budget alert | AWS Budgets, `oura-mcp-monthly-cost` (see [Budget](#budget-alert)) |
| claude.ai connector | claude.ai → Settings → Connectors, URL from `npm run url` |
| Apple Health sync | Health Auto Export on the iPhone, four automations (health metrics and workouts, each for "Previous 7 Days" and "Today"): URL and header from `npm run ingest-url`, settings in [Health Auto Export settings](#health-auto-export-settings) |

## Health checks

```bash
npm test               # offline: 100 tests
npm run smoke          # live: MCP endpoint + one Oura tool
npm run health-smoke   # live: ingest, log/delete, duplicates. Writes test rows dated 2001-02-03 to the PRODUCTION table and deletes them afterwards; skip it when test data must stay out of production
sam logs --stack-name oura-mcp --region us-east-1 --tail
```

`health-smoke` exercises reconciliation with a test clock (the `x-smoke-test-now` header, test data dated before 2010 only). The header is refused unless the stack was deployed with `ALLOW_TEST_CLOCK=true` in `deploy.env`; without it the script runs its other checks and skips those two sections.

In the logs, look for:
- `tool error` lines: tool failures, with their message
- `hae ingest` lines: accepted and skipped counts for each Health Auto Export sync. A Workouts push adds `workouts` (its counts), `workout_types` and `workout_fields`
- `rejected:` lines: failed auth, with the reason (secrets are never logged)

## Redeploy

1. `npm test`
2. `npm run deploy`. It builds with esbuild and deploys with SAM. It never changes existing secrets, and the connector URL stays the same. It doesn't print the URLs, because they contain secrets; see them with `npm run url` and `npm run ingest-url`.
3. `npm run smoke && npm run health-smoke`

A deploy doesn't take the connector offline: Lambda switches to the new code between requests.

**Roll back:** `git switch --detach <last good commit> && npm ci && npm run deploy && git switch main && npm ci`.

**Runtime:** Node.js 24 stays supported until April 2028. When AWS announces a newer Node runtime, change `Runtime:` and `Target:` in `template.yaml`, then run `npm test` and `npm run deploy`.

## Concurrency

The function has **reserved concurrency 5** (`RESERVED_CONCURRENCY` in `deploy.env`; the template's default). That's the most requests it serves at once; one more gets `ReservedFunctionConcurrentInvocationLimitExceeded` (HTTP 429).
- **Why 5:** a chat can make three tool calls at once, and the Health Auto Export automations push every 5 minutes, usually together. At 2, three parallel tool calls always lost one.
- **What it protects:** it caps how much the function can run, and so what it can cost, if the URL is ever hammered. It doesn't cost anything itself.
- **If it still happens:** a throttled Health Auto Export push is simply sent again on the next sync. If chats hit the limit, raise the number in `deploy.env` and run `npm run deploy`. The account must keep 10 unreserved, so the value can go up to the account's Lambda concurrency quota minus 10.
- **Check for throttles:** CloudWatch → Lambda metrics → `Throttles` for the function, or:
  ```bash
  aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Throttles --statistics Sum --period 3600 \
    --dimensions Name=FunctionName,Value=<FunctionName> --start-time <ISO time> --end-time <ISO time>
  ```

## Re-authorize Oura

**When:** a tool answers with a message ending in *"To re-authorize Oura, run `npm run oura-auth`…"*. That means the refresh token was revoked, expired, or used up, or the Oura app's secret changed.

1. `npm run oura-auth`. It reuses the client ID and secret stored in SSM, opens Oura's consent page, and stores a new token pair.
   - If you regenerated the client secret in the Oura developer portal, use `npm run oura-auth -- --new-client`.
   - The app's redirect URI must be exactly `http://localhost:8787/callback`.
2. `npm run smoke`

Nothing else needs to change: the URL, the connector and the Lambda all stay as they are.

**How tokens stay fresh:** the access token lasts 30 days. The Lambda refreshes it 5 minutes before expiry, or after a 401, and writes the new single-use refresh token to `/oura-mcp/tokens` before using it. Refreshes only happen when a tool is called, so something has to call a tool at least every 30 days (a weekly scheduled task does it).

**Temporary errors:** "Could not reach Oura…" is a network problem. Nothing is lost; try again later.

## Rotate a URL secret or the ingest key

Rotate if a URL or key may have leaked: for example, it was pasted into a chat, a screenshot or a log.

```bash
scripts/rotate-secret.sh path-secret --dry-run   # see what would happen
scripts/rotate-secret.sh path-secret             # MCP connector URL
scripts/rotate-secret.sh ingest-path-secret      # Health Auto Export URL
scripts/rotate-secret.sh ingest-key              # Health Auto Export header
```

The script writes a new random value to SSM and recycles the Lambda instances. The old value stops working within seconds. The script never prints the new value; see it with `npm run url` or `npm run ingest-url`.

**After rotating `path-secret`:**
1. In claude.ai → Settings → Connectors, remove the "Oura MCP" connector.
2. Add it again with the new URL from `npm run url`. Leave the OAuth fields empty.
3. Open a new chat or Code session. Existing sessions keep the old connection.
4. Update the URL anywhere else you use it, for example in a scheduled task.

**After rotating `ingest-path-secret` or `ingest-key`:** edit the Health Auto Export automation's URL or `X-Ingest-Key` header with the values from `npm run ingest-url`, then run it manually once. A wrong key shows up in the logs as `rejected: bad or missing X-Ingest-Key`, with the reason.

## Restore health data from point-in-time recovery

Check that recovery is on, and see how far back you can go:

```bash
TABLE=$(aws cloudformation describe-stacks --stack-name oura-mcp --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='HealthTableName'].OutputValue" --output text)
aws dynamodb describe-continuous-backups --table-name "$TABLE" --region us-east-1 \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription'
```

It shows the earliest and latest restorable times, covering up to the last 35 days.

1. **Restore into a new table.** The live table isn't touched.
   ```bash
   aws dynamodb restore-table-to-point-in-time --region us-east-1 \
     --source-table-name "$TABLE" --target-table-name "$TABLE-restore" \
     --restore-date-time 2026-10-15T08:00:00-07:00
   aws dynamodb wait table-exists --table-name "$TABLE-restore" --region us-east-1
   ```
2. **Preview, then copy back into the live table.** The stack keeps using the live table, so no CloudFormation change is needed.
   ```bash
   node scripts/pitr-copy.mjs --from "$TABLE-restore" --to "$TABLE" --prune --dry-run
   node scripts/pitr-copy.mjs --from "$TABLE-restore" --to "$TABLE" --prune
   ```
   - Without `--prune`, restored rows overwrite live rows with the same key, and rows added since then are kept.
   - With `--prune`, rows written after the restore point are deleted too.
3. **Check:** ask for `get_health_metrics` over the affected days, or run `npm run health-smoke`.
4. **Delete the restored copy:** `aws dynamodb delete-table --table-name "$TABLE-restore" --region us-east-1`

**Cost:** a restore is about $0.15 per GB restored. This table is a few MB at most.

## Health Auto Export settings

Four automations in Health Auto Export on the iPhone: two for health metrics and two for workouts. All four use the same URL and header.

**Health metrics.** Two automations, identical except for the name and Date Range:
- **"Claude MCP":** Date Range "Previous 7 Days". That's the 7 days *before* today and never includes today (confirmed from production pushes on 2026-09-29). It does the backfill and reconciles the six full days inside its window.
- **"Claude MCP Today":** Date Range "Today". Today's entries arrive the same day. "Today" pushes are idempotent and reconcile today's rows, so an entry edited or deleted today is retired the same day.

Both use these settings:

| Setting | Value |
|---|---|
| Type | REST API |
| URL | the `URL:` line from `npm run ingest-url` |
| Headers | `X-Ingest-Key` = the value on the `Header:` line |
| Data Type | Health Metrics: Weight, Waist Circumference, Body Fat Percentage, Lean Body Mass, Blood Pressure, Blood Glucose, Protein, Carbohydrates, **Fiber**, Total Fat, Dietary Energy. Fiber is required: net carbs from 2026-09-29 15:44 PT on are carbs − fiber (see the README's *Net carbs*). Saturated Fat is ignored if selected. Select only metrics that have data in Apple Health |
| Export Format / Version | JSON / Version 2 |
| Summarize Data | Off. It would average individual readings; the server adds up nutrition itself |
| Date Range | Previous 7 Days, or Today for the second automation |
| Sync cadence | every 5 minutes |
| Batch Requests | **Off.** One request per push, so a push is the complete window. A 7-day push is about 15 KB; the limit is 1 MB |

**Workouts.** Two more automations, again identical except for the name and Date Range ("Previous 7 Days" and "Today"), with the same URL and `X-Ingest-Key` header:

| Setting | Value |
|---|---|
| Type | REST API |
| Data Type | **Workouts** |
| Export Format / Version | JSON / Version 2 |
| Include Route Data | Off. Routes aren't used and make the payload large |
| Include Workout Metrics | On, with Time Grouping (Workout Metrics) set to **Minutes**. The per-minute series are where the recording app's name comes from; grouping by seconds can push a week of workouts past the 1 MB limit |
| Date Range | Previous 7 Days, or Today for the second automation |
| Sync cadence | every 5 minutes |
| Batch Requests | **Off** |

What the server reads from a workout, and how it picks `source`, is in the README under *Apple Health ingest → Workouts*. After the first Workouts push, check the `hae ingest` log line: `workout_fields` lists the fields the payload really carried, and the first payload is logged once, redacted, as `hae first workout payload`.

**Why re-sending 7 days every 5 minutes is safe:**
- Each sample is stored under its time plus a fingerprint of its source app, values and unit, so a re-sent sample lands on the same row.
- Samples already stored unchanged aren't written again.
- Different samples with the same timestamp stay separate rows.
- The log line `hae ingest` shows `rows_written` / `rows_unchanged` and how many samples each metric carried.

**Deleted and edited samples.** HealthKit samples can't be changed: when an app edits an entry, it deletes the sample and writes a new one, and the payload carries no sample ID. So the server reconciles each push against what's stored. It never deletes anything; it only marks rows.

A stored Apple Health sample that's missing from a push:
1. First gets `missing_since`. It still counts.
2. Becomes `superseded_at` if a push **at least 15 minutes later** still doesn't contain it. From then on, `get_health_metrics` ignores it.
3. Loses both marks if any later push contains it again.

So a correction takes **two pushes at least 15 minutes apart**: "Today" pushes for today's entries, "Previous 7 Days" pushes for earlier days. Until the second one arrives, the old reading shows next to its replacement (and a replaced food entry is counted twice). Pushes can be hours apart when the phone is locked or Health Auto Export isn't running in the background, and the wait is that long. If an old reading is still showing after a correction, check before removing it by hand:
- Does the row have `missing_since`? Then it's already waiting for the second push.
- When did the last push for that day arrive? Look for `hae ingest` lines with `period` "Today" (for today) or "Previous 7 Days" (for earlier days).

Reconciliation only runs when a push is known to be complete:
- **Only** for pushes whose `automation-period` header is "Previous 7 Days" or "Today". That's why Batch Requests has to be off.
- **Only** for Apple Health rows. Chat readings are never touched.
- **Only** for metrics with at least one accepted sample in that push. A metric missing or empty because a HealthKit query failed (for example error 6 while the phone is locked) is left alone.
- **"Previous 7 Days":** only for the six full days strictly inside the window. The oldest day may be partial, and today isn't in it.
- **"Today":** only for today's rows, and only while the phone is in the server's time zone (`USER_TZ`). In another time zone the phone's "today" starts at a different midnight, so the push would look partial; it's stored but not reconciled, and the log line carries `reconcile_note`. The next "Previous 7 Days" push picks the day up.
- **Workouts** follow the same rules, but the more-than-half check below covers the whole window (the six days, or today) instead of each day. A day usually holds one workout, so a per-day check could never retire a deleted one. A push with no workouts at all is never reconciled, so deleting the only workout in the window isn't picked up until another workout is in it.
- **Not** for a metric-day where more than half its samples would be newly marked in one push. That's logged as `hae reconcile skipped`. Rows an earlier push already marked `missing_since` aren't counted, so several rounds of edits to the same day don't add up to "more than half". A consequence: deleting *all* of a day's entries isn't picked up automatically. That includes a weekly weigh-in or BP reading deleted with no replacement (a correction *is* picked up: the old and new sample make 1 of 2, not more than half). Remove those with `delete_reading` (below).

Each `hae ingest` log line shows `rows_written`, `rows_unchanged`, `marked_missing`, `superseded` and `restored`. It also shows how many samples each metric carried (`metrics`) and which sample fields arrived (`sample_fields`), so partial locked-phone pushes, or a sample ID HAE might add later, would show up. **Review these after a week of 5-minute pushes** before deciding whether superseded rows older than 30 days can be hard-deleted.

**Removing a reading by hand.** In chat, ask Claude to remove the reading; it uses `delete_reading`:
- **Chat readings** (source `claude-log`) are deleted.
- **Apple Health readings** are marked removed (`superseded_at`, with `superseded_by: "chat"`) and stop counting in `get_health_metrics`.
  - The reading is still in Apple Health, so **delete it there first**. Otherwise the next Health Auto Export push sends it again and clears the mark.
  - `undo: true` restores a removed Apple Health reading. Chat readings can't be restored; log them again.
- **Identifying the reading:** give its metric and time. To the minute is enough (`get_health_metrics` shows HH:MM). If several readings share that minute, also give the value. Food entries only show as daily totals, so give the entry's time and amount.

To inspect rows directly, list that day's rows for a metric. The `superseded_at` column shows removed ones. `delete-item` is a permanent last resort; prefer `delete_reading`, which can be undone:

```bash
aws dynamodb query --table-name "$TABLE" --region us-east-1 \
  --key-condition-expression 'metric = :m AND begins_with(ts, :d)' \
  --expression-attribute-values '{":m":{"S":"protein"},":d":{"S":"2026-10-01"}}' \
  --query 'Items[].[ts.S,value.N,source.S,recorded_at.S,superseded_at.S]' --output text
aws dynamodb delete-item --table-name "$TABLE" --region us-east-1 \
  --key '{"metric":{"S":"protein"},"ts":{"S":"<full ts from the list>"}}'
```

The `ts` dates are UTC, so a Pacific evening sample can appear under the next day's date. `$TABLE` is set as in [Restore](#restore-health-data-from-point-in-time-recovery).

## Budget alert

- **Where:** AWS console → Billing and Cost Management → Budgets → **`oura-mcp-monthly-cost`**.
- **Covers:** all AWS spend in the account, including your other workloads, not just this stack.
- **Alerts:** email to `BUDGET_EMAIL` when actual spend passes 50% or 100% of the budget, or when forecast spend passes 100%.
- **Defined in:** `template.yaml` (resource `CostBudget`). The amount (`BUDGET_LIMIT_USD`) and email are in `deploy.env`.
- **To change it:** edit `deploy.env`, then run `npm run deploy`. Don't edit the budget in the console, because the next deploy would overwrite it.

## Tear down

1. `sam delete --stack-name oura-mcp --region us-east-1` removes everything except the health table.
2. `aws ssm delete-parameters --names /oura-mcp/path-secret /oura-mcp/ingest-path-secret /oura-mcp/ingest-key /oura-mcp/oauth-client /oura-mcp/tokens --region us-east-1`
3. Delete the table only if you no longer want the data.
4. Remove the claude.ai connector, and the Health Auto Export automation.
