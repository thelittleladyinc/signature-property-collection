// What this site has spent at MLS Grid, hour by hour.
//
// 2026-08-18. Christine's Expired-Luxury app has `/api/admin/mls-usage` and it is
// the single most useful thing any of her three MLS Grid integrations has: it can
// answer "what did we spend in the last hour" from its own records, before MLS
// Grid has to tell it. This site had nothing of the kind, which is the whole
// reason two days went into diagnosing grey photos and NEXT-SESSION §2.6 still
// ended in a guess about a shared quota.
//
// It is also the honest counterpart to the MLS Grid usage tab: theirs is the
// truth for the ACCOUNT (all three apps together), this one is the truth for THIS
// SITE. Comparing the two is the only way to attribute consumption while all
// three apps share one token -- which is exactly the question the support email
// in docs/MLS-GRID-QUOTA.md asks, and this answers half of it without waiting for
// a reply.
//
// Deliberately public and read-only. It exposes counts and byte totals, no
// listing data, no token, no URLs -- nothing that isn't already implied by the
// site being up. Requiring a login would mean Christine cannot check it from her
// phone, which is when she actually wants it.
const { getStore } = require("@netlify/blobs");
const { getBlobStore } = require("./lib/_mls-shared");
const { checkMlsQuota, RETENTION_HOURS } = require("./lib/_mls-usage");

const BLOB_STORE_NAME = "mls-listings";

// A number a person can act on, rather than one they have to divide in their head.
function pct(used, budget) {
  if (!budget) return 0;
  return Math.round((used / budget) * 100);
}

exports.handler = async (event) => {
  const params = (event && event.queryStringParameters) || {};
  try {
    const store = getBlobStore(getStore, BLOB_STORE_NAME);
    const q = await checkMlsQuota(store, { full: true });

    // The headline: are we near anything, and which thing. Written as a sentence
    // because the point of this endpoint is to be readable at a glance on a phone.
    let summary;
    if (q.disabled) {
      summary = "MLS Grid is switched OFF on this site (MLS_DISABLED is set). No requests are being made.";
    } else if (q.blocked) {
      summary = `BLOCKED: ${q.reason}. Photos not already stored will show a placeholder until this clears.`;
    } else {
      const worst = Math.max(
        pct(q.hourRequests, q.hourRequestBudget),
        pct(q.hourMB, q.hourMBBudget),
        pct(q.dayRequests || 0, q.dayRequestBudget),
        pct(q.dayMB || 0, q.dayMBBudget),
      );
      summary = `Normal. Peak usage is ${worst}% of this site's self-imposed budget ` +
        `(which is ${Math.round(q.safetyFraction * 100)}% of MLS Grid's real limit).`;
    }

    const body = {
      summary,
      blocked: q.blocked,
      disabled: q.disabled,
      reason: q.reason || null,
      thisHour: {
        requests: q.hourRequests,
        mb: q.hourMB,
        requestBudget: q.hourRequestBudget,
        mbBudget: q.hourMBBudget,
        requestsPctOfBudget: pct(q.hourRequests, q.hourRequestBudget),
        mbPctOfBudget: pct(q.hourMB, q.hourMBBudget),
      },
      last24h: {
        requests: q.dayRequests ?? null,
        mb: q.dayMB ?? null,
        apiCalls: q.dayApi ?? null,
        mediaDownloads: q.dayMedia ?? null,
        errors: q.dayErrors ?? null,
        requestBudget: q.dayRequestBudget,
        mbBudget: q.dayMBBudget,
      },
      // The split nobody could see before, and the one that mattered: api.mlsgrid.com
      // (listing lookups) versus media.mlsgrid.com (photo downloads). The 429s were
      // always on the second, while every fix was aimed at the first.
      limits: {
        source: "MLS Grid suspension notice, 2026-08-01 (not the public docs — see docs/MLS-GRID-QUOTA.md §1)",
        hourRequests: q.limits.hourRequests,
        hourMB: q.limits.hourMB,
        dayRequests: q.limits.dayRequests,
        dayMB: q.limits.dayMB,
        note: "4 rps is the instantaneous ceiling; 2 rps is the sustained hourly average, " +
          "which is the same statement as 7,200/hour and is the one that suspends a token.",
      },
      // Only what we ourselves are responsible for. The account total, across all
      // three of Christine's apps, is at app.mlsgrid.com/subs/view/usage/.
      scope: "this Netlify site only — NOT the whole MLS Grid account",
      accountUsageTab: "https://app.mlsgrid.com/subs/view/usage/",
      retentionHours: RETENTION_HOURS,
    };
    if (params.hours === "1" || params.verbose === "1") body.hourly = q.hours || [];

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Short, but not zero: refreshing this page must not itself become a
        // meaningful load on the blob store during an incident.
        "Cache-Control": "public, max-age=30",
      },
      body: JSON.stringify(body, null, 2),
    };
  } catch (err) {
    console.error("mls-usage error:", err && err.message);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        summary: "Could not read the usage log. That is itself worth knowing: the quota " +
          "guard fails CLOSED when it cannot prove we are under budget, so MLS Grid " +
          "requests are being refused while this is broken.",
        error: err && err.message,
      }, null, 2),
    };
  }
};
