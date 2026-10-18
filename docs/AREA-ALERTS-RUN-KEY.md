# Area-alerts runner: who may start a run

Written 2026-10-18 (endpoint audit, security flag 10).

## What changed, in plain words

`area-alerts-run` is the job that emailed saved map-area alerts. Its 6-hour schedule was removed on 2026-10-13. A
scheduled function cannot be called by URL (Netlify only runs it on its schedule), but an unscheduled one can:
anyone who knew the address `/.netlify/functions/area-alerts-run` could start a run. Today every run stops by itself
(paused while listings come from Lofty, and held until `AREA_ALERTS_APPROVED_BY` names an approver), but once an
approver is named an outsider could start runs whenever they liked.

Now a run needs one of:

1. **The run key**, for a run started by hand: header `x-area-alerts-key` equal to the Netlify setting
   `AREA_ALERTS_RUN_KEY`. Compared in constant time (SHA-256 of both sides, `crypto.timingSafeEqual`).
2. **Netlify's own scheduled run** (a JSON body with `next_run`), and only while `RUNS_ON_SCHEDULE` is `true` in
   `netlify/functions/area-alerts-run.js`. It is `false`, because there is no schedule. That body alone proves
   nothing (anyone can send it to a public address), so it counts only while the function is scheduled, which is
   exactly when Netlify refuses URL calls to it. `tests/test-area-alerts-run-auth.js` fails when that constant and
   `netlify.toml` disagree.

| Setting | Default | Meaning |
|---|---|---|
| `AREA_ALERTS_RUN_KEY` | unset | Unset, blank or shorter than 16 characters: every call is refused with 503 ("AREA_ALERTS_RUN_KEY is not set on this site, so this run is off"). Set: a call without the exact key in `x-area-alerts-key` gets 401 "unauthorized". |

## What it never does

- A refused call reads nothing (no Blobs store, no listings, no alerts) and sends nothing.
- The key's value never appears in an answer or a log line, only the header's name.
- It does not turn anything on. Even with the right key, a run still stops at every gate it had before: the Lofty
  pause, IDX display and listing freshness, and the approver hold. Nothing is emailed unless
  `AREA_ALERTS_APPROVED_BY` names an approver and the hub accepts it.
- No shared file changed (`_lofty.js`, `_lofty-consent.js`, `_notify.js`, `_form-plans.js`, `_hub-intake.js`).

## To turn on

Nothing needs turning on: the refusal is the default, and with no key set nobody can start a run (today nothing is
sent anyway). Only if Christine wants to start a run by hand:

1. Make a long random key (32+ characters) in a password manager.
2. Netlify → signaturepropertycollection → Site configuration → Environment variables → Add a variable →
   `AREA_ALERTS_RUN_KEY` = the key → Save. Redeploy (Deploys → Trigger deploy → Deploy site).
3. Start a run: `curl -X POST -H "x-area-alerts-key: <the key>" https://signaturepropertycollection.com/.netlify/functions/area-alerts-run`.

To put the schedule back (Christine's decision; only once listings come from the whole market and she has named the
approver): add the `[functions."area-alerts-run"]` schedule to `netlify.toml` **and** set `RUNS_ON_SCHEDULE = true` in
`area-alerts-run.js` in the same pull request. The test fails if only one of the two is changed.

## To turn off

Delete `AREA_ALERTS_RUN_KEY` in Netlify and redeploy: every call is refused again (503).

## How it was tested

`tests/test-area-alerts-run-auth.js` (in `tests/run-all.sh`, no network, Blobs and the hub stubbed):

- Key unset, blank or under 16 characters: 503 for every call, including one carrying a key or a scheduled-run
  body; nothing read, nothing fetched.
- Key set: no event, no headers, no key header, a wrong key, one character short or long, the key only in the query
  string or in another header, and a scheduled-run body (plain or base64) are all 401; nothing read or fetched; the
  key never in the answer or the log.
- The right key (header name in any case, surrounding spaces ignored) reaches the run's own gates, which still stop
  it (paused on Lofty listings; stale listing data).
- `RUNS_ON_SCHEDULE` is false and matches `netlify.toml`; with it true, Netlify's body (plain or base64) gets in and
  anything else still needs the key.
- The compare is `crypto.timingSafeEqual` over SHA-256 digests, the gate is the first thing the handler does.

The three suites that already ran the job (`test-area-alerts-hold.js`, `test-idxdisplay.js`,
`test-lofty-source.js`) now pass a made-up key so they keep testing the gates after this one.
