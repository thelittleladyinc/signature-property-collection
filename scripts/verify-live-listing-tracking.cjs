'use strict';
// Read-only acceptance check of the ACTUAL public Little Lady listing page.
// Unlike the local shell test, this validates the HTTP response after Netlify's
// redirect/proxy path. Does not execute JavaScript, fire pixels or submit a form.
// Run manually: node scripts/verify-live-listing-tracking.cjs
const assert = require('node:assert/strict');
const DEFAULT_URL = 'https://www.thelittleladysellshomes.com/listing/IRE1059808';
const URL_TO_TEST = process.env.LIVE_LISTING_URL || DEFAULT_URL;
const count = (s, value) => s.split(value).length - 1;
(async () => {
  const target = new URL(URL_TO_TEST);
  assert.equal(target.protocol, 'https:', 'HTTPS required');
  assert.equal(target.hostname, 'www.thelittleladysellshomes.com', 'Only the Little Lady production host is allowed');
  assert.match(target.pathname, /^\/listing\/[A-Za-z0-9_-]+$/, 'Only a listing page is allowed');
  const resp = await fetch(target, {
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
    headers: { 'Accept': 'text/html', 'User-Agent': 'LLSH-read-only-tracking-verification/1.0' },
  });
  if (!resp.ok) throw new Error('Live listing page did not return HTTP 200: '+resp.status);
  if (!/^text\/html/i.test(resp.headers.get('content-type') || ''))
    throw new Error('Live listing route did not return HTML');
  if (new URL(resp.url).hostname !== target.hostname)
    throw new Error('Live listing page redirected away from the Little Lady production host');
  const html = await resp.text();
  assert.ok(html.length > 500, 'HTML response is unexpectedly short');
  const expected = [
    ["GA4 loader", 'googletagmanager.com/gtag/js?id=G-4Q36KQWK2M'],
    ["GA4 config", "gtag('config','G-4Q36KQWK2M')"],
    ["Meta pixel ID", "fbq('init','785995940287531')"],
    ["Meta PageView", "fbq('track','PageView')"],
  ];
  for (const [name, needle] of expected) {
    const matches = count(html, needle);
    assert.equal(matches, 1, name+' should occur exactly once on production page, got '+matches);
  }
  assert.ok(!html.includes('1292637128972060'), 'Retired pixel is on the live page');
  assert.ok(!html.includes('1772864573240190'), 'StreetText pixel appeared on the live listing page');
  assert.ok(!/fbq\(['"]track['"],\s*['"]Lead['"]/.test(html), 'Listing view may not fire a Lead event');
  console.log('PASS: public live listing HTTP 200; GA4 and correct Meta Pixel/PageView appear exactly once; no false Lead or retired pixels.');
  console.log('Verified URL: '+target.origin+target.pathname);
  console.log('Note: this validates served HTML only. Actual event reception still needs Meta Events Manager and GA4 realtime receipts.');
})().catch(e => { console.error('LIVE_LISTING_TRACKING_NOT_VERIFIED: '+e.message); process.exitCode=1; });
