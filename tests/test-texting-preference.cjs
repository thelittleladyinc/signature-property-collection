const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const client = require(path.join(root, 'netlify/functions/lib/_lofty-consent'));
const phone = '9705550199';
const oldPhone = '9705550123';
const consentTag = client.CONSENT_TAG;
const oldTags = ['Past Client', consentTag];
const quiet = { log() {}, warn() {}, error() {} };

function fake(lead, options = {}) {
  const state = { lead: structuredClone(lead), calls: [] };
  state.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ url: String(url), method, body });
    let status = method === 'PUT' ? (options.writeStatus || 200) : (options.readStatus || 200);
    let result = {};
    if (method === 'GET' && String(url).includes('/leads?')) {
      status = 200;
      result = { leads: String(url).includes('email=')
        ? (options.emailHits || [{ leadId: 777, emails: ['pat@example.com'] }])
        : (options.phoneHits || []) };
    } else if (method === 'POST' && String(url).endsWith('/leads')) {
      status = 200;
      result = { leadId: 777 };
    } else if (method === 'GET' && String(url).endsWith('/leads/777')) {
      result = { data: state.lead };
    } else if (method === 'PUT' && status === 200) Object.assign(state.lead, body);
    const text = JSON.stringify(result);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => result };
  };
  return state;
}

async function preference(lead, given = false, options = {}) {
  const f = fake(lead, options);
  const result = await client.applyTextingPreference(options.id || '777', options.phone ?? phone,
    given, 'offline-key', { fetchImpl: f.fetch });
  return { ...f, result, writes: f.calls.filter((c) => c.method === 'PUT') };
}

for (const cannotText of [false, undefined, true]) {
  test(`new number with no yes enforces off (cannotText=${cannotText})`, async () => {
    const out = await preference({ id: 777, phones: [oldPhone], tags: oldTags, cannotText });
    assert.deepEqual(out.writes.map((w) => w.body), cannotText === true ? [] : [{ cannotText: true }]);
    assert.equal(out.lead.cannotText, true);
    assert.deepEqual(out.lead.phones, [oldPhone]);
    assert.deepEqual(out.lead.tags, oldTags);
    assert.equal(out.result.textingEnabled, false);
  });
}

test('same known number without yes preserves existing consent', async () => {
  const out = await preference({ id: 777, phones: [phone], tags: oldTags, cannotText: false });
  assert.deepEqual(out.writes, []);
  assert.equal(out.lead.cannotText, false);
  assert.deepEqual(out.lead.tags, oldTags);
});

test('a create that already appended the new number still turns texting off without a yes', async () => {
  const out = await preference({ id: 777, phones: [oldPhone, phone], tags: oldTags, cannotText: false });
  assert.deepEqual(out.writes.map((w) => w.body), [{ cannotText: true }]);
  assert.deepEqual(out.lead.phones, [oldPhone, phone]);
});

test('blank phone without yes does not revoke unrelated existing consent', async () => {
  const out = await preference({ id: 777, phones: [oldPhone], tags: oldTags, cannotText: false }, false, { phone: '' });
  assert.deepEqual(out.writes, []);
});

test('objects and singular phone count as the known number', async () => {
  const out = await preference({ id: 777, phones: [{ number: '+1 (970) 555-0199' }], phone, tags: oldTags, cannotText: false });
  assert.deepEqual(out.writes, []);
});

test('a new number can safely turn texting off even if tags are unreadable', async () => {
  const out = await preference({ id: 777, phones: [oldPhone], cannotText: false });
  assert.deepEqual(out.writes.map((w) => w.body), [{ cannotText: true }]);
  assert.equal('tags' in out.lead, false);
});

for (const given of [false, true]) {
  test(`DNC turns an inconsistent textable record off (given=${given})`, async () => {
    const tags = [...oldTags, 'Consent – DNC'];
    const out = await preference({ id: 777, phones: [phone], tags, cannotText: false }, given);
    assert.deepEqual(out.writes.map((w) => w.body), [{ cannotText: true }]);
    assert.deepEqual(out.lead.tags, tags);
    assert.equal(out.result.textingEnabled, false);
  });
}

