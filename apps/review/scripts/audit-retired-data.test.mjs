import assert from 'node:assert/strict';
import test from 'node:test';
import { paginate, classifyWalkthroughs, summarize, inventoryRetiredData } from './audit-retired-data.mjs';

const now = Date.parse('2026-10-01T00:00:00Z');
const object = (id, uploaded = '2026-09-29T00:00:00Z') => ({ key: `walkthroughs/${id}.html`, last_modified: uploaded });

// Synthetic API responses keep pagination faults reproducible without contacting a live account.
test('pagination propagates request errors without returning a partial inventory', async () => {
  const failure = new Error('inventory unavailable');
  await assert.rejects(paginate(async () => { throw failure; }, '/objects', result => result.objects), error => error === failure);
});

test('complete and pending walkthrough rows both protect objects and retain ownership', () => {
  const records = classifyWalkthroughs([object('complete'), object('pending')], [
    { id: 'complete', repo: 'org/one', status: 'complete' },
    { id: 'pending', repo: 'org/two', status: 'pending' },
  ], now);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => ({ key: record.key, owner: record.owner, ageDays: record.ageDays, referenceState: record.referenceState })), [
    { key: 'walkthroughs/complete.html', owner: 'org/one', ageDays: 2, referenceState: 'referenced' },
    { key: 'walkthroughs/pending.html', owner: 'org/two', ageDays: 2, referenceState: 'referenced' },
  ]);
});

for (const rows of [null, []]) {
  test(`objects remain unverified when ${rows === null ? 'the table is unavailable' : 'no matching rows exist'}`, () => {
    const [record] = classifyWalkthroughs([object('unmatched')], rows, now);
    assert.equal(record.key, 'walkthroughs/unmatched.html');
    assert.equal(record.referenceState, 'unverified');
    assert.equal(record.owner, null);
  });
}

test('an unrelated row never supplies object ownership or proves an orphan', () => {
  const [record] = classifyWalkthroughs([object('missing')], [{ id: 'other', repo: 'org/other', status: 'complete' }], now);
  assert.equal(record.referenceState, 'unverified');
  assert.equal(record.owner, null);
});

test('a referenced object without repository attribution has unknown ownership', () => {
  const [record] = classifyWalkthroughs([object('service')], [{ id: 'service', repo: '', status: 'complete' }], now);
  assert.equal(record.referenceState, 'referenced');
  assert.equal(record.owner, null);
});

test('invalid upload dates remain unknown instead of producing misleading ages', () => {
  const records = classifyWalkthroughs([object('bad', 'not-a-date'), { key: 'walkthroughs/missing.html' }], null, now);
  assert.deepEqual(records.map(record => record.ageDays), [null, null]);
});

const page = (result, result_info = {}) => ({ success: true, result, result_info });
test('pagination preserves query filters, encodes cursors, and collects every page in order', async () => {
  const paths = [];
  const records = await paginate(async path => {
    paths.push(path);
    return paths.length === 1 ? page({ objects: ['a'] }, { cursor: 'x &/+', is_truncated: true }) : page({ objects: ['b'] }, { is_truncated: false });
  }, '/objects?prefix=walkthroughs%2F', result => result.result.objects);
  assert.deepEqual(records, ['a', 'b']);
  assert.equal(new URL(paths[1], 'https://example.test').searchParams.get('prefix'), 'walkthroughs/');
  assert.equal(new URL(paths[1], 'https://example.test').searchParams.get('cursor'), 'x &/+');
});

for (const [label, response, message] of [
  ['API failure', { success: false }, /listing failed/],
  ['malformed items', page({}), /Invalid Cloudflare listing/],
  ['missing continuation', page([], { is_truncated: true }), /without cursor/],
]) {
  test(`pagination rejects ${label}`, async () => {
    await assert.rejects(paginate(async () => response, '/objects'), message);
  });
}

test('pagination rejects repeated cursors before requesting another repeated page', async () => {
  let calls = 0;
  await assert.rejects(paginate(async () => { calls++; return page([], { cursor: 'same', is_truncated: true }); }, '/objects'), /Repeated pagination cursor/);
  assert.equal(calls, 2);
});

test('future dates do not report negative ages; custom metadata attributes unverified objects', () => {
  const [record] = classifyWalkthroughs([{ ...object('future', '2026-10-02T00:00:00Z'), custom_metadata: { owner: 'legacy-owner' } }], [], now);
  assert.equal(record.ageDays, null);
  assert.equal(record.owner, 'legacy-owner');
  assert.equal(record.referenceState, 'unverified');
});

