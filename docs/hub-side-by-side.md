# The side-by-side check with the hub (off by default)

Written 2026-10-23, after Christine: "it's very important that we don't lose anything at all since everything is
completely integrated." Before any of this site's work moves onto the Seller Intelligence hub, the site keeps doing
exactly what it does today with its own connection **and** asks the hub the same question, compares the two answers
field by field, and records one row per comparison in the hub's ledger. Christine reads the hub's report
(`GET /v1/parity/report`) and decides; nothing here switches anything over. The whole contract is in Seller
Intelligence's `docs/hub-parity-compare.md`.

**It is off.** Nothing runs until `HUB_SIDE_BY_SIDE` is set. Off, no hub call is made, nothing is wrapped and nothing
extra is read: the site behaves byte for byte as before (`tests/test-hub-side-by-side.js` proves it).

## The two settings (names only)

| Setting | Where | What it does |
|---|---|---|
| `HUB_SIDE_BY_SIDE` | Netlify environment (the form handler, the 30-minute sync); GitHub repository variable (the town-figures workflow) | A comma-separated list of the areas to compare: `lofty_write`, `mls_read` (also `lofty_read`, `rentcast`, which this site has nothing for yet). Trimmed, any case. Unset, empty or nothing known = off. An unknown entry is ignored and logged once by name. |
| `HUB_SIDE_BY_SIDE_MAX` | the same places | Comparisons per run (the 30-minute sync, the town-figures job) or per hour (the form handler, counted per warm function instance). Default 20, at most 200. |

