// "What have you updated?" -- the little form linked from a value review email
// (Build E, Christine 2026-10-17). OFF unless VALUE_REVIEW_UPDATES_FORM=on.
//
// Christine's value review (a Gmail draft she sends herself) can carry a link to
// this form on the website the homeowner came from. The homeowner ticks what
// they have updated (kitchen, roof, windows ...) and adds anything in their own
// words; the answers go to the Seller Intelligence hub
// (POST {HUB_API_URL}/v1/value-reviews/updates, header x-hub-key =
// HUB_INTAKE_KEY, which needs the hub scope valuereview:updates). The hub checks
// the link's signature, saves the answers on the review and puts them on the
// Lofty lead as a note; Command Center lists them. Nothing is emailed or texted
// to anyone, and nothing here is a lead form: no name, email or phone is asked.
//
// GET  ?r=<review id>&t=<link token>  the form (a link without both = "not complete")
// POST                                the answers -> the hub -> a thank-you page
// Switched off: every request gets a plain "not available" page and nothing is
// sent. The page loads nothing from anywhere else (the token is in its address),
// is never indexed, and sends no analytics.
//
// BYTE-IDENTICAL in thelittleladysellshomes and signature-property-collection
// (tests/test-home-updates.js compares them); netlify/functions/home-updates.js
// on each site only names the site and its brand.
"use strict";

const { hubEndpoint } = require("./_hub-intake");

const UPDATES_PATH = "/v1/value-reviews/updates";
const FORM_ACTION = "/.netlify/functions/home-updates";
const TIMEOUT_MS = 8000;
const OTHER_MAX = 1000;

// What the homeowner can tick. Only these labels are ever sent.
const UPDATE_ITEMS = Object.freeze([
  "Kitchen", "Bathrooms", "Roof", "Windows", "Furnace or A/C", "Water heater", "Flooring", "Paint",
  "Finished basement", "Deck or patio", "Landscaping or yard", "Solar", "Addition",
]);

function homeUpdatesOn(env) {
  return String((env && env.VALUE_REVIEW_UPDATES_FORM) || "").trim().toLowerCase() === "on";
}

const okId = (v) => typeof v === "string" && /^[0-9]{1,18}$/.test(v);
const okToken = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
});

// Brand colours (CLAUDE.md): black, cream, mauve, rose beige, platinum.
const STYLE = "body{margin:0;background:#F5F0E8;color:#0A0A0A;font:17px/1.5 Georgia,'Times New Roman',serif}" +
  "main{max-width:560px;margin:0 auto;padding:32px 20px}h1{font-size:28px;margin:0 0 12px}" +
  "fieldset{border:1px solid #A7A9AC;border-radius:6px;padding:12px 16px;margin:20px 0}legend{padding:0 6px}" +
  "label.item{display:block;padding:6px 0}textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid #A7A9AC;border-radius:6px}" +
  "button{margin-top:16px;background:#B86F7A;color:#fff;border:0;border-radius:6px;padding:12px 20px;font:inherit;cursor:pointer}" +
  "p.small,footer{font-size:14px;color:#555}footer{max-width:560px;margin:0 auto;padding:0 20px 32px}";

function page(brand, title, bodyHtml, statusCode) {
  const html = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<meta name=\"robots\" content=\"noindex, nofollow\"><meta name=\"referrer\" content=\"no-referrer\">" +
    `<title>${esc(title)} | ${esc(brand)}</title><style>${STYLE}</style></head>` +
    `<body><main>${bodyHtml}</main><footer>Christine Gwinnup, REALTOR® · ${esc(brand)} · LPT Realty</footer></body></html>\n`;
  return { statusCode, headers: { ...HEADERS }, body: html };
}