test('DNC wins even when no phone was submitted', async () => {
  const out = await preference({ id: 777, tags: ['Consent - DNC'], cannotText: false }, true, { phone: '' });
  assert.deepEqual(out.writes.map((w) => w.body), [{ cannotText: true }]);
});

test('held yes for multiple numbers turns an inconsistent textable record off', async () => {
  const out = await preference({ id: 777, phones: [phone, oldPhone], tags: oldTags, cannotText: false }, true);
  assert.deepEqual(out.writes.map((w) => w.body), [{ cannotText: true }]);
  assert.deepEqual(out.lead.phones, [phone, oldPhone]);
});

test('confirmed yes for the only phone enables with tags merged', async () => {
  const out = await preference({ id: 777, phones: [phone], tags: ['Past Client'], cannotText: true }, true);
  assert.deepEqual(out.writes.map((w) => w.body), [{ cannotText: false, tags: ['Past Client', consentTag] }]);
});

for (const lead of [{ id: 888, phones: [oldPhone], tags: oldTags, cannotText: false },
  { id: 777, phones: [{ unknown: phone }], tags: oldTags, cannotText: false }]) {
  test(`unverified identity or phone never writes (${JSON.stringify(lead)})`, async () => {
    const out = await preference(lead);
    assert.deepEqual(out.writes, []);
    assert.equal(out.result.ok, false);
  });
}

test('read failure never writes', async () => {
  const out = await preference({ id: 777 }, false, { readStatus: 500 });
  assert.deepEqual(out.writes, []);
});

test('failed safe-off write never claims texting was disabled', async () => {
  const out = await preference({ id: 777, phones: [oldPhone], tags: oldTags, cannotText: false }, false, { writeStatus: 500 });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.textingDisabled, false);
  assert.equal(out.result.textingEnabled, true);
  assert.match(out.result.textingNotEnabled, /manual review/);
});

for (const id of ['wrong777', Number.MAX_SAFE_INTEGER + 1]) {
  test(`unsafe target id is refused before any request (${id})`, async () => {
    const out = await preference({ id: 777 }, false, { id });
    assert.deepEqual(out.calls, []);
  });
}

