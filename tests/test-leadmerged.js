// The merged-lead ghost id.
//
// 2026-08-16, from Christine's live /status after a real listing-inquiry
// submission. POST /leads succeeded and handed back leadId 1147334685108095;
// POST /notes for that same id came back
//   404 {"message":"BaseApplicationException:errorCode=20006,errorMsg=Lead not exist"}
// while an unrelated lead (1147802441137106) read back fine with HTTP 200.
//
// So on a MERGE Lofty returns the id of the record it absorbed, not the
// surviving contact's, and never discloses the survivor's id. Unfixable from
// here (no lookup-by-email in their API), so the requirement is honesty and
// economy: name the case, don't spend a second doomed call on it, and don't
// paint the row red — it only ever happens for someone already in her CRM, which
// so far has only been her own account-owner address.
//
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Byte-for-byte what Lofty returned to her.
const REAL_404 = '{"message":"BaseApplicationException:errorCode=20006,errorMsg=Lead not exist"}';
const GHOST_ID = 1147334685108095;

(async () => {
  const { addLoftyNote, refireLoftyTag, isLeadMissing } = require(`${FN_DIR}/lib/_notify.js`);

  // --- the detector, including what it must NOT match -----------------------
  check("recognises the real body", isLeadMissing({ httpStatus: 404, text: REAL_404 }) === true);
  check("matches on errorCode alone, so a reworded message still counts",
    isLeadMissing({ httpStatus: 404, text: "errorCode=20006 something else" }) === true);
  check("an unrelated 404 is not a merge",
    isLeadMissing({ httpStatus: 404, text: '{"message":"endpoint does not exist"}' }) === false);
  check("a 401 is never a merge, whatever it says",
    isLeadMissing({ httpStatus: 401, text: REAL_404 }) === false);
  check("survives a missing body", isLeadMissing({ httpStatus: 404 }) === false);

  // --- the note call flags it ------------------------------------------------
  global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null },
    text: async () => REAL_404 });
  const note = await addLoftyNote(GHOST_ID, "NEW WEBSITE LEAD …", "key");
  check("note reports failure honestly", note.ok === false && note.httpStatus === 404);
  check("note flags the merge", note.leadMissing === true);

  // A genuine 404 must NOT be dressed up as a merge — that would hide a real bug.
  global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null },
    text: async () => '{"message":"The requested API endpoint does not exist"}' });
  const moved = await addLoftyNote(GHOST_ID, "note", "key");
  check("an endpoint-moved 404 is left as a plain failure", !moved.leadMissing);

  // --- the tag call reports its own step, and touches nothing ---------------
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${String(url).split("/v1.0")[1]}`);
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => REAL_404 };
  };
  const tag = await refireLoftyTag(GHOST_ID, "Hot Lead - Website", "key");
  check("step distinguishes a merge from an unreadable lead", tag.step === "lead-missing", tag.step);
  check("no write was attempted", JSON.stringify(calls) === `["GET /leads/${GHOST_ID}"]`, JSON.stringify(calls));
  check("the surviving contact keeps its tag", tag.tagRestored === true);

  // --- submission-created must not spend the doomed second call ------------
  const src = require("fs").readFileSync(`${FN_DIR}/submission-created.js`, "utf8");
  check("tag refire is skipped when the note proved the id is a ghost",
    /noteResult\.leadMissing[\s\S]{0,200}skipped: "lead-missing"/.test(src));

  // --- and /status explains it instead of showing two red 404s -------------
  const record = {
    at: "2026-08-16T13:50:43.917Z", formName: "listing-inquiry",
    leadEmail: "thelittleladyinc@gmail.com", ok: true, httpStatus: 200,
    payloadShape: "full", leadId: GHOST_ID,
    noteResult: { attempted: true, ok: false, httpStatus: 404, response: REAL_404, leadMissing: true },
    tagResult: { attempted: false, skipped: "lead-missing", tagRestored: true },
  };
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({
      get: async (k) => (k === "lofty-last-push.json" ? record : null),
      setJSON: async () => {}, list: async () => ({ blobs: [] }),
    }),
  } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  process.env.LOFTY_API_KEY = "k"; process.env.GOOGLE_MAPS_API_KEY = "g";
  global.fetch = async () => { throw new Error("no live calls"); };
  const res = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } });
  const p = JSON.parse(res.body);
  const row = p.checks.find((c) => /merged|Lofty notification will fire/.test(c.name));
  console.log(`       ${row.optional ? "ℹ️" : (row.ok ? "✓" : "✗")} ${row.name}`);
  check("row is informational, not a red failure", row.optional === true, JSON.stringify(row.name));
  check("the row NAME says it merged, so she reads it as expected",
    /merged/i.test(row.name), row.name);
  check("explains that Lofty returned the absorbed record's id",
    /absorbed/.test(row.detail), row.detail.slice(0, 120));
  check("reassures that the tag is still on the surviving contact",
    /appends tags on a\s+merge/.test(row.detail));
  check("says a new enquirer is unaffected", /new enquirer creates a new contact/.test(row.detail));
  check("accounts for the skipped tag call rather than leaving a gap",
    /Trigger tag: not attempted, because it reads the same id/.test(row.detail));
  check("drops the old wording that blamed her test submissions",
    !/hid your own test submissions/.test(row.detail));
  // The point of marking it optional is that it stops driving the red banner.
  // Asserted on THIS row's contribution, not on allOk: a stubbed Blobs store has
  // no sync state or photo probe, so allOk is false here for reasons that have
  // nothing to do with the merge.
  check("this row no longer counts toward the red banner",
    !p.checks.filter((c) => !c.ok && !c.optional).some((c) => /merged/i.test(c.name)));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
