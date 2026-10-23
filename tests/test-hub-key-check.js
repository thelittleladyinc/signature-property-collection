// The Seller Intelligence hub key row on /site-health (2026-10-23).
//
// Christine, Oct 23: "it's very important that we don't lose anything at all".
// This site's hub key (hub app "signature") had never been used, so nothing showed
// whether HUB_API_KEY is the right key before anything moves onto the hub. The row
// asks the hub's GET /v1/health (no scope, no lead read, nothing bought) -- opt-in
// like every other live check, so a plain load still makes no outbound call.
process.env.LISTINGS_SOURCE = "lofty";
delete process.env.MLS_SOURCE;
for (const k of ["LOFTY_API_KEY", "GOOGLE_MAPS_API_KEY", "CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) delete process.env[k];
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = path.join(ROOT, "netlify", "functions");
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const HUB_URL = "https://hub.example.supabase.co/functions/v1/hub-api";
const HUB_KEY = "hub_" + "b".repeat(64);
const ROW = "Seller Intelligence hub key valid";

function store(seed = {}) {
  const data = new Map(Object.entries(seed));
  const writes = [];
  return {
    data, writes,
    get: async (k) => (data.has(k) ? data.get(k) : null),
    setJSON: async (k, v) => { writes.push(k); data.set(k, v); },
    list: async () => ({ blobs: [] }),
  };
}
function fakeFetch(answer) {
  const f = async (url, init) => {
    f.calls.push({ url: String(url), init });
    return answer(String(url), init);
  };
  f.calls = [];
  return f;
}
const reply = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => "application/json" },
  text: async () => (body === undefined ? "not json" : JSON.stringify(body)),
  json: async () => body,
});
function load(blobs, fetchImpl, env) {
  delete process.env.HUB_API_URL; delete process.env.HUB_API_KEY;
  Object.assign(process.env, env || {});
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => blobs } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  global.fetch = fetchImpl;
  return require(path.join(FN_DIR, "site-health.js")).handler;
}
const HUB_ENV = { HUB_API_URL: HUB_URL, HUB_API_KEY: HUB_KEY };
async function run({ env = HUB_ENV, answer, probe = true, seed } = {}) {
  const s = store(seed);
  const f = fakeFetch(answer || (() => reply(200, { ok: true, app: "signature", enabled: true })));
  const handler = load(s, f, env);
  const res = await handler({ queryStringParameters: { format: "json", ...(probe ? { probe: "1" } : {}) } });
  const body = JSON.parse(res.body);
  const row = body.checks.find((c) => c.name === ROW) || {};
  const hubCalls = f.calls.filter((c) => c.url.startsWith(HUB_URL));
  return { s, f, res, body, row, hubCalls };
}

