// /status is public, and it must not name anyone who filled in a form.
//
// 2026-09-30 (API audit). The page printed the last lead's email address, and
// ?format=json returned the raw push record plus the retry queue -- up to 25
// failed leads with name, email, phone and what they wrote. The Little Lady site's
// /status is a pass-through to this same function, so both domains published it.
// This renders the page (HTML and JSON) from records that carry all of that, and
// fails if any of it comes back out -- while the diagnosis (form, time, status,
// counts) still does.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const PERSON = {
  firstName: "Janelle", lastName: "Quistgaard", emails: ["janelle.q@example.com"],
  phones: ["(970) 555-0142"], notes: "NEW WEBSITE LEAD — wants a 4 bed on acreage with a llama barn",
};
const SECRETS = ["Janelle", "Quistgaard", "janelle.q@example.com", "555-0142", "llama barn"];

const lastFailed = {
  at: "2026-09-30T15:00:00.000Z", formName: "contact", leadEmail: "janelle.q@example.com",
  ok: false, httpStatus: 422, payloadShape: "full+minimal both rejected",
  responseBody: '{"message":"email janelle.q@example.com / phone 970-555-0142 rejected"}',
  emailResult: { attempted: true, ok: false, httpStatus: 403, response: "cannot send to janelle.q@example.com" },
};
const lastOk = {
  at: "2026-09-30T15:05:00.000Z", formName: "buyers-page-inquiry", leadEmail: "janelle.q@example.com",
  ok: true, httpStatus: 200, payloadShape: "full", leadId: "1148639689762408",
  responseBody: '{"leadId":1148639689762408,"firstName":"Janelle","emails":["janelle.q@example.com"]}',
  emailResult: { attempted: true, ok: true, httpStatus: 200, response: '{"id":"re_1"}' },
  noteResult: { attempted: true, ok: true, httpStatus: 200, response: '{"content":"Janelle wants a llama barn"}' },
  tagResult: { attempted: true, ok: true, step: "added", tagRestored: true },
};
const queue = [
  { at: "2026-09-30T14:00:00.000Z", formName: "contact", lead: PERSON, ok: false, httpStatus: 503,
    responseBody: "upstream timeout for Janelle Quistgaard" },
  { at: "2026-09-30T13:00:00.000Z", formName: "listing-alert-request", lead: PERSON, ok: false, httpStatus: 0,
    lastRetryAt: "2026-09-30T14:30:00.000Z" },
];

async function render(last, params) {
  require.cache[blobsPath] = {
    id: blobsPath, filename: blobsPath, loaded: true, exports: {
      getStore: () => ({
        get: async (k) => (k === "lofty-last-push.json" ? last : k === "lofty-failed-pushes.json" ? queue : null),
        setJSON: async () => {},
        list: async () => ({ blobs: [] }),
      }),
    },
  };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath) delete require.cache[k];
  }
  process.env.LOFTY_API_KEY = "k";
  process.env.RESEND_API_KEY = "k";
  global.fetch = async () => { throw new Error("no live calls in this test"); };
  return require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: params });
}

(async () => {
  for (const [label, last] of [["a failed last push", lastFailed], ["a successful last push", lastOk]]) {
    console.log(`\n${label}`);
    const html = (await render(last, {})).body;
    const jsonRes = await render(last, { format: "json" });
    const json = jsonRes.body;
    for (const s of SECRETS) {
      check(`HTML does not contain "${s}"`, !html.includes(s));
      check(`JSON does not contain "${s}"`, !json.includes(s));
    }
    let parsed = null;
    try { parsed = JSON.parse(json); } catch (e) { parsed = null; }
    check("JSON still parses", !!parsed);
    if (!parsed) continue;
    const row = parsed.checks.find((c) => c.name === "Website leads reaching Lofty") || {};
    check("the lead row still names the form and the time", row.detail && row.detail.includes(last.formName) && row.detail.includes(last.at), row.detail);
    check("the failed queue is a count, not the leads", parsed.raw.loftyFailed.count === 2 &&
      parsed.raw.loftyFailed.entries.every((e) => !("lead" in e) && e.at && e.formName), JSON.stringify(parsed.raw.loftyFailed));
    check("the last push keeps its status and form", parsed.raw.loftyLast.formName === last.formName &&
      parsed.raw.loftyLast.httpStatus === last.httpStatus && !("leadEmail" in parsed.raw.loftyLast));
    if (!last.ok) {
      check("a vendor's refusal is still shown, scrubbed", /\[email\]/.test(row.detail) && /\[phone\]/.test(row.detail), row.detail);
    }
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
