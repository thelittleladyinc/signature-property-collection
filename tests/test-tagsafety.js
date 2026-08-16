// The tag reader must never overwrite a lead's tags with a list it built from a
// response shape it didn't understand. That would delete real tags off a real
// client's record.
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const { tagsFromLead, describeTagShape, refireLoftyTag } = require(`${ROOT}/netlify/functions/lib/_notify.js`);
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

console.log("\ntagsFromLead: readable vs unreadable");
check("plain string tags read fine",
  JSON.stringify(tagsFromLead({ data: { tags: ["A", "B"] } })) === '["A","B"]');
check("genuinely empty tag list is [] and NOT null",
  JSON.stringify(tagsFromLead({ data: { tags: [] } })) === "[]");
check("unwrapped response works too",
  JSON.stringify(tagsFromLead({ tags: ["A"] })) === '["A"]');
check("OBJECT tags => null (unreadable), not []",
  tagsFromLead({ data: { tags: [{ name: "A" }, { name: "B" }] } }) === null,
  JSON.stringify(tagsFromLead({ data: { tags: [{ name: "A" }] } })));
check("missing tags field => null", tagsFromLead({ data: {} }) === null);
check("tags as a string => null", tagsFromLead({ data: { tags: "A,B" } }) === null);
check("mixed array keeps the strings", JSON.stringify(tagsFromLead({ data: { tags: ["A", { n: 1 }] } })) === '["A"]');
check("shape description names the problem",
  /array of 2 item\(s\) of type object/.test(describeTagShape({ data: { tags: [{}, {}] } })),
  describeTagShape({ data: { tags: [{}, {}] } }));

console.log("\nrefireLoftyTag: an unreadable shape must cause NO writes");
(async () => {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${String(url).split("/v1.0")[1]}`);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ data: { tags: [{ name: "Hot Lead - Website" }, { name: "Buyer" }] } }),
      headers: { get: () => null },
    };
  };
  const r = await refireLoftyTag(4242, "Hot Lead - Website", "key");
  check("only the GET happened — zero PUTs", JSON.stringify(calls) === '["GET /leads/4242"]', JSON.stringify(calls));
  check("reported as not ok", r.ok === false);
  check("step names the cause", r.step === "unreadable-tags", r.step);
  check("says the lead was left intact", r.tagRestored === true);
  check("carries the shape so it can be fixed", /type object/.test(r.tagShape || ""), r.tagShape);

  console.log("\nrefireLoftyTag: a lead with genuinely no tags still gets the trigger tag");
  const calls2 = [];
  let first = true;
  global.fetch = async (url, opts = {}) => {
    calls2.push({ m: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    const body = first ? { data: { tags: [] } } : {};
    first = false;
    return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
  };
  const r2 = await refireLoftyTag(99, "Hot Lead - Website", "key");
  check("one GET then one PUT", calls2.length === 2 && calls2[1].m === "PUT", JSON.stringify(calls2.map(c => c.m)));
  check("PUT sends exactly the trigger tag",
    JSON.stringify(calls2[1].body.tags) === '["Hot Lead - Website"]', JSON.stringify(calls2[1].body));
  check("reported as added", r2.ok === true && r2.step === "added");

  console.log("\nrefireLoftyTag: if the lead can't be read at all, say so distinctly");
  global.fetch = async () => ({ ok: false, status: 404, text: async () => "not found", headers: { get: () => null } });
  const r3 = await refireLoftyTag(7, "Hot Lead - Website", "key");
  check("step is 'read'", r3.step === "read", r3.step);
  check("keeps Lofty's own status", r3.httpStatus === 404);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})();
