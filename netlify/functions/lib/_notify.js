// Making sure Christine actually finds out when a website lead arrives.
//
// 2026-08-15 (Christine, after building a Lofty Smart Plan by hand and testing
// it: "didnt work", then "it didnt come through"). Then the message that
// unblocked all of this: "i have lofty sync with my repo called seller
// intelligence i think - can you see if that repo has what you need?"
//
// It did. sellerintelligence is a live project (last push 2026-07-29, not
// expired) that has been talking to this same Lofty account for months, and it
// answers the three questions this site could only guess at, because
// developer.lofty.com is unreachable from the build environment:
//
//   1. NOTES ARE THEIR OWN ENDPOINT, and the obvious guess is wrong. From
//      src/sync/fub-to-lofty-migrate.ts, learned the hard way there:
//        "Lofty notes live at POST /notes with { leadId, content }. The nested
//         /leads/{id}/notes path 404s (The requested API endpoint does not exist)"
//      leadId is a NUMBER there, not a string.
//   2. TAGS ARE EDITABLE AFTER THE FACT, via PUT /leads/{leadId} with a full
//      tags array (src/sync/push-scores-to-lofty.ts), and GET /leads/{leadId}
//      returns the current ones. That project replaces a tier tag on an
//      existing lead this way, so the round trip is proven.
//   3. SHE ALREADY HAS RESEND. sellerintelligence sends her daily digest with
//      it (src/reports/email-digest.ts, RESEND_API_KEY / DIGEST_FROM /
//      DIGEST_TO, defaulting to thelittleladyinc@gmail.com). So an email
//      straight to her inbox needs no new vendor, no new account, and no
//      Lofty automation working correctly.
//
// Why all three, rather than picking one. The Smart Plan she built is the right
// tool and it should keep running -- but a notification path that depends on a
// CRM automation firing correctly is exactly what has failed twice now, and the
// lead is the part of this business that must not go unnoticed. So:
//
//   * The EMAIL is the guarantee. It leaves this function within a second of
//     the form being submitted, and it does not care whether Lofty merged the
//     lead, whether the Smart Plan is saved, or whether Auto Apply is on.
//   * The NOTE is what makes a merged lead legible inside Lofty. Until now the
//     note text rode along in the create-lead body, which is fine for a brand
//     new contact -- but a CRM merging into an existing contact has no reason
//     to overwrite that contact's fields, and this is precisely the case
//     Christine kept hitting by testing with her own account-owner address.
//     A separate POST /notes lands on the timeline either way.
//   * The TAG RE-ADD is what makes her Smart Plan fire on a repeat enquiry. A
//     "Tag Added" trigger fires on the CHANGE, so a contact already carrying
//     "Hot Lead - Website" from a previous enquiry never triggers it again --
//     her second and third tests could not have worked no matter what was
//     configured. Removing the tag and putting it straight back makes the
//     change real, so a returning buyer's second enquiry notifies her like the
//     first one did.
//
// Nothing here is allowed to fail a submission. Every function returns a small
// result object describing what happened -- recorded for /site-health -- and
// throws nothing, because the lead is already safe in Netlify Forms and in
// Lofty by the time any of this runs.
const LOFTY_BASE_URL = "https://api.lofty.com/v1.0";
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

// Resend's shared sandbox sender needs no domain verification, but it will only
// deliver to the Resend account owner's own address -- which here is exactly
// who we want to reach. Overridable once she verifies her own domain, matching
// the DIGEST_FROM/DIGEST_TO pattern from sellerintelligence.
const DEFAULT_FROM = "Signature Property Collection <onboarding@resend.dev>";
const DEFAULT_TO = "thelittleladyinc@gmail.com";

function loftyHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    // "token <key>", confirmed against Lofty's own usage example on her API
    // settings page and against every call sellerintelligence makes.
    "Authorization": `token ${apiKey}`,
  };
}