It uses the hub settings the site already has: `HUB_API_URL` and `HUB_API_KEY` (the town-figures workflow on the main
site passes its secret `HUB_APP_KEY` under that name). The code is `netlify/functions/lib/_hub-side-by-side.js`,
byte-identical in both website repos, through the vendored toolkit (`lib/suite-kit`, 0.5.2: `compareRecords`,
`parityKey`, `parityRow`, the hub client's `{ dryRun: true }`).

## What is compared

| Area / operation | Where it runs | This site's own answer | The hub's answer |
|---|---|---|---|
| `lofty_write` / `lead` | the form handler (`submission-created.js`), both sites | every Lofty write the handler sends for the submission (create, note, texting, trigger-tag re-fire, website fields, search wishes), captured exactly as sent and passed on unchanged | `POST /v1/lofty/lead` with `dry_run: true`, asked **before** the site's own lookup and create, alongside them: the person, source, the form's tags (`tags`), the same tags in the create body except "Hot Lead - Website" (`create_tags`), the note, the plan's lead type, the home's address, the four website fields and the search wishes |
| `lofty_write` / `task` | the form handler, a contact found by email | the Call task and the push to her phone | `POST /v1/lofty/task` with `dry_run: true`, asked right after the site's lookup |
| `mls_read` / `on_market` | the 30-minute sync (Signature only) | the confirmer's verdict for each of her Lofty listings | the hub's copy for the same listing (one `POST /v1/mls/search` with every id) |
| `mls_read` / `listing` | the 30-minute sync (Signature only) | the stored record in the MLS Grid copy (her listings first, then a different slice each half hour) | the hub's row put through the very same mapping (`mapListing`, the stored photo fields kept, `slimForStorage`) |
| `mls_read` / `town_market` | `.github/workflows/town-market.yml`, both sites | `build/data/town_market.json` as the workflow just produced it | `GET /v1/market/towns` |

The fields, by name (a row lists only names):

- **lead, a new contact:** `outcome`, `create.first_name`, `create.last_name`, `create.emails`, `create.phones`,
  `create.source`, `create.cannot_text`, `create.lead_types`, `create.notes`, `create.property.street` / `city` /
  `state` / `zip`, `create.assigned_user`, `tags_on_lead` (the form's tags the lead ends with), `tags_fired` (the
  ones added after the create, which start a "Tag Added" plan), `note`, `notes_other`, `texting_on`, `texting_off`,
  `fields.website_form` (and the other three website fields), `team_fields_created`, `inquiry`.
- **lead, a returning contact:** `outcome`, `lead_id` (the same lead?), `match_by`, `email_kept`, `phone_kept`,
  `address_kept`, `tags_on_lead`, `note`, `notes_other`, `texting_on`, `texting_off`.
- **lead, held, or the two sides disagree on new / returning / held:** `outcome`, `hold_reason`.
- **task:** `outcome`, `hold_reason`, `type`, `content`, `assigned_role`, `due_minutes` (within 2), `time_zone`,
  `lead_id`, `push`.
- **on_market:** `present`, `on_market`, `status`.
- **listing:** `present`, `withheld`, `listing_key`, `status`, `price`, `beds`, `baths`, `sqft`, `address`, `city`,
  `state`, `zip`, `property_type`, `subdivision`, `waterfront`, `equestrian`, `agent_name`, `co_agent_name`,
  `remarks`, `county`, `mlg_can_view`, `photo_count` (the MLS's photo count, where this site stores one).
- **town_market:** `present`, `active`, `median_list`, `median_price_per_sqft`.

Not compared, and why (each is in the code's comments too): the new lead's and task's ids (a dry run shows
stand-ins); Lofty folding a create into another lead, a write Lofty refuses, a read-back that differs (a dry run
assumes every write lands); the tags inside the create body (what counts is which tags the lead ends with and which
fire); the form's nurture-plan tag (on the hub path a second push after the create, which a dry run cannot plan for a
lead it only planned to create; both add it only to a contact they created, and `outcome` compares that); the SMS
consent tag (`texting_on` covers it). A listing whose two copies are different versions (the ModificationTimestamps
differ) is not compared field by field: the hub's older = `hub_not_ready`, this site's older = `skipped`; town figures
from different days the same way.

## Never in the way

- The site's own Lofty, MLS Grid and Blobs work, its answers, its timing and everything it writes are the same with
  the check on, whatever the hub does. The hub asks have their own limits: 3 s in the form handler, 8 s in the
  scheduled sync and workflow, and never past Netlify's own (about 10 s for the form handler, 30 s for the sync): with
  too little time left a question is not asked (`skipped`).
- A hub that is slow, down, refusing or answering garbage gives a `not_compared` row with the reason (`hub_timeout`,
  `hub_unreachable`, `hub_refused`, `hub_off`, `hub_not_ready`, `hub_bad_answer`); the site's own failure gives
  `own_failed`. A failed ledger post is logged as a count and never retried.
- The Lofty questions go to the hub with `dry_run: true` only: the hub reads Lofty as for real and writes nothing. The
  MLS and town questions are the hub's ordinary reads. Nothing here writes to Lofty, MLS Grid or this site's Blobs.
- The hub's dry-run answer holds the person's details; it is compared in memory and dropped. Rows carry field names
  only and the record's key only as `parityKey`'s hash; log lines carry counts and field names.
- With `LOFTY_VIA_HUB=on` (the site already goes through the hub) the Lofty comparison asks nothing; with
  `MLS_SOURCE=hub` the MLS comparison asks nothing.
- The town-figures step runs only when the repository variable is set, has `continue-on-error`, always exits 0 and
  writes no file.

## To switch on (each on Christine's word)

1. At the hub: deploy `hub-api`, apply `0078_parity_compare.sql` and `0079_parity_dry_run.sql`, then
   `parity_compare_enabled` and `lofty_dry_run_enabled` on (with `lofty_doorway_enabled`; the write switches stay
   off), and the MLS reads (`mls_reads_enabled`) and town figures as they are.
2. This site's hub key: scopes `parity:write`, `lofty:write` (a dry run is asked on the write routes), `mls:read` and
   `mls:agents` (Signature's sync), `market:read` (the town figures); and the Lofty profile `website` bound to its app
   id (`lofty_app_profile.<app id>`), without which the hub refuses `create_tags`, `custom_fields` and `inquiry` (403,
   recorded as `hub_refused`).
3. Netlify: `HUB_SIDE_BY_SIDE` = `lofty_write` (and on Signature `lofty_write,mls_read`), redeploy. GitHub: the
   repository variable `HUB_SIDE_BY_SIDE` = `mls_read` (and `HUB_API_URL`, plus the key secret) for the town figures.
4. A week of real traffic, then the hub's report.

Rollback: unset `HUB_SIDE_BY_SIDE` (Netlify and GitHub). Nothing to undo: the check never wrote anything but rows.

## What the first runs against the toolkit's dry run already show

Run against a fake hub built from the toolkit's own dry run (the code the hub runs), a new home-value lead differs on
`create.notes` (own_only: the site also sends the whole note in the create body; the hub sends it only as a note), and
on `team_fields_created` when a website field is empty (the site creates all four team fields, the hub only those it
writes). A lead who ticks the text box on the main site differs on `texting_on` (the site turns texting on for a
matching yes; the hub never does until 10DLC campaign 12744 is approved). A returning contact the hub would hold for
Do Not Contact still gets the site's Call task (`task` `outcome`). The real hub's answers are what count.