// Execute the real handler and queue with only unrelated services stubbed.
function loadFlow(f, store) {
  const modules = new Map();
  function load(file) {
    const filename = path.resolve(root, 'netlify/functions', file);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    function requireLocal(name) {
      if (name === '@netlify/blobs') return { getStore: () => store };
      if (/\/_mls-shared$/.test(name)) return { getBlobStore: () => store, inferCountyFromCity: () => null };
      if (/\/_notify$/.test(name)) return {
        addLoftyNote: async () => ({ attempted: true, ok: true }),
        refireLoftyTag: async () => ({ attempted: false }),
        sendLeadAlertEmail: async (details) => { f.notification = details; return { attempted: true, ok: true }; },
      };
      if (/\/_flodesk$/.test(name)) return { newsletterFromEvent: async () => ({ attempted: false }) };
      if (/\/_lead-address$/.test(name)) return { homeValueProperty: () => null };
      if (name.startsWith('.')) return load(path.relative(path.join(root, 'netlify/functions'), path.resolve(path.dirname(filename), name + '.js')));
      return require(name);
    }
    const context = { module, exports: module.exports, require: requireLocal, fetch: f.fetch,
      process: { env: { LOFTY_API_KEY: 'offline-key' } }, console: quiet,
      AbortSignal, URLSearchParams, Date, Intl, Buffer, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return module.exports;
  }
  return { handler: load('submission-created.js').handler, queue: load('lib/_lofty.js') };
}

function memoryStore(initial = {}) {
  const data = structuredClone(initial);
  return { data, get: async (key) => data[key] || null,
    setJSON: async (key, value) => { data[key] = value; return { modified: true }; },
    delete: async (key) => { delete data[key]; } };
}

test('actual submission handler checks a returning new number even with no yes', async () => {
  const f = fake({ leadId: 777, phones: [oldPhone], tags: oldTags, cannotText: false });
  const store = memoryStore();
  const flow = loadFlow(f, store);
  const result = await flow.handler({ body: JSON.stringify({ payload: { form_name: 'contact',
    data: { name: 'Pat', email: 'pat@example.com', phone } } }) });
  assert.equal(result.statusCode, 200);
  assert.equal(f.lead.cannotText, true);
  assert.deepEqual(f.calls.filter((c) => c.method === 'PUT').map((c) => c.body), [{ cannotText: true }]);
  assert.equal(store.data['lofty-last-push.json'].consentResult.textingDisabled, true);
});

test('actual queue replay checks a returning new number without a recorded yes', async () => {
  const f = fake({ leadId: 777, phones: [oldPhone], tags: oldTags, cannotText: false });
  const store = memoryStore({ 'lofty-failed-pushes.json': [
    { at: '2026-10-01T12:00:00Z', formName: 'contact', lead: { emails: ['pat@example.com'], phones: [phone] } },
  ] });
  const flow = loadFlow(f, store);
  const result = await flow.queue.drainFailedPushes(store, 'offline-key');
  assert.equal(result.recovered, 1);
  assert.equal(f.lead.cannotText, true);
  assert.deepEqual(f.calls.filter((c) => c.method === 'PUT').map((c) => c.body), [{ cannotText: true }]);
  assert.deepEqual(f.lead.tags, oldTags);
});

for (const hits of [
  { emailHits: [{ leadId: 777, emails: ['pat@example.com'] }, { leadId: 888, emails: ['pat@example.com'] }] },
  { phoneHits: [{ leadId: 777, phones: [phone] }, { leadId: 888, phones: [phone] }] },
  { phoneHits: [{ leadId: 888, phones: [phone] }] },
]) {
  test(`ambiguous or conflicting identity holds handler writes (${JSON.stringify(hits)})`, async () => {
    const f = fake({ leadId: 777, phones: [oldPhone], tags: oldTags, cannotText: false }, hits);
    const store = memoryStore();
    const flow = loadFlow(f, store);
    const result = await flow.handler({ body: JSON.stringify({ payload: { form_name: 'contact',
      data: { name: 'Pat', email: 'pat@example.com', phone, sms_consent: 'yes' } } }) });
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /manual review/);
    assert.deepEqual(f.calls.filter((c) => c.method !== 'GET'), []);
    assert.equal(store.data['lofty-last-push.json'].manualReview, true);
    assert.equal(store.data['lofty-failed-pushes.json'], undefined);
    assert.match(f.notification.noteText, /MANUAL REVIEW/);
    assert.equal(f.notification.leadId, null);
  });
}

test('queue ambiguity holds the entry and will not replay it again automatically', async () => {
  const f = fake({ leadId: 777, phones: [oldPhone], tags: oldTags, cannotText: false }, {
    emailHits: [{ leadId: 777, emails: ['pat@example.com'] }, { leadId: 888, emails: ['pat@example.com'] }],
  });
  const store = memoryStore({ 'lofty-failed-pushes.json': [
    { at: '2026-10-01T12:00:00Z', formName: 'contact', smsConsent: true,
      lead: { emails: ['pat@example.com'], phones: [phone] } },
  ] });
  const flow = loadFlow(f, store);
  const first = await flow.queue.drainFailedPushes(store, 'offline-key');
  assert.equal(first.recovered, 0);
  assert.deepEqual(f.calls.filter((c) => c.method !== 'GET'), []);
  assert.equal(store.data['lofty-failed-pushes.json'][0].manualReview, true);
  const count = f.calls.length;
  const second = await flow.queue.drainFailedPushes(store, 'offline-key');
  assert.equal(second.attempted, 0);
  assert.equal(f.calls.length, count);
});
