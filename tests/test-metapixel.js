// The Meta Pixel waits for a person before it loads (2026-09-29).
//
// PageSpeed scored Signature's home page 68 on mobile with fbevents.js injected
// the moment the page opened: 258 KiB and ~270 ms of main-thread time from
// Facebook's CDN, plus the "efficient cache lifetimes" and unused-JS flags. The
// Little Lady measured the same regression on 2026-08-26 (92 -> 70) and fixed it
// by injecting the script on the first scroll, tap, key or pointer, or when the
// tab is hidden. This suite runs the SHIPPED snippet (built with a pixel ID, the
// way Netlify builds it) against a fake page and pins:
//   - nothing from Facebook loads during page load on an ordinary page;
//   - the first interaction loads it, exactly once, and the queued init/PageView
//     are still there for it to send;
//   - a background tab that turns visible and is then left still loads it;
//   - the thank-you page loads it straight away, because a conversion queued there
//     would otherwise wait for a scroll that a "thanks, bye" visitor never makes;
//   - the head hint for Facebook is dns-prefetch, gated on the pixel ID.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const PID = "785995940287531";
// Import build.py (it has a __main__ guard, so nothing is built) with the pixel on.
const tag = execFileSync("python3", ["-c", [
  "import importlib.util, sys",
  "spec = importlib.util.spec_from_file_location('spc_build', 'build/build.py')",
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "sys.stdout.write(m._meta_pixel_tag())",
].join("\n")], { cwd: ROOT, env: { ...process.env, META_PIXEL_ID: PID, GA_MEASUREMENT_ID: "" }, encoding: "utf8" });
const js = (tag.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || "";

function page(pathname) {
  const listeners = {};
  const inserted = [];
  const document = {
    visibilityState: "visible",
    createElement: (tagName) => ({ tagName }),
    getElementsByTagName: () => [{ parentNode: { insertBefore: (el) => inserted.push(el) } }],
    addEventListener: (type, fn, opts) => { (listeners[type] = listeners[type] || []).push({ fn, once: !!(opts && opts.once) }); },
  };
  // The page's global object IS window, as in a browser: the snippet sets
  // window.fbq and then calls the bare global fbq(...).
  const window = vm.createContext({ location: { pathname }, document });
  window.window = window;
  const fire = (type) => {
    const ls = listeners[type] || [];
    listeners[type] = ls.filter((l) => !l.once);
    for (const l of ls) l.fn({ target: null });
  };
  vm.runInContext(js, window);
  return { window, document, inserted, fire };
}

console.log("\n1. The snippet as Netlify builds it");
check("a pixel ID produces a snippet", js.length > 0 && tag.includes(`fbq('init','${PID}')`));
check("the noscript fallback is still there", tag.includes(`tr?id=${PID}&ev=PageView&noscript=1`));

console.log("\n2. An ordinary page loads nothing from Facebook until a person does something");
let p = page("/");
check("no script is inserted during page load", p.inserted.length === 0, `${p.inserted.length} inserted`);
const queued = (p.window.fbq && p.window.fbq.queue) || [];
check("init and PageView are queued, waiting for it", queued.length === 2 &&
  queued[0][0] === "init" && queued[0][1] === PID && queued[1][0] === "track" && queued[1][1] === "PageView",
  JSON.stringify(queued.map((a) => [...a])));
p.fire("scroll");
check("the first scroll loads fbevents.js", p.inserted.length === 1 && /connect\.facebook\.net\/en_US\/fbevents\.js$/.test(p.inserted[0].src));
p.fire("pointerdown"); p.fire("keydown");
check("...exactly once", p.inserted.length === 1, `${p.inserted.length} inserted`);
for (const ev of ["pointerdown", "keydown", "touchstart"]) {
  const q = page("/communities/loveland.html");
  q.fire(ev);
  check(`a ${ev} loads it too`, q.inserted.length === 1);
}

console.log("\n3. Visitors who never interact still count");
p = page("/");
p.document.visibilityState = "hidden"; p.fire("visibilitychange");
check("leaving the tab (hidden) loads it", p.inserted.length === 1);
p = page("/");
p.document.visibilityState = "visible"; p.fire("visibilitychange");
check("a background tab turning visible doesn't load it...", p.inserted.length === 0);
p.document.visibilityState = "hidden"; p.fire("visibilitychange");
check("...and doesn't use up the listener: leaving afterwards still loads it", p.inserted.length === 1);

console.log("\n4. The thank-you page loads it straight away");
for (const tp of ["/thank-you.html", "/thank-you", "/thank-you/"]) {
  check(`${tp}: loaded during page load`, page(tp).inserted.length === 1);
}
check("a page that merely starts with thank-you is an ordinary page", page("/thank-you-notes.html").inserted.length === 0);
check("so is a thank-you page somewhere else", page("/blog/thank-you.html").inserted.length === 0);

console.log("\n5. The head hint matches");
const buildPy = fs.readFileSync(path.join(ROOT, "build", "build.py"), "utf8");
check("connect.facebook.net gets dns-prefetch, gated on META_PIXEL_ID",
  /'<link rel="dns-prefetch" href="https:\/\/connect\.facebook\.net">' if META_PIXEL_ID else ''/.test(buildPy));
check("and no longer a preconnect (a connection most visitors would never use)",
  !/rel="preconnect" href="https:\/\/connect\.facebook\.net"/.test(buildPy));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
