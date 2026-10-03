# Decision log

Why this project is built the way it is, and what is still undecided.

**How to use it**
- Add an entry for every decision that changes behavior, cost or security, in the same commit as the change.
- Entries are numbered in order and never rewritten. To change a decision, add a new entry and mark the old one "Superseded by D-0xx".
- An open question gets an `O-` number. When it is settled, move it to the decisions with the next `D-` number and note which question it closed.
- Keep it free of personal data, like the rest of this repository.

## Open questions

| ID | Question | Raised | Next step |
|---|---|---|---|
| O-1 | Do workouts and the body measurements (waist, body fat, lean mass) arrive from Health Auto Export the way the documentation says? Units, the workout `source`, and whether the workout `id` is stable across pushes are unconfirmed. | 2026-10-02 | Check the `hae ingest` log lines and the redacted first workout payload once real data has arrived; planned for 2026-10-06. |
| O-2 | Should superseded rows older than some age be deleted for good? Today nothing is ever deleted. | 2026-09-28 | Review a week of `hae ingest` log lines (around 2026-10-06) for partial pushes and for a sample ID in the payload, then decide. The table is tiny, so there is no pressure. |
| O-3 | Should the net-carbs switchover instant move from `src/health.ts` to `deploy.env`? It is a fact about one deployment, hard-coded in shared code. | 2026-10-01 | Decide before anyone else deploys this. |
| O-4 | How should glucose and ketone meter readings be ingested from the MyMojoHealth (Keto-Mojo) API: webhook plus a 15-minute safety poll on a separate function, or poll only? | 2026-09-29 | Blocked on whether the OAuth client has the `refresh_token` grant; without it the token cannot be renewed unattended. |
| O-5 | When can the local copy of the pre-publication history be removed? It duplicates the private archive repository. | 2026-10-01 | Remove it once the archive has been relied on at least once. |

## Deferred

| ID | Decision | Date | Revisit when |
|---|---|---|---|
| D-014 | **No CloudWatch alarms for now.** The account-wide budget alert is the only alert. Function errors, throttles and refused pushes are visible in the logs and metrics but nobody is notified. | 2026-10-02 | The project is opened to other users, or a failure goes unnoticed for more than a day. |

## Decisions

### D-001 · Secrets in the URL path, stored only in SSM · 2026-09-27
The MCP endpoint and the ingest endpoint are each protected by a 64-character random secret in the URL path (plus a header key for ingest), kept in SSM Parameter Store. No OAuth on the connector.
**Why:** one user, and both clients (claude.ai custom connectors and Health Auto Export) can send a fixed URL and header. It avoids running an authorization server.
**Cost of it:** the URLs are credentials and must be treated like passwords; anyone who learns the hostname can occupy the function's concurrency.

### D-002 · Reconciliation marks rows and never deletes them · 2026-09-28
A stored Apple Health sample missing from a complete push is marked `missing_since`, then `superseded_at` once a push at least 15 minutes later still lacks it. A sample that comes back loses both marks. A metric-day where more than half the samples would be marked in one push is skipped.
**Why:** the payload has no sample ID, so "gone" can only be inferred. A locked phone produces partial pushes, and a wrong inference must be reversible.

### D-003 · Keep the two-push rule · 2026-09-30
A missing row is not retired on the first push, even when the same push delivers an obvious replacement.
**Why:** the delay is at most one sync interval when pushes are flowing, and the rule is the main protection against partial pushes. Rejected alternative: retire at once when a new sample for the same metric and day arrives in the same push.

### D-004 · Reconcile "Today" pushes too · 2026-09-30
"Today" pushes are reconciled for today's rows with the same rules. Rows already marked missing by an earlier push do not count towards the more-than-half guard. A "Today" push from a phone in another time zone is stored but not reconciled.
**Why:** an app that edits an entry rewrites it as a new sample, so several edits in one day piled up stale rows that tripped the guard the next morning.

