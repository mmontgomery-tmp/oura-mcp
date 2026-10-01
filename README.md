# Personal health MCP backend on AWS Lambda

One Lambda Function URL serves two things:
- **An MCP server for claude.ai.** It has read-only Oura Ring tools, plus tools to log, delete and read home health readings.
- **An ingest endpoint for Apple Health data,** sent by the iPhone app Health Auto Export (HAE).

Health readings from both paths share one DynamoDB table.

```
claude.ai ──POST /mcp/<path-secret>──────┐      Health Auto Export (iPhone)
                                         │        │ POST /ingest/<ingest-path-secret>
                                         ▼        ▼   + header X-Ingest-Key
                  Lambda (Node 24, arm64, 256 MB, reserved concurrency 2)
                  @modelcontextprotocol/server v2, stateless Streamable HTTP
                     │                    │                          │
      SSM Parameter Store (SecureString)  │ api.ouraring.com         DynamoDB (on-demand)
      /oura-mcp/path-secret               │ (OAuth2)                 PK metric, SK ts
      /oura-mcp/ingest-path-secret        │                          weight bp glucose ketones
      /oura-mcp/ingest-key                │                          protein carbs fat calories
      /oura-mcp/oauth-client              │
      /oura-mcp/tokens  ◀── rotated Oura refresh token written back here
```

Operating it (redeploy, re-authorizing Oura, rotating secrets, restores, the budget alert) is covered in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Tools

Tools that take a date range accept optional `start_date` and `end_date` (`YYYY-MM-DD`, inclusive). By default they cover the last 7 days in `USER_TZ` (America/Los_Angeles). `end_date` defaults to today even when only `start_date` is given.

### Oura (read-only)

Each tool returns `{range, rows, days_without_data, notes?}`, one compact row per day. It never returns raw Oura JSON.

| Tool | Max range | Row fields |
|---|---|---|
| `get_sleep` | 92 days | `sleep_score, total_sleep_h, time_in_bed_h, deep_h, rem_h, light_h, efficiency_pct, bedtime, wake_time, resting_hr_bpm, avg_hrv_ms, avg_breath_rpm, breathing_disturbance_index, spo2_avg_pct, nap_h` |
| `get_heart_rate` | 31 days | `resting_hr_bpm, avg_hrv_ms, avg_hr_bpm, min_hr_bpm, max_hr_bpm, avg_awake_hr_bpm, avg_sleep_hr_bpm, max_workout_hr_bpm, samples` |
| `get_readiness` | 92 days | `readiness_score, temp_deviation_c, temp_trend_deviation_c, resting_hr_bpm, avg_hrv_ms` |
| `get_activity` | 92 days | `activity_score, steps, active_kcal, total_kcal, walking_equiv_km, high/medium/low_activity_min, sedentary_h, non_wear_h` |

How the Oura fields are defined:
- Sleep metrics belong to the day you woke up.
- `resting_hr_bpm` is the lowest 5-minute average during the night's main sleep, which is what the Oura app shows.
- `avg_hrv_ms` is the average HRV of that main sleep.
- Heart-rate samples arrive in UTC and are grouped into days in `USER_TZ`.

### Health readings

**`log_reading(metric, value, unit, timestamp?, context?, note?)`**
- Saves a home glucose or ketone reading you report in chat. The tool description tells the model to call it whenever you report one.
- `metric` is `glucose` or `ketones`.
- `unit` must be exactly `mg/dL` for glucose or `mmol/L` for ketones.
- Allowed ranges are glucose 20–600 mg/dL and ketones 0–10 mmol/L, inclusive. A wrong unit, an out-of-range value or a future time returns an error and **nothing is written**.
- `timestamp` defaults to now. A time without an offset, such as `2026-09-27T07:30`, is read as Los Angeles time.
- `context` is `fasting`, `post-meal` or `other`. `note` is optional, up to 200 characters.
- Saved with `source: "claude-log"`. It returns the stored row, including the exact `timestamp` that `delete_reading` needs.
- It refuses to overwrite an Apple Health reading stored at the exact same second.

