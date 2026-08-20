// Saved-area listing alerts: "draw an area on the map, get emailed when
// something new lists inside it."
//
// 2026-08-20, from the portal audit Christine approved in full: this is
// Zillow's stickiest map feature, and the honest version of it works today
// without the full-catalogue geocode. A drawn area (or isochrone, or Ask)
// already resolves to the towns inside it -- the same city scope the whole
// site searches by -- so an alert is {email, cities[], optional price
// bounds}, and matching needs no coordinates at all.
//
// POST {email, cities[], label?, minPrice?, maxPrice?} -> saves the alert.
// GET ?unsub=<id> -> deletes it (the link in every email).
// Sending happens in area-alerts-run.js on a schedule, via the same Resend
// account the lead alerts use. CORS wildcard: the TLLSH map posts here
// directly (its _sig-proxy pass-through doesn't forward POST bodies), and an
// alert signup is public-facing by nature -- rate of abuse is bounded by the
// one-email-per-address dedupe below and Resend's own limits.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");

const STORE_NAME = "area-alerts";
const MAX_CITIES = 25;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status, payload) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
    body: JSON.stringify(payload),
  };
}

function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: CORS, body: "" };
    }
    const store = getBlobStore(getStore, STORE_NAME);

    if (event.httpMethod === "GET") {
      const id = (event.queryStringParameters || {}).unsub;
      if (!id) return json(400, { error: "missing unsub id" });
      await store.delete(id).catch(() => {});
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
        body: "<p style=\"font-family:sans-serif;padding:40px;text-align:center\">" +
          "You're unsubscribed from this area alert. — Christine</p>",
      };
    }

    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad json" }); }
    const email = normEmail(body.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "invalid email" });
    const cities = (Array.isArray(body.cities) ? body.cities : [])
      .map((c) => String(c || "").trim()).filter(Boolean).slice(0, MAX_CITIES);
    if (!cities.length) return json(400, { error: "no towns in the area" });

    // One alert per email address: a re-submit replaces the old area rather
    // than stacking a second subscription nobody remembers making.
    const id = "a-" + Buffer.from(email).toString("base64url");
    const record = {
      id, email, cities,
      label: String(body.label || "your area").slice(0, 120),
      minPrice: Number.isFinite(+body.minPrice) && +body.minPrice > 0 ? +body.minPrice : null,
      maxPrice: Number.isFinite(+body.maxPrice) && +body.maxPrice > 0 ? +body.maxPrice : null,
      createdAt: Date.now(),
      // Listing ids already matched at save time are seeded by the runner on
      // its first pass, so the first email only ever contains listings that
      // appeared AFTER the alert was created -- never a dump of the backlog.
      knownIds: null,
    };
    await store.setJSON(id, record);
    return json(200, { ok: true, id, cities: cities.length });
  } catch (err) {
    console.error("area-alerts error:", err);
    return json(500, { error: "exception", message: err && err.message });
  }
};
