# CLAUDE.md — Signature Property Collection

## Where we are, and the standing rules (updated 2026-10-07)

This section is the short version. The live record is outside the repository, so read it before acting on anything dated:

- **Shared Drive folder** "ChatGPT → Little Lady System – Shared Project" (https://drive.google.com/drive/folders/1jLZWjO9kyt4dhHjleYnt3SPrasZeDR8S): the newest "Claude Receipt" and "Claude Status Delta" notes say what is merged, what is switched on, and what Christine still owes.
- **Roadmap** (https://claude.ai/artifact/AjWYsEwReE7gNt2Nnc1zKm) and **Go-Live page** (https://claude.ai/artifact/S7UnaNtkzmGN8s5EoFWRDk): her open list, with a link for each item.

Standing rules from Christine, for every session in every repository:

- Nothing merges, deploys, sends (email or text) or switches on without her word. Report outcomes faithfully, including failures and anything you could not check.
- Never print, paste, log or commit a key, token or password. Name the environment variable only.
- **Lofty:** every create is `cannotText: true`; the SMS consent tag only on an explicit yes where every phone on the lead matches; an unreadable or missing tag list means hold; **Do Not Contact wins, and it is both `Consent – DNC` and `#dnc`**; a Lofty `PUT` replaces the whole tag list, so always read, merge, then write; look the person up (email, then phone) before creating.
- Email opt-out is the tag `Consent – Unsubscribed` together with `cannotEmail = true`.
- Only Christine's own number (303-709-4262) and her Lofty number appear anywhere. She is the only agent: never add a co-agent or the former lender to copy, schema or lead routing.
- Listing Engine work targets `staging`. Market Takeover is out of scope.

This site shares `netlify/functions/lib/_lofty.js`, `_lofty-consent.js`, `_notify.js` and `_form-plans.js` byte for byte with the main site (thelittleladysellshomes): change both together. `LOFTY_QUEUE_DRAIN=off` pauses the Lofty retry queue (the scheduled drain and the drain inside the 30-minute sync) without removing the Lofty key. The Signature collection is being folded into the main site; the redirects, the domain alias and removing Signature's own Google Business Profile wait for Christine's word.