**`delete_reading(metric, timestamp, value?, undo?)`**
- **Identifies a reading** by metric and time: the exact timestamp, or to the minute (e.g. `2026-10-05T07:02`, local time). If several readings share that minute, `value` picks one; otherwise the tool lists them and changes nothing.
- **Chat readings** (`claude-log`) are deleted.
- **Apple Health readings** are marked removed (`superseded_at`, `superseded_by: "chat"`) and stop counting. The reply reminds you to delete the reading in Apple Health first, because a later push that still contains it clears the mark.
- **`undo: true`** restores a removed Apple Health reading.

**`get_health_metrics(metric, start_date?, end_date?)`**
- `metric` is one of `weight bp glucose ketones protein carbs fiber fat calories`, or `all`. `carbs` always returns **net carbs** (see *Net carbs* below). The range can be up to 92 days.
- Returns `{range, timezone, days, days_without_data, notes?}`. Each day has:
  - `protein_g`, `carbs_g` (net carbs), `total_carbs_g`, `fiber_g`, `fat_g` and `calories_kcal` as daily sums, plus `warnings` when net carbs had to be clamped or some fiber wasn't subtracted
  - `weight`, `bp`, `glucose` and `ketones` as lists of readings `{time, value | systolic+diastolic, unit, context?, source, note?, timestamp?}`
- `timestamp` appears on `claude-log` readings. Apple Health readings show `time` (HH:MM), which is enough for `delete_reading`.
- **Duplicates:** an Apple Health reading and a `claude-log` reading of the same metric, within 15 minutes and within 5% of each other (both systolic and diastolic for BP), count as one reading.
  - Only the `claude-log` one is returned, and a note says how many were hidden.
  - Each reading pairs with at most one other, closest in time first. Neither row is deleted.
- Responses are capped at 1,000 readings, with a note if any were left out.

### Prompts

Tools never appear in a chat's menus; Claude calls them itself. So the server also publishes a **prompt** for each of the 7 tools, under the same name. Clients list these as ready-made commands:
- **claude.ai chats:** the message box's "+" menu → Connectors → this connector.
- **Claude Code:** `/mcp__<connector>__<name>`.

| Prompt | Arguments | What it does |
|---|---|---|
| `get_sleep`, `get_heart_rate`, `get_readiness`, `get_activity` | `range` | Runs the same query as the tool and attaches the data, with instructions to show it as a table |
| `get_health_metrics` | `metric`, `range` | Same, for Apple Health and chat readings |
| `log_reading` | `metric`*, `value`*, `time`, `context`, `note` | Pre-fills a request; Claude then saves the reading with the tool |
| `delete_reading` | `metric`, `timestamp` | Pre-fills a request to remove a reading, or asks you to pick one from the last 7 days |

\* required

- **`range`** takes `7d` / `30d` / `90d`, `YYYY-MM-DD`, or `YYYY-MM-DD YYYY-MM-DD`. It defaults to the last 7 days.
- **Write prompts never write.** Fetching a prompt never changes data; the actual save or delete goes through the tool.

### Net carbs

`carbs_g` always means net carbs. The switchover is set in one place, `NET_CARBS_SWITCHOVER` in [src/health.ts](src/health.ts): **2026-09-29 15:44 Pacific**. Each sample is judged by its own timestamp, not by when it arrived.

- **Before the switchover,** carbs were edited to net in Cal AI before reaching Apple Health's Carbohydrates. They count as-is, and fiber samples are ignored.
- **From the switchover on,** Carbohydrates is total carbs and net carbs = carbs − fiber.
  - Cal AI writes all of a food entry's nutrients with the same timestamp. So a fiber sample is subtracted only when a carbs sample has the same second and source app.
  - Fiber with no matching carbs isn't subtracted: it's logged and listed in the day's `warnings`. That way an entry with fiber but no carbs can't pull the total down.