(async () => {
  console.log("a plain load makes no call and says the key is not tested yet");
  {
    const { f, row } = await run({ probe: false });
    check("no outbound call at all", f.calls.length === 0, f.calls.map((c) => c.url).join(" "));
    check("the row is there and not red", row.ok === true && !row.optional, JSON.stringify(row));
    check("...and says how to test it", /Not tested yet — add \?probe=1 to this page's URL to ask the hub about the key directly\./.test(row.detail), row.detail);
  }

  console.log("?probe=1 with this site's own key");
  {
    const { row, hubCalls, s, res } = await run();
    check("one GET to the hub's /v1/health", hubCalls.length === 1 && hubCalls[0].url === `${HUB_URL}/v1/health` && hubCalls[0].init.method === "GET", hubCalls.map((c) => c.url).join(" "));
    check("the key goes in x-hub-key only, redirects refused", hubCalls[0].init.headers["x-hub-key"] === HUB_KEY && !hubCalls[0].url.includes(HUB_KEY) && hubCalls[0].init.redirect === "error");
    check("green, with the app and the switch state", row.ok === true && /The hub accepted the key \(app signature; hub data routes on\)\./.test(row.detail), row.detail);
    check("the verdict is saved", s.writes.includes("hub-key-check.json"));
    check("the key never reaches the page or the saved verdict", !res.body.includes(HUB_KEY) && !JSON.stringify(s.data.get("hub-key-check.json")).includes(HUB_KEY));
  }

  console.log("data routes off still proves the key");
  {
    const { row } = await run({ answer: () => reply(200, { ok: true, app: "signature", enabled: false }) });
    check("green, says the data routes are off", row.ok === true && /hub data routes off/.test(row.detail), row.detail);
  }

  console.log("a refused key and another app's key are red and count");
  {
    const refused = (await run({ answer: () => reply(401, { error: "unauthorized" }) })).row;
    check("401: red, not optional", refused.ok === false && !refused.optional, JSON.stringify(refused));
    check("...says mistyped or revoked and what to do", /REFUSED the key \(HTTP 401\)/.test(refused.detail) && /replace HUB_API_KEY in Netlify/.test(refused.detail), refused.detail);
    const other = (await run({ answer: () => reply(200, { ok: true, app: "Command-Center<b>", enabled: true }) })).row;
    check("another app's key: red, app id cut to safe characters", other.ok === false && !other.optional && /hub key of app "command-centerb", not signature/.test(other.detail), other.detail);
  }

  console.log("a hub that could not answer proves nothing: optional, never red");
  for (const [label, answer, re] of [
    ["429", () => reply(429, { error: "slow" }), /did not confirm the key \(HTTP 429\)/],
    ["500", () => reply(500, { error: "boom" }), /did not confirm the key \(HTTP 500\)/],
    ["no JSON", () => reply(200, undefined), /did not confirm the key \(HTTP 200, no JSON\)/],
    ["unreachable", () => { throw new Error("ECONNREFUSED " + HUB_KEY); }, /did not confirm the key \(HTTP request failed\)/],
  ]) {
    const { row, res } = await run({ answer });
    check(`${label}: optional, not ok, says so`, row.optional === true && row.ok === false && re.test(row.detail), row.detail);
    check(`${label}: the key is not on the page`, !res.body.includes(HUB_KEY));
  }

  console.log("not set up, and set but unusable");
  {
    const none = await run({ env: {} });
    check("not set: optional, no call", none.row.optional === true && none.row.ok === false && none.hubCalls.length === 0 && /aren't set in Netlify, so nothing on this site asks the hub/.test(none.row.detail), none.row.detail);
    for (const env of [{ ...HUB_ENV, HUB_API_URL: HUB_URL.replace("https:", "http:") }, { ...HUB_ENV, HUB_API_KEY: "not-a-key" }, { HUB_API_KEY: HUB_KEY }]) {
      const bad = await run({ env });
      check(`unusable (${Object.keys(env).join("+")}): red, no call`, bad.row.ok === false && !bad.row.optional && bad.f.calls.length === 0 && /so nothing on this site can use the hub\./.test(bad.row.detail), bad.row.detail);
    }
  }

  console.log("a saved verdict is kept inside the TTL and listed in the summary row");
  {
    const saved = { checkedAt: new Date().toISOString(), ok: true, httpStatus: 200, app: "signature", enabled: true };
    const { row, hubCalls, body } = await run({ seed: { "hub-key-check.json": saved } });
    check("a fresh saved verdict is not re-asked", hubCalls.length === 0 && row.ok === true);
    const old = { ...saved, checkedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() };
    const stale = await run({ probe: false, seed: { "hub-key-check.json": old } });
    const summary = stale.body.checks.find((c) => c.name === "Live checks are current") || {};
    check("an old verdict is named in the summary row", /hub key/.test(summary.detail || ""), summary.detail);
    check("the raw JSON carries the verdict", body.raw && body.raw.hubKeyCheck && body.raw.hubKeyCheck.app === "signature");
  }

  console.log("the Lofty key row now names Lofty, not Cloudinary");
  {
    const { body } = await run({ probe: false, env: { ...HUB_ENV, LOFTY_API_KEY: "lofty-test" } });
    const lofty = body.checks.find((c) => c.name === "Lofty API key valid") || {};
    check("ask Lofty about the key", /ask Lofty about the key directly/.test(lofty.detail || ""), lofty.detail);
    delete process.env.LOFTY_API_KEY;
  }

  if (failures) { console.log(`${failures} check(s) FAILED`); process.exit(1); }
  console.log("All checks passed.");
})().catch((err) => { console.log("FAIL threw: " + (err && err.stack)); process.exit(1); });