function message(brand, title, text, statusCode) {
  return page(brand, title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`, statusCode);
}

function form(brand, r, t) {
  const boxes = UPDATE_ITEMS.map((x, i) =>
    `<label class="item"><input type="checkbox" name="items" value="${esc(x)}" id="i${i}"> ${esc(x)}</label>`).join("");
  return page(brand, "What have you updated?",
    "<h1>What have you updated?</h1>" +
    "<p>Tell me what you've changed in your home, and I'll factor it into your number. Tick anything that applies.</p>" +
    `<form method="post" action="${FORM_ACTION}">` +
    `<input type="hidden" name="r" value="${esc(r)}"><input type="hidden" name="t" value="${esc(t)}">` +
    `<fieldset><legend>What's new or updated</legend>${boxes}</fieldset>` +
    `<label for="other">Anything else, and roughly when?</label>` +
    `<textarea id="other" name="other" rows="5" maxlength="${OTHER_MAX}"></textarea>` +
    "<button type=\"submit\">Send to Christine</button></form>" +
    "<p class=\"small\">This goes to Christine Gwinnup only. Nothing here is shared or posted.</p>", 200);
}

function parseBody(event) {
  const raw = event && event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : String(event.body)) : "";
  return new URLSearchParams(raw.slice(0, 20000));
}

// The answers from a posted form: only known items, each once, in the form's order; their words trimmed to 1,000.
function answersFrom(params) {
  const ticked = new Set(params.getAll("items").map((x) => String(x).trim()));
  return {
    r: params.get("r") || "",
    t: params.get("t") || "",
    items: UPDATE_ITEMS.filter((x) => ticked.has(x)),
    other: String(params.get("other") || "").replace(/\r\n/g, "\n").trim().slice(0, OTHER_MAX),
  };
}

// handleHomeUpdates(event, { site: "main" | "signature", brand, env?, fetchImpl?, log? }) -> Netlify response
async function handleHomeUpdates(event, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const doFetch = o.fetchImpl || fetch;
  const log = o.log || ((line) => console.log(line));
  const brand = o.brand || "The Little Lady Sells Homes";
  const site = o.site === "signature" ? "signature" : "main";
  const method = String((event && event.httpMethod) || "GET").toUpperCase();

  if (!homeUpdatesOn(env)) return message(brand, "This page isn't available", "If you have updates to share, just reply to Christine's email.", 404);

  if (method === "GET" || method === "HEAD") {
    const q = (event && event.queryStringParameters) || {};
    if (!okId(q.r) || !okToken(q.t)) {
      return message(brand, "This link isn't complete", "Please use the full link from Christine's email, or just reply to that email with your updates.", 400);
    }
    return form(brand, q.r, q.t);
  }
  if (method !== "POST") return message(brand, "Not available", "Please use the form from Christine's email.", 405);

  const a = answersFrom(parseBody(event));
  if (!okId(a.r) || !okToken(a.t)) {
    return message(brand, "This link isn't complete", "Please use the full link from Christine's email, or just reply to that email with your updates.", 400);
  }
  if (!a.items.length && !a.other) return form(brand, a.r, a.t);

  const end = hubEndpoint(env, UPDATES_PATH);
  if (!end.url) {
    log(`home-updates: not sent (${end.reason})`);
    return message(brand, "Something went wrong", "Your answers weren't saved this time. Please reply to Christine's email with your updates instead.", 503);
  }
  let status = null;
  try {
    const res = await doFetch(end.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-key": end.key },
      body: JSON.stringify({ review_id: Number(a.r), token: a.t, items: a.items, other: a.other, site }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
  } catch (err) {
    log(`home-updates: the hub did not answer (${(err && err.name) || "error"})`);
    return message(brand, "Something went wrong", "Your answers weren't saved this time. Please reply to Christine's email with your updates instead.", 503);
  }
  log(`home-updates: hub answered ${status}`);
  if (status === 200) return message(brand, "Thank you", "Christine has your updates and will factor them into your number.", 200);
  if (status === 429) return message(brand, "Thank you", "Christine already has your answers. If there's more, just reply to her email.", 200);
  if (status === 410) return message(brand, "This link has expired", "Just reply to Christine's email with your updates.", 410);
  if (status === 404) return message(brand, "This link isn't valid", "Please use the link from Christine's email, or just reply to that email with your updates.", 404);
  return message(brand, "Something went wrong", "Your answers weren't saved this time. Please reply to Christine's email with your updates instead.", 503);
}

module.exports = { UPDATES_PATH, FORM_ACTION, UPDATE_ITEMS, homeUpdatesOn, answersFrom, handleHomeUpdates };
