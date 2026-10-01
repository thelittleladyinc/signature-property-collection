const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const phone = '9705550199';
const quiet = { warn() {}, info() {}, error() {} };
const targets = [['signature-property-collection', 'netlify/functions/lib/_lofty-consent.js', false]];

for (const [name, file, listingEngine] of targets) {
  const client = require(path.join(root, file));
  const consentTag = client.CONSENT_TAG || client.SMS_CONSENT_TAG;
  async function run(lead, options = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
      const status = init.method === 'GET' ? (options.readStatus || 200) : (options.writeStatus || 200);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(init.method === 'GET' ? lead : {}),
      };
    };
    const deps = { apiKey: 'offline-test-key', fetchImpl, log: quiet };
    let result;
    let error;
    try {
      result = listingEngine
        ? await client.mergeIntoLead('777', { smsConsent: { phone }, addTags: options.addTags || [] }, deps)
        : await client.applyTextingConsent('777', phone, deps.apiKey, deps);
    } catch (caught) { error = caught; }
    return { result, error, calls, writes: calls.filter((c) => c.method === 'PUT') };
  }

  const dncTags = [
    'Consent \u2013 DNC', 'Consent - DNC', 'Consent \u2014 DNC',
    'Consent \u2011 DNC', 'Consent \u2012 DNC',
    '  cOnSeNt - dNc  ', { tagName: 'Consent \u2013 DNC' }, { name: 'Consent - DNC' },
  ];
  for (const dnc of dncTags) {
    for (const cannotText of [true, false, undefined]) {
      test(`${name}: DNC defeats a yes (${JSON.stringify(dnc)}, cannotText=${cannotText})`, async () => {
        const lead = { leadId: 777, tags: ['Existing Tag', dnc], phones: [phone], cannotText };
        const out = await run({ lead });
        assert.equal(out.error, undefined);
        assert.deepEqual(out.writes, [], 'DNC must not permit texting or consent-tag writes');
        assert.equal(out.result.consentApplied || out.result.textingEnabled || false, false);
        assert.match(out.result.textingNotEnabled, /Do Not Contact/i);
      });
    }
  }

  test(`${name}: email-only DNC does not block otherwise valid SMS consent`, async () => {
    const out = await run({ data: { id: 777, tags: ['Consent - DNC Email'], phones: [phone], cannotText: true } });
    assert.equal(out.error, undefined);
    assert.equal(out.writes.length, 1);
    assert.equal(out.writes[0].body.cannotText, false);
    assert.ok(out.writes[0].body.tags.includes(consentTag));
    assert.ok(out.writes[0].body.tags.includes('Consent - DNC Email'));
  });

  test(`${name}: valid consent preserves existing tags`, async () => {
    const out = await run({ id: 777, tags: ['Old', 'old', 'Another Tag'], phones: [phone], cannotText: true });
    assert.equal(out.writes.length, 1);
    assert.deepEqual(out.writes[0].body.tags, ['Old', 'old', 'Another Tag', consentTag]);
    assert.equal(out.writes[0].body.cannotText, false);
  });

  for (const tags of [undefined, null, [{ tagId: 1 }]]) {
    test(`${name}: unreadable tags hold consent (${JSON.stringify(tags)})`, async () => {
      const out = await run({ id: 777, tags, phones: [phone], cannotText: true });
      assert.deepEqual(out.writes, []);
      assert.ok(out.error || out.result.textingNotEnabled);
    });
  }

  test(`${name}: different record never gets updated`, async () => {
    const out = await run({ id: 999, tags: [], phones: [phone], cannotText: true });
    assert.deepEqual(out.writes, []);
    assert.ok(out.error || out.result.textingNotEnabled);
  });

  test(`${name}: second non-consented phone holds consent`, async () => {
    const out = await run({ id: 777, tags: [], phones: [phone, '9705550123'], cannotText: true });
    assert.deepEqual(out.writes, []);
    assert.match(out.result.textingNotEnabled, /another|number/i);
  });

  test(`${name}: read failures never enable texting`, async () => {
    const out = await run({}, { readStatus: 500 });
    assert.deepEqual(out.writes, []);
    assert.ok(out.error || out.result.textingNotEnabled);
  });

  test(`${name}: failed writes do not report successful consent`, async () => {
    const out = await run({ id: 777, tags: [], phones: [phone], cannotText: true }, { writeStatus: 500 });
    assert.equal(out.writes.length, 1);
    assert.ok(out.error || !out.result.textingEnabled);
  });

  if (listingEngine) {
    test(`${name}: DNC keeps all old tags and permits a non-consent tag update`, async () => {
      const out = await run({ id: 777, tags: ['Consent - DNC', 'Old', 'old'], phones: [phone], cannotText: true }, { addTags: ['Buyer Lead'] });
      assert.equal(out.writes.length, 1);
      assert.deepEqual(out.writes[0].body, { tags: ['Consent - DNC', 'Old', 'old', 'Buyer Lead'] });
      assert.equal(out.result.consentApplied, false);
      assert.match(out.result.textingNotEnabled, /Do Not Contact/i);
    });
  }
}