- **A day never goes below 0 net carbs.** A clamp adds a warning.
- **`total_carbs_g` and `fiber_g`** count only samples from the switchover on, and are omitted for days entirely before it. So on the switchover day, `carbs_g` can be more than `total_carbs_g − fiber_g`: it also includes the net carbs entered earlier that day.

## Health data table

On-demand DynamoDB, `PK = metric`, `SK = ts`. It's named in the stack output `HealthTableName`.

- **`ts`** starts with the reading's time as ISO 8601 in UTC, to the second, e.g. `2026-09-27T14:30:00Z`.
  - UTC keeps keys sorting chronologically across DST changes and across readings sent with different offsets.
  - **Chat readings** use just that time. `delete_reading` finds them by it.
  - **Apple Health samples** add `#` and a 12-character fingerprint of the sample's source app, values and unit as sent, e.g. `2026-09-27T14:30:00Z#0ac0a6ff8250`. So:
    - a re-sent sample always lands on the same key, and ingest is safe to repeat;
    - different samples at the same second (another value, another app) get separate rows;
    - exact duplicates within one request get `~1`, `~2`, and so on.
  - The original timestamp, with its offset, is kept in `recorded_at`.
- **Each row stores:**
  - `value`, or `systolic` + `diastolic` for BP, in the normalized unit
  - `unit`
  - `original_value` (or `original_systolic` / `original_diastolic`) and `original_unit`
  - `source`: the recording app, or `claude-log`
  - `via`: `hae` or `chat`
  - optional `context` and `note`
  - `recorded_at` and `ingested_at`
- **Normalized units:**
  - weight `lb`
  - bp `mmHg`
  - glucose `mg/dL` (mmol/L from Apple Health is × 18.016)
  - ketones `mmol/L`
  - protein, carbs, fiber and fat `g`
  - calories `kcal` (kJ is ÷ 4.184)
- **Retained on stack delete.** The table has `DeletionPolicy: Retain`, so readings you logged in chat survive a teardown.
- **One bookkeeping row.** `metric = _meta`, `ts = hae-first-payload-logged` records that the first Health Auto Export payload has been logged. No tool ever reads it.
- **Permissions:** the Lambda can only `Query`, `PutItem`, `DeleteItem` and `BatchWriteItem` on this table.

## Apple Health ingest (Health Auto Export)

`POST <FunctionUrl>ingest/<ingest-path-secret>` with the header `X-Ingest-Key: <ingest-key>`. Run `npm run ingest-url` to print both.