### D-005 · Net carbs are carbs minus matching fiber, from a switchover instant · 2026-09-29
`carbs_g` always means net carbs. Before the switchover, carbs were entered as net and count as-is. From it on, fiber is subtracted only when a carbs sample has the same second and source, and a day never goes below zero.
**Why:** matching by sample keeps a fiber-only entry from pulling a day's total down. See O-3 for where the instant lives.

### D-006 · A public code repository with nothing personal in it · 2026-10-01
The repository holds code, tests and operating documentation only. Deploy settings, maintainer notes and task instructions live in a separate private repository. Tests use invented values, never real readings.
**Why:** health data and identifiers must not be published, and git history cannot be cleaned after the fact.

### D-007 · Reserved concurrency 5 · 2026-10-02
Raised from 2.
**Why:** a chat can make three tool calls at once, and the phone's automations push together every 5 minutes. At 2, three parallel calls always lost one. The reservation still caps how much the function can run if the URL is abused.

### D-008 · Workouts: keyed by id, guarded over the whole window · 2026-10-02
Workouts are stored under their start time plus a fingerprint of the Health Auto Export `id`, so a workout whose numbers change is updated in place. They reconcile like other samples, except that the more-than-half guard covers the whole window rather than each day. `source` comes from the samples inside the workout's series, because the documented format has none on the workout itself. Workouts whose source contains "Oura" are dropped.
**Why:** a day usually holds one workout, so a per-day guard could never retire a deleted one. See O-1: none of this has been checked against a real payload yet.

### D-009 · Body fat of 1 or less is a fraction · 2026-10-02
A body-fat value of 1 or below is multiplied by 100, whatever the unit label says.
**Why:** HealthKit stores body fat as a fraction and nobody's body fat is 1% or less, so the two cannot be confused. See O-1.

### D-010 · Ingest limit 6 MB, function memory 512 MB · 2026-10-02
The ingest size limit is Lambda's own 6,291,456-byte request limit, for the raw body and for a gzip body after inflating. Memory went from 256 MB to 512 MB.
**Why:** AWS refuses anything larger before the function runs, so a lower limit in code only refused pushes AWS would have delivered. A maximum-size push in which every sample is accepted peaks about 110 MB above a 125–165 MB baseline, which does not fit in 256 MB.

### D-011 · No live test writes to the real table · 2026-10-02
Removed `npm run health-smoke`, which wrote dated test rows to the production table, and the test-only clock header in the ingest endpoint that existed for it. `npm run smoke` is read-only and now also calls the two health-table tools.
**Why:** the offline tests cover the same logic on an in-memory store, and test-only code in the production path is a liability. Supersedes the earlier choice to gate the header behind a deploy flag.

### D-012 · `delete_reading` also removes workouts · 2026-10-02
`metric: "workout"` with the workout's start time marks it removed, and `undo: true` restores it. No separate tool.
**Why:** the behavior and the caveat are identical to removing an Apple Health reading (delete it in Apple Health first, or the next push restores it), and a deleted workout that was the only one in the window is never retired automatically.

### D-013 · Tests run on GitHub Actions · 2026-10-02
A workflow runs the type check and `npm test` on every push and pull request. Actions are pinned to commit hashes and the workflow token is read-only.
**Why:** tests only ran on one laptop, so nothing checked a push or a dependency update.

### D-015 · One read-only call for the report page · 2026-10-02
`get_report_data(start_date?, end_date?)` returns `{range, timezone, health, sleep, activity, readiness, workouts}`, each section exactly the payload of the matching tool for the same range. It runs the sections in parallel inside one invocation, fetches Oura's sleep periods once for both sleep and readiness, and returns `{error: {message}}` for a failing section instead of failing the call. The range is up to 366 days. It has no MCP prompt, and its description tells chats to keep using the individual tools.
**Why:** the Weekly Oura Summary page made five calls per load, two at a time, each a separate round trip through claude.ai and a separate Lambda invocation, and three of five measured page loads hit a cold start. One call pays for one invocation and at most one cold start. The table was not the bottleneck: `get_health_metrics` already runs its per-metric queries in parallel, so the table and its keys are unchanged.
**Cost of it:** a second way to read the same data, kept in step by tests that compare each section with its tool. A 366-day response is about 300 KB.
