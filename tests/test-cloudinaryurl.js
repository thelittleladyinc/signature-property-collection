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

// ---- 2026-08-18: the delivery URL, and the dead code that used to hide it ----
// uploadDataUri() carried an unreachable duplicate of the delivery-URL block after
// its own `return`, referencing a `result` variable that was never declared in that
// scope. It could not run, so it was harmless — right up until someone tidied the
// return above it. One copy now, exported, and tested rather than assumed.
{
  const lib = require(path.join(ROOT, "netlify", "functions", "lib", "_cloudinary.js"));
  check("deliveryUrl is exported rather than inlined twice",
    typeof lib.deliveryUrl === "function");
  check("bytes we already hold can be uploaded without re-downloading them",
    typeof lib.uploadBufferToCloudinary === "function",
    "an oversize photo is downloaded before we learn it is too big — going back for it again " +
    "would break 'there is NEVER a reason to download the same media more than once'");

  const src = fs.readFileSync(path.join(ROOT, "netlify", "functions", "lib", "_cloudinary.js"), "utf8");
  const upload = src.slice(src.indexOf("async function uploadDataUri("));
  const body = upload.slice(0, upload.indexOf("\n}"));
  check("uploadDataUri has no unreachable code after its return",
    !/return cloudinary\.uploader[\s\S]*?\breturn\b/.test(body),
    "a second return after the first is dead code, and this one referenced an undeclared variable");
  check("and no undeclared `result` is read anywhere in it",
    !/if \(!result\.secure_url\)/.test(body),
    "this line was a ReferenceError waiting for whoever removed the return above it");
}

// ---- 2026-08-18: the paste Cloudinary's own UI gives you --------------------
// Its API Keys page displays the value as "CLOUDINARY_URL=cloudinary://..." and
// the copy button includes the prefix. Pasting that into Netlify produced a value
// the parser rejected, and the rejection fell back SILENTLY to the three separate
// variables — which still pointed at the OLD cloud. Switching accounts would have
// appeared to work and changed nothing.
{
  const lib = require(path.join(ROOT, "netlify", "functions", "lib", "_cloudinary.js"));
  const saved = process.env.CLOUDINARY_URL;
  const savedTrio = [process.env.CLOUDINARY_CLOUD_NAME, process.env.CLOUDINARY_API_KEY, process.env.CLOUDINARY_API_SECRET];
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;

  for (const [label, value] of [
    ["the bare connection string", "cloudinary://123:abc@dcim65cok"],
    ["the vendor's copied line, prefix and all", "CLOUDINARY_URL=cloudinary://123:abc@dcim65cok"],
    ["a lowercase prefix", "cloudinary_url=cloudinary://123:abc@dcim65cok"],
    ["a prefix with spaces around the equals", "CLOUDINARY_URL = cloudinary://123:abc@dcim65cok"],
    ["a value someone quoted", '"cloudinary://123:abc@dcim65cok"'],
  ]) {
    process.env.CLOUDINARY_URL = value;
    const c = lib.cloudinaryCredentials();
    check(`${label} resolves to the right cloud`,
      !!c && c.cloud_name === "dcim65cok" && c.api_key === "123" && c.api_secret === "abc",
      c ? JSON.stringify(c) : "parsed to nothing — this is the silent switch-that-does-nothing bug");
  }

  // Still strict about the thing that actually matters.
  process.env.CLOUDINARY_URL = "CLOUDINARY_URL=not-a-connection-string";
  check("but genuine nonsense is still refused rather than half-parsed",
    lib.cloudinaryCredentials() === null,
    "a half-parsed string configures the SDK with something wrong");

  if (saved === undefined) delete process.env.CLOUDINARY_URL; else process.env.CLOUDINARY_URL = saved;
  const keys = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  keys.forEach((k, i) => { if (savedTrio[i] !== undefined) process.env[k] = savedTrio[i]; });
}

// ---- 2026-08-18: moving the site to its own Cloudinary account ------------
// Christine's website and Listing-Engine were on the same cloud ("listingengine",
// confirmed from Render's own env vars), sharing one 25-credit free tier that
// Listing-Engine drains generating fourteen social variants per photo. She is
// moving the site to a separate account.
//
// Her eleven listings were already re-hosted — on the OLD cloud — and the sync
// skips any photo it believes is cached. Without this, those eleven would stay on
// an account the website no longer controls, indefinitely, and nothing would say so.
{
  const lib = require(path.join(ROOT, "netlify", "functions", "lib", "_cloudinary.js"));
  const saved = process.env.CLOUDINARY_URL;
  process.env.CLOUDINARY_URL = "cloudinary://123:abc@dcim65cok";

  check("the cloud in a stored URL is read correctly",
    lib.cloudNameOfUrl("https://res.cloudinary.com/listingengine/image/upload/v1/x.jpg") === "listingengine");
  check("a photo on the cloud we use now still counts as cached",
    lib.isOnCurrentCloud("https://res.cloudinary.com/dcim65cok/image/upload/v1/x.jpg") === true);
  check("a photo on the OLD cloud does NOT",
    lib.isOnCurrentCloud("https://res.cloudinary.com/listingengine/image/upload/v1/x.jpg") === false,
    "otherwise her eleven listings stay on an account this site no longer controls");
  check("and the sync re-hosts exactly those",
    /const already = stored\.map\(\(u\) => \(u && !isOnCurrentCloud\(u\) \? null : u\)\)/
      .test(require("fs").readFileSync(path.join(ROOT, "netlify", "functions", "sync-listings.js"), "utf8")),
    "the migration has to happen by itself — nobody is going to hand-edit blobs");

  // Not configured: compare against nothing, change nothing. Re-hosting every
  // photo because an env var is missing would be a far worse failure than leaving
  // them where they are.
  delete process.env.CLOUDINARY_URL;
  const trio = [process.env.CLOUDINARY_CLOUD_NAME, process.env.CLOUDINARY_API_KEY, process.env.CLOUDINARY_API_SECRET];
  delete process.env.CLOUDINARY_CLOUD_NAME;
  check("with no Cloudinary configured, nothing is declared stranded",
    lib.isOnCurrentCloud("https://res.cloudinary.com/anything/image/upload/v1/x.jpg") === true,
    "a missing env var must not trigger a mass re-upload");
  check("a non-Cloudinary URL is left alone too",
    lib.isOnCurrentCloud("https://media.mlsgrid.com/token=x/images/y.jpg") === true);

  if (saved === undefined) delete process.env.CLOUDINARY_URL; else process.env.CLOUDINARY_URL = saved;
  ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]
    .forEach((k, i) => { if (trio[i] !== undefined) process.env[k] = trio[i]; });
}

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
