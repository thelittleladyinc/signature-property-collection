# Website leads to Lofty through the hub (Wave 1b, off by default)

Two settings on this site's Netlify environment, both off unless set to exactly `on` (trimmed, any case):

| Setting | What it does when `on` |
|---|---|
| `LOFTY_VIA_HUB` | Every Lofty call this site makes goes through the Seller Intelligence hub (`POST /v1/lofty/lead`, `/note`, `/consent`, `/task`, `/read`) instead of this site's own `LOFTY_API_KEY`: the form's push and its follow-ups, the retry queue, her listings reads and the `/status` probes. |
| `LEADS_TO_ROUTER` | Every form lead is also recorded with the hub's lead router (`POST /v1/router/lead`, source `signature-form`, kind `new`), so Command Center's call list sees it. Rent-to-own leads too: they are Christine's like every other lead (Christine, 2026-10-23), sent with intent `rent_to_own`; the router's rule NEW-RENT-TO-OWN starts no plan until she approves one. Cash-offer leads go with intent `seller_cash` (their plan S2 alone would say `home_value`) and the FSBO form (`fsbo-inquiry`) with `seller_fsbo`, so the router's rules NEW-SELLER-CASH and NEW-SELLER-FSBO can match them (Christine, 2026-10-23); every other form sends its plan's intent, and the Lofty side is unchanged. |

Both use the settings the lead alert email already uses: `HUB_API_URL` (https) and `HUB_API_KEY` (header `x-hub-key`; never logged). The code is `netlify/functions/lib/_lofty-hub.js`, byte-identical in the Signature repo (`tests/test-lofty-via-hub.js` checks it).

## With `LOFTY_VIA_HUB=on`

Since 2026-10-24 (Christine: "Move each one, let's start with Lofty ... I need everything live") nothing is left on this site's own key, and nothing the own-key path does is lost (sellerintelligence `docs/hub-parity.md`, "Websites", profile `website`):

| Today, with this site's `LOFTY_API_KEY` | Through the hub |
|---|---|
| Look up (email, phone), create with `cannotText: true` and the plan's lead type, the note | ONE `POST /v1/lofty/lead` (lookup, create, tags after the create, note) |
| The form's tags in the create body for a contact proven new, then the trigger tag `Hot Lead - Website` taken off and put back so its plan starts | `create_tags` = the form's tags except the trigger tag; the trigger tag goes on after the create, so only it counts as added and its plan starts |
| Home-value address as Lofty's `property` | `address` (a create; on an existing lead only where blank, never overwritten) |
| Four "Website …" fields and the search wishes on a contact proven new | `custom_fields` + `inquiry` on the same push; the hub writes them only on a contact this push created and Lofty did not fold into another, after the note landed |
| A yes to texts: texting on only when every phone on the lead is the number that said yes | `sms_yes`: the hub decides; texting stays off suite-wide until Lofty approves 10DLC campaign 12744, and the yes is written in the lead's note |
| Plan tag after the create, by read-merge-write, only for a contact proven new | A second `/v1/lofty/lead` with `create: false`, `lead_id` (no search) and the plan tag only, after `/v1/lofty/consent` says the lead may be emailed |
| Call task + push to her phone for a returning contact | `POST /v1/lofty/task {lead_id, content, due_in_minutes: 30, push_reminder: true}` (held on Do Not Contact, `#dnc`, `cannotCall`, an unreadable lead) |
| Her listings: `POST /v2.0/listings/search`, `GET /v1.0/listing?mlsListingIds=` | `POST /v1/lofty/read` `listing_search` / `listings` |
| `/status`: `GET /v1.0/me`, the last lead read back | `/v1/lofty/read` `me` / `lead` |
| The retry queue replays all of the above | The same hub calls, every option included |

- "Proven new" is unchanged: lead type, plan tag, website fields and search wishes only for a contact the push created (not found, not folded into another lead) whose note landed.
- A note longer than the hub keeps (5,000 characters) goes in parts: the first with the push, the rest right after it as `/v1/lofty/note`, so a long message never cuts off the consent record at the end.
- The hub can't take it (not configured, unreachable, switched off, an option's switch off, rate limited, busy): the lead goes to the existing retry queue with the reason. Nothing is sent with this site's own key instead.
- Held by the hub (Do Not Contact, several possible leads, no email or phone): the existing held-lead record on `/status`; never replayed.
- Never stuck in the queue for an option: search values the hub would refuse are left out of the push, and a push the hub refuses as malformed (HTTP 400) for one of the options is asked once more without them, as today's own-key path retries Lofty in its minimal shape. What was left out is in the note.
- The side-by-side check (`HUB_SIDE_BY_SIDE` `lofty_write`) asks nothing while this is on; its dry run was built by the same builder the real push now uses (`leadAskFor` in `netlify/functions/lib/_lofty-hub.js`).
- `LOFTY_API_KEY` stays set: the existing "is Lofty set up here?" checks still read it, but with the switch on it is never sent anywhere.

Not exactly today's behaviour:
- A returning contact found by phone only used to have its trigger tag re-fired; through the hub it gets the Call task instead (the website profile takes no tag off, so a tag already on a lead cannot be re-fired). A returning contact found by email gets the Call task, as today.
- The hub creates no Call task on a Do Not Contact, `#dnc` or `cannotCall` lead; today's own-key path did.
- Texting is never switched on through the hub (10DLC campaign 12744 is not approved); today's own-key path switched it on for a yes on the only number.
- The hub keeps Lofty's Source field to 100 characters: the one longer label (`signature-expired-inquiry` on the Little Lady site, 105 characters) loses its last five; the full label is still in the note and the "Website Form" field.
- A form's tags added to a returning contact go on by read-merge-write (a PUT), where today's create sent them as `tagsAdd`.
- On an existing lead the address only fills a blank; a create Lofty folds into an existing lead could replace it today.
- A replay of a lead whose first hub try created the contact but did not finish: the website fields and search wishes are not written (the hub writes them only in the push that creates the lead); they are in the note.

## Turn on / roll back

Turn on: the hub's Lofty doorway first, then grant this site's hub key `lofty:read`, `lofty:write` (and `router:write` for the router copy), then set `LOFTY_VIA_HUB=on` (and `LEADS_TO_ROUTER=on`) on this Netlify site and redeploy. Full steps are in the pull request that added this file.

Turn on (2026-10-24; the hub's doorway, writes, reads, address, fields, create_tags, tasks and lead_by_id switches are on, this site's key has `lofty:read` + `lofty:write` and the profile `website`): set `LOFTY_VIA_HUB=on` on this Netlify site, then deploy (merging the pull request deploys).

Roll back: unset `LOFTY_VIA_HUB` (and `LEADS_TO_ROUTER`) and redeploy. Leads this site queued through the hub are then replayed on its own key; leads the other site queued through the hub are left for that site's drain.