async function loftyRequest(method, path, apiKey, body) {
  const res = await fetch(`${LOFTY_BASE_URL}${path}`, {
    method,
    headers: loftyHeaders(apiKey),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { ok: res.ok, httpStatus: res.status, text: text.slice(0, 300), json };
}

// Lofty's own way of saying "the id you were just handed doesn't resolve".
// Matched on the error CODE as well as the message so a reworded message doesn't
// silently turn this back into an unexplained 404.
function isLeadMissing(res) {
  if (!res || res.httpStatus !== 404) return false;
  const body = `${res.text || ""} ${JSON.stringify(res.json || {})}`;
  return /errorCode=20006|Lead not exist/i.test(body);
}

// POST /notes — NOT /leads/{id}/notes, which 404s. See the header comment.
async function addLoftyNote(leadId, content, apiKey) {
  if (!leadId || !content || !apiKey) return { attempted: false };
  // leadId is sent as a Number because that is what works in
  // sellerintelligence; Lofty's ids are large but well inside 2^53.
  const numericId = Number(leadId);
  if (!Number.isFinite(numericId)) return { attempted: false, reason: "lead id not numeric" };
  try {
    const res = await loftyRequest("POST", "/notes", apiKey, {
      leadId: numericId, content,
    });
    // 2026-08-16, from Christine's live /status after a real submission. POST
    // /leads returned leadId 1147334685108095 and reported success -- then
    // POST /notes for that same id came back
    //   404 {"message":"...errorCode=20006,errorMsg=Lead not exist"}
    // while a DIFFERENT lead (1147802441137106) read back fine with HTTP 200.
    //
    // So the id Lofty returns when a submission MERGES into an existing contact
    // is the absorbed record, not the surviving one, and the survivor's id is
    // never disclosed. That is the whole explanation for why her repeat tests
    // left no timeline entry: the note had nowhere to go.
    //
    // Not fixable from here. Lofty's API offers no lookup-by-email (which is why
    // sellerintelligence resorts to paging all ~20k leads -- far too slow inside
    // a form handler), so there is no way to find the survivor. What IS worth
    // doing is naming the case precisely instead of reporting a bare 404: this
    // only happens on a merge, it never happens for a genuinely new contact, and
    // a new contact is every lead that matters commercially.
    const leadMissing = isLeadMissing(res);
    if (leadMissing) {
      console.warn(`Lofty note skipped: lead ${numericId} does not resolve (merged into an ` +
        `existing contact; Lofty does not return the surviving lead's id).`);
    } else if (!res.ok) {
      console.error(`Lofty note failed: HTTP ${res.httpStatus} ${res.text}`);
    }
    return {
      attempted: true, ok: res.ok, httpStatus: res.httpStatus, response: res.text,
      ...(leadMissing ? { leadMissing: true } : {}),
    };
  } catch (err) {
    console.error("Lofty note error:", err && err.message);
    return { attempted: true, ok: false, error: String(err && err.message) };
  }
}

// Returns the lead's current tags as strings, or NULL when they can't be read
// confidently. The null case matters more than it looks.
//
// 2026-08-15, reviewing this after her test still failed: the first version
// returned [] both when a lead genuinely had no tags AND when Lofty's response
// wasn't the shape I guessed. That second case is a data-loss bug. Lofty's GET
// response for a lead isn't something I can check from this environment
// (developer.lofty.com and api.lofty.com are both blocked by the egress proxy),
// and sellerintelligence only ever reads `lead.tags` on leads IT created. If
// this account returns tags as objects like [{name:"..."}] instead of plain
// strings, the filter would drop every one, the code would conclude the lead had
// no tags, and the very next PUT would overwrite the lead's whole tag list with
// just the trigger tag -- silently deleting whatever else was on a real client's
// record. A notification feature must not be able to do that.
//
// So: unreadable means null, null means make no changes at all, and the shape we
// actually got is reported to /site-health so this can be settled with evidence
// rather than another guess.
function tagsFromLead(payload) {
  const lead = (payload && (payload.data || payload)) || {};
  if (!Array.isArray(lead.tags)) return null;
  const strings = lead.tags.filter((t) => typeof t === "string");
  // Some tags present but none of them strings => a shape we don't understand.
  if (lead.tags.length > 0 && strings.length === 0) return null;
  return strings;
}

// Describes what came back, for the health page, without dumping lead data.
function describeTagShape(payload) {
  const lead = (payload && (payload.data || payload)) || {};
  if (!("tags" in lead)) return "response had no 'tags' field";
  if (!Array.isArray(lead.tags)) return `'tags' was ${typeof lead.tags}, not an array`;
  const kinds = Array.from(new Set(lead.tags.map((t) => (t === null ? "null" : typeof t))));
  return `'tags' was an array of ${lead.tags.length} item(s) of type ${kinds.join("/") || "—"}`;
}

// Guarantees that `triggerTag` counts as newly ADDED on this lead, so a Smart
// Plan triggered by it fires even when the lead already carried the tag from a
// previous enquiry.
//
// The remove-then-re-add is deliberate and the risk is handled: if the removal
// lands and the re-add does not, the lead would be left WITHOUT the tag, which
// is worse than where it started. So the re-add is retried once and the outcome
// is reported either way -- and if it still fails, tagRestored is false, which
// /site-health renders as a real problem rather than swallowing it.
async function refireLoftyTag(leadId, triggerTag, apiKey) {
  if (!leadId || !triggerTag || !apiKey) return { attempted: false };
  try {
    const current = await loftyRequest("GET", `/leads/${leadId}`, apiKey);
    if (!current.ok) {
      // Same ghost-id case as in addLoftyNote, reported under its own step so
      // /status can explain a merge rather than showing two identical 404s and
      // implying two separate faults.
      if (isLeadMissing(current)) {
        return {
          attempted: true, ok: false, step: "lead-missing", tagRestored: true,
          httpStatus: current.httpStatus, response: current.text,
        };
      }
      return { attempted: true, ok: false, step: "read", httpStatus: current.httpStatus, response: current.text };
    }
    const tags = tagsFromLead(current.json);
    if (tags === null) {
      // Don't touch the lead. Writing a tag list we can't reconcile with what's
      // already there risks wiping a real client's tags -- see tagsFromLead.
      const shape = describeTagShape(current.json);
      // 2026-08-16, SETTLED WITH EVIDENCE. Her /status?probe=1 read a real lead
      // back and reported: "response had no 'tags' field". So Lofty's
      // GET /leads/{id} does not return tags on this account at all -- it isn't a
      // shape I failed to parse, the data simply isn't in the response.
      //
      // That closes the question and kills the approach. A read-modify-write of
      // tags is impossible when the read returns no tags, so the re-fire that
      // would make a "Tag Added" Smart Plan trigger on a REPEAT enquiry cannot be
      // done safely through this API. The tag sent on the create call still lands
      // (Lofty appends tags on merge), so a genuinely new contact is fine; it is
      // the returning buyer that can't be re-triggered.
      //
      // Distinguished from a merely unfamiliar shape so /status can state the
      // limitation as a fact instead of asking her to report it again.
      const notReturned = /no 'tags' field/.test(shape);
      console.error(`Lofty tag refire skipped for lead ${leadId}: ${shape}.`);
      return {
        attempted: true, ok: false,
        step: notReturned ? "tags-not-returned" : "unreadable-tags",
        tagRestored: true, tagShape: shape,
      };
    }
    const had = tags.includes(triggerTag);

    if (!had) {
      // The create/merge did not leave the tag on the lead at all. Adding it now
      // is both the fix and the trigger, in one call.
      const withTag = tags.concat([triggerTag]);
      const put = await loftyRequest("PUT", `/leads/${leadId}`, apiKey, { tags: withTag });
      return {
        attempted: true, ok: put.ok, step: "added", tagRestored: put.ok,
        tagShape: describeTagShape(current.json), tagsSeen: tags.length,
        httpStatus: put.httpStatus, response: put.ok ? undefined : put.text,
      };
    }

    // Already tagged: take it off, put it back, so "Tag Added" is a real event.
    const without = tags.filter((t) => t !== triggerTag);
    const off = await loftyRequest("PUT", `/leads/${leadId}`, apiKey, { tags: without });
    if (!off.ok) {
      // Nothing was changed, so nothing needs undoing -- the lead keeps its tag.
      return {
        attempted: true, ok: false, step: "remove", tagRestored: true,
        tagShape: describeTagShape(current.json), tagsSeen: tags.length,
        httpStatus: off.httpStatus, response: off.text,
      };
    }
    let back = await loftyRequest("PUT", `/leads/${leadId}`, apiKey, { tags: tags });
    if (!back.ok) back = await loftyRequest("PUT", `/leads/${leadId}`, apiKey, { tags: tags });
    if (!back.ok) {
      console.error(`Lofty tag re-add FAILED for lead ${leadId} — "${triggerTag}" is currently off this lead: ` +
        `HTTP ${back.httpStatus} ${back.text}`);
    }
    return {
      attempted: true, ok: back.ok, step: "refired", tagRestored: back.ok,
      tagShape: describeTagShape(current.json), tagsSeen: tags.length,
      httpStatus: back.httpStatus, response: back.ok ? undefined : back.text,
    };
  } catch (err) {
    console.error("Lofty tag refire error:", err && err.message);
    return { attempted: true, ok: false, error: String(err && err.message) };
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The email she actually reads. Deliberately plain and information-dense: the
// subject line alone should be enough to decide whether to stop what she's
// doing, and every way of replying is one tap.
function alertEmailHtml({ name, email, phone, source, noteText, leadId, stamp }) {
  const rows = [
    ["Name", name || "(not given)"],
    ["Email", email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : "(not given)"],
    ["Phone", phone ? `<a href="tel:${escapeHtml(String(phone).replace(/[^\d+]/g, ""))}">${escapeHtml(phone)}</a>` : "(not given)"],
    ["Came from", source || "(unknown)"],
    ["Received", stamp],
  ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap">${k}</td>` +
    `<td style="padding:4px 0"><strong>${v}</strong></td></tr>`).join("");

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#222;max-width:560px">
<p style="font-size:18px;margin:0 0 4px"><strong>New website lead</strong></p>
<table style="border-collapse:collapse;margin:8px 0 16px">${rows}</table>
<p style="margin:0 0 4px;color:#666">What they said</p>
<pre style="white-space:pre-wrap;font:inherit;background:#f6f6f6;padding:12px;border-radius:6px;margin:0">${escapeHtml(noteText)}</pre>
${leadId ? `<p style="margin:16px 0 0"><a href="https://app.lofty.com/crm/leads/${escapeHtml(leadId)}">Open this lead in Lofty</a></p>` : ""}
<p style="margin:20px 0 0;font-size:12px;color:#888">Sent by signaturepropertycollection.com the moment the form was submitted. This does not depend on a Lofty Smart Plan — if this arrives, the lead was captured.</p>
</div>`;
}

// Emails Christine directly. Independent of Lofty entirely: this is the path
// that answers "i want to be notified immediatly".
async function sendLeadAlertEmail(details) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { attempted: false, reason: "RESEND_API_KEY not set" };

  const to = (process.env.LEAD_ALERT_TO || DEFAULT_TO)
    .split(",").map((s) => s.trim()).filter(Boolean);
  const from = process.env.LEAD_ALERT_FROM || DEFAULT_FROM;
  const who = details.name || details.email || details.phone || "someone";
  const subject = `New website lead: ${who}${details.sourceShort ? ` — ${details.sourceShort}` : ""}`;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        from, to, subject,
        // Reply hits the buyer directly, so answering is one tap from her phone.
        ...(details.email ? { reply_to: details.email } : {}),
        html: alertEmailHtml(details),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) console.error(`Resend lead alert failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return { attempted: true, ok: res.ok, httpStatus: res.status, response: text.slice(0, 300) };
  } catch (err) {
    console.error("Resend lead alert error:", err && err.message);
    return { attempted: true, ok: false, error: String(err && err.message) };
  }
}

module.exports = {
  LOFTY_BASE_URL,
  DEFAULT_FROM,
  DEFAULT_TO,
  addLoftyNote,
  refireLoftyTag,
  isLeadMissing,
  tagsFromLead,
  describeTagShape,
  alertEmailHtml,
  sendLeadAlertEmail,
};
