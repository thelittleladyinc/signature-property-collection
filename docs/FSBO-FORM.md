# "Selling it yourself?" (FSBO) — what this site carries

Christine, 2026-10-18: *"Also add a 'Selling it yourself?' form to thelittleladysellshomes and my-lead-pages that tags Funnel - FSBO and Source - Website."*

The form itself lives on **thelittleladysellshomes** (its `docs/FSBO-FORM.md`), behind that site's build switch `FSBO_FORM`. This site renders no FSBO form.

What changed here, and only because the file is shared byte for byte with the main site (`tests/test-form-plans.js` compares the two):

- `netlify/functions/lib/_form-plans.js` gains one plan, `FSBO`, whose start tag is `Funnel - FSBO` (plain ASCII hyphen, as Christine typed it; Seller lead type), and one form, `fsbo-inquiry`. No form on this site has that name, so nothing this site does changes: every existing form starts exactly the plan it started before (the test checks the whole table on both sites).
- `tests/test-form-plans.js` pins the new plan, as the main site's copy does.

`Funnel - FSBO` is meant to start Christine's existing Lofty plan **"FSBO – Seller Support (21 Days)"**, never a second FSBO plan. In Lofty, add `Funnel - FSBO` to that plan's start tags, or tell us the plan's current trigger tag and the one constant (`PLAN_TAGS.FSBO`) changes in both repos together.

## Switch

None on this site. The switch is `FSBO_FORM` on the main site (thelittleladysellshomes).

## To turn on

Nothing to do here. To turn the form on, follow "To turn on" in the main site's `docs/FSBO-FORM.md` (Netlify setting `FSBO_FORM=on` on thelittleladysellshomes, then redeploy that site).

## To turn off

Nothing to do here. Unset `FSBO_FORM` on the main site and redeploy it.

## How it was tested

`tests/run-all.sh`: 88 of 88 suites before and after. Run beside the main site's branch, `test-form-plans` and `test-lofty-via-hub` confirm `_form-plans.js` is byte-identical to the main site's copy (against an older main-site checkout that check fails until both branches merge together — merge them together).