- **Auth:** a wrong path gets a 404, and a missing or wrong key gets a 401. Both secrets are separate from the MCP secret.
- **Format:** HAE's JSON: `{"data": {"metrics": [{"name", "units", "data": [{"date", "qty" | "systolic"+"diastolic", "source", "metadata"?}]}]}}`. Dates look like `2026-09-27 07:30:00 -0700`. The shape and metric names were checked against HAE's reference server ([HealthyApps/health-auto-export-server](https://github.com/HealthyApps/health-auto-export-server)).
- **Accepted metrics:** `weight_body_mass`, `blood_pressure`, `blood_glucose`, `protein`, `carbohydrates`, `fiber`, `total_fat` (stored as `fat`) and `dietary_energy`.
  - Everything else (for example `saturated_fat`, which the automation also sends) is skipped and listed in `ignored_metrics`. A malformed metric entry never fails the request.
  - The log line records each metric's unit as sent (`units`).
- **Oura samples dropped:** any sample whose `source` contains "Oura" (in any case) is dropped.
- **`source`:** set to the sample's original app, e.g. "OMRON connect".
- **Meal timing:** if HAE passes through HealthKit's glucose meal time and it says "after meal", `context` becomes `post-meal`.
- **Same-timestamp samples:** Apple Health often stamps several food entries with the same time. Each sample is stored as its own row (see `ts` above), and the daily totals add them up.
- **Re-sends:** samples already stored unchanged aren't written again. The reply counts them as `rows_unchanged`.
- **Deleted or edited samples:** on full "Previous 7 Days" and "Today" pushes, a stored sample that disappears is marked `missing_since`, then `superseded_at` if a push 15 or more minutes later still lacks it. "Today" pushes cover today's rows, so same-day edits are retired the same day. `get_health_metrics` ignores superseded rows, and nothing is ever deleted. The guard rules are in [docs/RUNBOOK.md](docs/RUNBOOK.md#health-auto-export-settings).
- **Size limit:** bodies over 1 MB are rejected with a 413, also after gzip decompression.
- **Response:** HTTP 200 with the counts, e.g. `{"accepted":4,"skipped":1,"skipped_reasons":{"oura_source":1},"rows_written":1,"rows_unchanged":3}`. `ignored_metrics` lists any unsupported metric names that were sent. The log line also records how many samples each metric carried and the automation's period.
- **First payload:** it is logged once, redacted (every number becomes `"<number>"`, and only 2 samples per metric are kept). Find it in CloudWatch with `sam logs --stack-name oura-mcp --filter 'hae first payload'`. To log another one, delete the bookkeeping row: `aws dynamodb delete-item --table-name <HealthTableName> --key '{"metric":{"S":"_meta"},"ts":{"S":"hae-first-payload-logged"}}'`.

### Health Auto Export settings

The full settings, and what happens to samples deleted in Apple Health, are in [docs/RUNBOOK.md → Health Auto Export settings](docs/RUNBOOK.md#health-auto-export-settings). In short: REST API automations sending JSON Version 2, with Summarize Data OFF and Batch Requests OFF:
- one re-sends the **Previous 7 Days** every 5 minutes. That's the 7 days *before* today; it never includes today.
- a second sends **Today** every 5 minutes, so today's entries arrive the same day, and entries edited or deleted today are reconciled the same day.

## Setup

1. **Log in to AWS.** Use `aws login`, `aws configure sso`, or `aws configure`.
2. **Deploy.** Run `npm install`, then `npm run deploy`.
   - First copy `deploy.env.example` to `deploy.env` and fill it in: region, budget email and amount, timezone and reserved concurrency. `deploy.env` is git-ignored.
   - The deploy creates any missing secrets (`path-secret`, `ingest-path-secret`, `ingest-key`), builds with esbuild and deploys the stack.
   - It doesn't print the connector or ingest URLs, because they contain secrets. Run `npm run url` and `npm run ingest-url` to see them.
3. **Register an Oura app.** Create it at <https://cloud.ouraring.com/oauth/applications> (or on the newer developer portal) with redirect URI `http://localhost:8787/callback`.
4. **Connect Oura.** Run `npm run oura-auth`. It stores the client credentials and the first token pair in SSM.
5. **Add the connector in claude.ai.** Go to Settings → Connectors → Add custom connector. Paste the output of `npm run url` and leave the OAuth fields empty.
6. **Set up Health Auto Export** as described above.

## Secrets (SSM SecureString, AWS-managed `aws/ssm` key)

| Parameter | Used for |
|---|---|
| `/oura-mcp/path-secret` | Path segment of the MCP URL (`/mcp/<secret>`) |
| `/oura-mcp/ingest-path-secret` | Path segment of the ingest URL (`/ingest/<secret>`) |
| `/oura-mcp/ingest-key` | Value of the `X-Ingest-Key` header on ingest |
| `/oura-mcp/oauth-client` | Oura client ID and secret |
| `/oura-mcp/tokens` | Oura access and refresh tokens; the Lambda rewrites them on each rotation |

## Refresh-token rotation (Oura)

Oura refresh tokens are single-use. The token manager in [src/tokens.ts](src/tokens.ts) handles this as follows:
- It refreshes 5 minutes before expiry, or after a 401.
- It re-reads SSM first, in case another instance has already rotated the tokens.
- It writes the new pair to SSM *before* using it.
- On `invalid_grant`, it polls SSM for the pair the winning instance saved.
- If the SSM write fails, it keeps the new pair in memory and retries the write.

Refreshes go to the token endpoint that issued the grant (`moi.ouraring.com` for current apps). If Oura revokes the grant, the tools tell you to run `npm run oura-auth`.

## Tests

- **`npm test`** runs offline: 86 tests, using the official MCP client against the Lambda handler through a fake Function URL.
  - **Oura:** the tools, both protocol eras, and refresh-token rotation, with a fake Oura that enforces single-use refresh tokens.
  - **Ingest:** HAE parsing, unit conversion, Oura filtering, auth, the 413/415/400 responses, gzip and redaction.
  - **Health tools:** `log_reading` validation, the duplicate rule, and `delete_reading` (deleting chat readings; removing, undoing and re-sending Apple Health readings; ambiguous minutes). An in-memory store applies the same conditions as DynamoDB.
  - **Fat:** `total_fat` stored as `fat` (g, mg), unknown units and malformed metrics skipped, re-sends, reconciliation, `fat_g` sums, delete and undo.
  - **Connector:** `subscriptions/listen` refused at once (it used to hang the Lambda until the runtime exited).
  - **Re-sends and reconciliation:** stable sample keys, separate same-second samples, skip-unchanged, the 15-minute two-push rule, un-marking, the more-than-half skip, window edges, and metrics that are missing, empty or Oura-only.
- **`npm run smoke`** runs curl tests of the MCP endpoint and one Oura tool against the deployed stack.
- **`npm run health-smoke`** runs curl tests of the health backend against the deployed stack. It covers:
  - an HAE ingest with one weight, one BP, one glucose and one protein sample, plus one Oura-sourced sample that must be skipped
  - `log_reading` for glucose and ketones
  - out-of-range and wrong-unit readings being rejected
  - an HAE glucose and a chat glucose 5 minutes apart coming back once
  - two food entries at the same second both stored, and a re-sent payload writing nothing
  - an edited entry: the old sample is marked missing, then superseded 16 minutes later, and the day's total ignores it
  - a push with a metric missing, or present but empty, marking nothing
  - `get_health_metrics` for `all`
  - `delete_reading`: a chat reading deleted; an Apple Health reading marked removed, undone, removed again, then restored by a push that still contains it

  It uses fake data dated 2001-02-03 and deletes it afterwards.

## Cost

- **Lambda, SSM, KMS (`aws/ssm`) and CloudWatch Logs** stay within always-free limits, as before. Logs are kept for 14 days.
- **DynamoDB on-demand** isn't covered by the always-free tier, which applies to provisioned capacity. At personal volumes it costs fractions of a cent a month, since writes cost well under $1 per million and storage is under 25 GB free.

The account-wide **monthly AWS Budget** (`BUDGET_LIMIT_USD` in `deploy.env`) emails `BUDGET_EMAIL` at 50% and 100% of actual spend, and at 100% of forecast spend. Change the amount there and re-run `npm run deploy`.

## Operations

- **Logs:** `sam logs --stack-name oura-mcp --tail`. URL secrets, the ingest key and tokens are never logged.
- **Rotate a URL secret or the ingest key:**
  1. Delete the parameter and re-run `npm run deploy`. A new value is generated.
  2. Force new Lambda instances with `aws lambda update-function-configuration --function-name <FunctionName> --description "rotated $(date +%s)"`. Set the description back afterwards so the stack stays in sync.
  3. Update the claude.ai connector or the HAE automation.
- **Tear down:**
  1. `sam delete --stack-name oura-mcp` removes everything except the health table, which is retained on purpose.
  2. Remove the secrets: `aws ssm delete-parameters --names /oura-mcp/path-secret /oura-mcp/ingest-path-secret /oura-mcp/ingest-key /oura-mcp/oauth-client /oura-mcp/tokens`.
  3. Delete the table yourself only if you no longer want the data.

## Licence and security

MIT; see [LICENSE](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
