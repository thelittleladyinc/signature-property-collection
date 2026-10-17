# Website leads to Lofty through the hub (Wave 1b, off by default)

Two settings on this site's Netlify environment, both off unless set to exactly `on` (trimmed, any case):

| Setting | What it does when `on` |
|---|---|
| `LOFTY_VIA_HUB` | The form's Lofty work goes through the Seller Intelligence hub (`POST /v1/lofty/lead`, `/v1/lofty/note`, `/v1/lofty/consent`) instead of this site's own `LOFTY_API_KEY`. |
| `LEADS_TO_ROUTER` | Every form lead (not rent-to-own) is also recorded with the hub's lead router (`POST /v1/router/lead`, source `signature-form`, kind `new`), so Command Center's call list sees it. |

Both use the settings the lead alert email already uses: `HUB_API_URL` (https) and `HUB_API_KEY` (header `x-hub-key`; never logged). The code is `netlify/functions/lib/_lofty-hub.js`, byte-identical in the Signature repo (`tests/test-lofty-via-hub.js` checks it).

## With `LOFTY_VIA_HUB=on`

- One hub push per submission: look up (email, then phone), create with `cannotText: true` and the plan's lead type (create only), the form's tags after the create, the note.
- The nurture-plan tag only on a contact the hub created (not found, not merged) and whose note landed: a second push with `create: false` and the plan tag only, after the hub's consent route says the lead may be emailed. The hub's per-lead lease makes this second write safe.
- Texting is never switched on. A yes is recorded in a note (10DLC campaign 12744 is not approved yet).
- The hub can't take it (not configured, unreachable, switched off, rate limited, busy): the lead goes to the existing retry queue with the reason. Nothing is sent with this site's own key instead.
- Held by the hub (Do Not Contact, several possible leads, no email or phone): the existing held-lead record on `/status`; never replayed.
- The queue replay (`lofty-queue-drain.js`) goes through the hub too.

Still on this site's own `LOFTY_API_KEY` (the hub has no route for these yet), so keep it set: the Call task and phone push for a returning contact (only after the hub's consent route says the lead may be called), the four website custom fields and the search wishes on a contact the hub created, her listings reads, and the `/status` probes. `submission-created.js` also still needs `LOFTY_API_KEY` set to push at all.

Not carried on the hub path: the home-value form's address as Lofty's `property` field (the hub's lead route has no address yet; the address is still in the note).

## Turn on / roll back

Turn on: the hub's Lofty doorway first, then grant this site's hub key `lofty:read`, `lofty:write` (and `router:write` for the router copy), then set `LOFTY_VIA_HUB=on` (and `LEADS_TO_ROUTER=on`) on this Netlify site and redeploy. Full steps are in the pull request that added this file.

Roll back: unset `LOFTY_VIA_HUB` (and `LEADS_TO_ROUTER`) and redeploy. Leads this site queued through the hub are then replayed on its own key; leads the other site queued through the hub are left for that site's drain.