test('summary reports only counts and never claims unverified objects are proven orphans', () => {
  assert.deepEqual(summarize({ namespaces: [{ id: 'private' }], onboarding: [{ key: 'secret' }], walkthroughs: [
    { key: 'secret', referenceState: 'referenced' }, { referenceState: 'unverified' }, { referenceState: 'unverified' },
  ] }), { namespaces: 1, onboardingRecords: 1, walkthroughObjects: 3, referencedWalkthroughs: 1, unverifiedWalkthroughs: 2, provenOrphans: 0 });
});

const options = { bucket: 'old/bucket', database: 'old/database', now };
function inventoryRequest(schema, referencePages = []) {
  const calls = [];
  return { calls, request: async (path, body) => {
    calls.push({ path, body });
    if (path.startsWith('/storage/kv/namespaces?')) return page([{ id: 'ns/id', title: 'old' }]);
    if (path.includes('/keys?')) {
      return path.includes('cursor=next') ? page([{ name: 'onboarding:second' }]) : page([{ name: 'onboarding:first', expiration: 123, metadata: { owner: 'owner' } }], { cursor: 'next' });
    }
    if (path.startsWith('/r2/')) return page([object('pending')]);
    if (body.sql.includes('sqlite_master')) return schema;
    return referencePages.shift();
  } };
}

test('missing D1 table keeps all objects unverified and KV expiration never supplies age', async () => {
  const { request, calls } = inventoryRequest(page([{ results: [] }]));
  const inventory = await inventoryRetiredData(request, options);
  assert.equal(inventory.referenceAuthority, 'walkthroughs-table-absent');
  assert.equal(inventory.walkthroughs[0].referenceState, 'unverified');
  assert.equal(inventory.onboarding.length, 2);
  assert.equal(inventory.onboarding[0].ageDays, null);
  assert.equal(inventory.onboarding[0].expiration, 123);
  assert.equal(inventory.onboarding[0].owner, 'owner');
  assert.equal(calls.filter(call => call.body).length, 1);
  assert.ok(calls.some(call => call.path.includes('ns%2Fid/keys')));
});

for (const schema of [{ success: false }, page([{ results: null }])]) {
  test('failed or malformed D1 schema aborts inventory', async () => {
    const { request } = inventoryRequest(schema);
    await assert.rejects(inventoryRetiredData(request, options), /D1 schema inventory failed/);
  });
}

test('D1 references include pending publications and only issue SELECT statements', async () => {
  const { request, calls } = inventoryRequest(page([{ results: [{ name: 'walkthroughs' }] }]), [page([{ results: [{ id: 'pending', repo: 'org/repo', status: 'pending' }] }])]);
  const inventory = await inventoryRetiredData(request, options);
  assert.equal(inventory.walkthroughs[0].referenceState, 'referenced');
  assert.equal(inventory.walkthroughs[0].owner, 'org/repo');
  assert.ok(calls.filter(call => call.body).every(call => /^SELECT\b/.test(call.body.sql)));
});

test('failed D1 reference reads abort instead of classifying partial references', async () => {
  const { request } = inventoryRequest(page([{ results: [{ name: 'walkthroughs' }] }]), [{ success: false }]);
  await assert.rejects(inventoryRetiredData(request, options), /D1 reference inventory failed/);
});

test('D1 keyset pagination advances after exactly 1000 rows', async () => {
  const batch = Array.from({ length: 1000 }, (_, i) => ({ id: `id${String(i).padStart(4, '0')}`, repo: 'org/repo' }));
  const { request, calls } = inventoryRequest(page([{ results: [{}] }]), [page([{ results: batch }]), page([{ results: [{ id: 'pending', repo: 'org/pending' }] }])]);
  const inventory = await inventoryRetiredData(request, options);
  assert.equal(inventory.walkthroughs[0].owner, 'org/pending');
  assert.deepEqual(calls.filter(call => call.body?.params).map(call => call.body.params), [[''], ['id0999']]);
});

test('D1 nonadvancing pagination fails rather than looping', async () => {
  const batch = Array.from({ length: 1000 }, () => ({ id: '' }));
  const { request } = inventoryRequest(page([{ results: [{}] }]), [page([{ results: batch }])]);
  await assert.rejects(inventoryRetiredData(request, options), /did not advance/);
});
