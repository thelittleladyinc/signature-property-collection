// CLOUDINARY_URL: one variable that cannot be assembled wrongly.
//
// 2026-08-17. Christine hit both failure modes of the three-variable shape inside
// an hour, and neither was carelessness:
//
//   1. CLOUDINARY_CLOUD_NAME set to the API key's NAME ("Signature Property
//      Collection") instead of the cloud name.
//   2. An api_key from one key row paired with the api_secret from another —
//      reported as "api_secret mismatch", which is accurate and says nothing about
//      which of the two is wrong.
//
// That console lists several keys, each with its own secret behind a reveal
// control, and nothing on the page stops you combining two rows. The three-variable
// shape is what makes a wrong combination possible at all. Cloudinary's own
// connection string carries all three values from one key as a matched set.
//
// What this suite protects is that the option actually works, that it is preferred,
// that a malformed string fails SAFE rather than half-configuring the SDK, and that
// the health page tests the same credentials the uploads use.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const LIB = path.join(ROOT, "netlify", "functions", "lib", "_cloudinary.js");
const { cloudinaryCredentials, isCloudinaryConfigured } = require(LIB);

const ENV = ["CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
function withEnv(vals, fn) {
  const saved = {};
  ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.entries(vals).forEach(([k, v]) => { process.env[k] = v; });
  try { return fn(); }
  finally {
    ENV.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
  }
}

// --- The string parses, and into the right slots. Order matters and is easy to get
// backwards: the KEY is the user part and the CLOUD NAME is the host.
withEnv({ CLOUDINARY_URL: "cloudinary://717814541125388:s3cr3t-value@listingengine" }, () => {
  const c = cloudinaryCredentials();
  check("CLOUDINARY_URL parses", !!c);
  check("  api_key comes from the user part", c && c.api_key === "717814541125388");
  check("  api_secret from the password part", c && c.api_secret === "s3cr3t-value");
  check("  cloud_name from the host part", c && c.cloud_name === "listingengine");
  check("  and it counts as configured", isCloudinaryConfigured() === true);
});

// --- It must WIN over the three separate vars, or setting it fixes nothing while
// the old mismatched pair is still present.
withEnv({
  CLOUDINARY_URL: "cloudinary://newkey:newsecret@listingengine",
  CLOUDINARY_CLOUD_NAME: "the-little-lady",
  CLOUDINARY_API_KEY: "oldkey",
  CLOUDINARY_API_SECRET: "oldsecret",
}, () => {
  const c = cloudinaryCredentials();
  check("CLOUDINARY_URL takes precedence over the three separate vars",
    c && c.api_key === "newkey" && c.cloud_name === "listingengine",
    "otherwise pasting it would appear to do nothing while the old pair still wins");
});

// --- The old shape still works. Nothing already configured may break.
withEnv({
  CLOUDINARY_CLOUD_NAME: "listingengine",
  CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
}, () => {
  const c = cloudinaryCredentials();
  check("the three separate variables still work on their own",
    c && c.cloud_name === "listingengine" && c.api_key === "k");
});

// --- A malformed string must fail SAFE. Half-parsing it would configure the SDK
// with something wrong and produce a confusing auth error two layers away, which is
// the exact class of problem this exists to remove.
for (const bad of [
  "listingengine",                                  // just the cloud name
  "cloudinary://listingengine",                     // no credentials
  "cloudinary://key@listingengine",                 // no secret
  "https://api.cloudinary.com/v1_1/listingengine",  // an API URL, not the string
]) {
  withEnv({ CLOUDINARY_URL: bad }, () => {
    check(`a malformed CLOUDINARY_URL is ignored: ${bad.slice(0, 34)}`,
      cloudinaryCredentials() === null,
      "half-parsing produces an auth error two layers from the real cause");
  });
  // ...and must not mask a working three-var setup that is also present.
  withEnv({
    CLOUDINARY_URL: bad,
    CLOUDINARY_CLOUD_NAME: "listingengine", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
  }, () => {
    const c = cloudinaryCredentials();
    check(`  and falls back to the working vars: ${bad.slice(0, 26)}`,
      c && c.cloud_name === "listingengine");
  });
}

// --- Nothing set at all is not configured, rather than partially configured.
withEnv({}, () => {
  check("no credentials at all reads as not configured",
    cloudinaryCredentials() === null && isCloudinaryConfigured() === false);
});
withEnv({ CLOUDINARY_CLOUD_NAME: "listingengine" }, () => {
  check("a partial three-var setup is not configured",
    cloudinaryCredentials() === null,
    "configuring with a missing secret produces a misleading auth failure");
});

// --- The health page must test the SAME credentials the uploads use. A health check
// that reads different env vars than the code it checks is worse than none.
const health = fs.readFileSync(path.join(ROOT, "netlify", "functions", "site-health.js"), "utf8");
check("site-health resolves credentials through the shared helper",
  /cloudinaryCredentials\(\)/.test(health),
  "it would otherwise silently test the wrong thing once CLOUDINARY_URL is used");
const probeAt = health.indexOf("async function probeCloudinaryUsage(");
const probe = probeAt === -1 ? "" : health.slice(probeAt, health.indexOf("\n}", probeAt));
check("and the account probe no longer reads the raw env vars directly",
  !/api_secret:\s*process\.env\.CLOUDINARY_API_SECRET/.test(probe),
  "the probe would keep checking the three vars while uploads used the URL");

// --- And the advice names the fix that removes the mistake, not one that repeats it.
check("the api_secret-mismatch advice points at CLOUDINARY_URL",
  /api_secret mismatch[\s\S]{0,900}?CLOUDINARY_URL/.test(health),
  "telling her to re-pair two values by hand invites the same mistake again");

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
