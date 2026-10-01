#!/usr/bin/env node
/** Read-only Cloudflare audit. Private output contains keys/owners; stdout contains counts only.
 * CLOUDFLARE_API_TOKEN=... node audit-retired-data.mjs --account ID --bucket NAME --database ID --out PRIVATE_DIR
 * Never infer an orphan from a missing D1 row: legacy uploads may have external PR references.
 * API: https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function paginate(request, path, itemsFrom = page => page.result) {
  const records = [], cursors = new Set();
  let next = path;
  for (;;) {
    const page = await request(next);
    if (page.success !== true) throw new Error('Cloudflare listing failed');
    const items = itemsFrom(page);
    if (!Array.isArray(items)) throw new Error('Invalid Cloudflare listing');
    records.push(...items);
    const info = page.result_info ?? {};
    const cursor = info.cursor;
    if (info.is_truncated === true && !cursor) throw new Error('Truncated listing without cursor');
    if (!cursor || info.is_truncated === false) return records;
    if (cursors.has(cursor)) throw new Error('Repeated pagination cursor');
    cursors.add(cursor);
    const url = new URL(path, 'https://audit.invalid');
    url.searchParams.set('cursor', cursor);
    next = url.pathname + url.search;
  }
}

export function classifyWalkthroughs(objects, rows, now = Date.now()) {
  const references = new Map((rows ?? []).map(row => [`walkthroughs/${row.id}.html`, row]));
  return objects.map(object => {
    const row = references.get(object.key);
    const modified = Date.parse(object.last_modified);
    return {
      key: object.key, size: object.size, etag: object.etag,
      lastModified: object.last_modified,
      ageDays: Number.isFinite(modified) && modified <= now ? (now - modified) / 86400000 : null,
      owner: row?.repo || object.custom_metadata?.owner || object.custom_metadata?.repo || null,
      referenceState: row ? 'referenced' : 'unverified',
      metadata: object,
    };
  });
}

export function summarize(inventory) {
  return {
    namespaces: inventory.namespaces.length,
    onboardingRecords: inventory.onboarding.length,
    walkthroughObjects: inventory.walkthroughs.length,
    referencedWalkthroughs: inventory.walkthroughs.filter(x => x.referenceState === 'referenced').length,
    unverifiedWalkthroughs: inventory.walkthroughs.filter(x => x.referenceState === 'unverified').length,
    provenOrphans: 0,
  };
}

export async function inventoryRetiredData(request, { bucket, database, now = Date.now() }) {
  const namespaces = await paginate(request, '/storage/kv/namespaces?per_page=100');
  const onboarding = [];
  for (const ns of namespaces) {
    const keys = await paginate(request, `/storage/kv/namespaces/${encodeURIComponent(ns.id)}/keys?prefix=onboarding%3A&limit=1000`);
    for (const key of keys) {
      // KV has no creation timestamp. Do not mistake expiration for age.
      onboarding.push({ namespace: ns.id, namespaceTitle: ns.title, key: key.name,
        owner: key.metadata?.owner ?? null, ageDays: null, metadata: key.metadata ?? null,
        expiration: key.expiration ?? null, referenceState: 'unverified' });
    }
  }
  const objects = await paginate(request, `/r2/buckets/${encodeURIComponent(bucket)}/objects?prefix=walkthroughs%2F&per_page=1000`);
  const schema = await request(`/d1/database/${encodeURIComponent(database)}/query`, {
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='walkthroughs'",
  });
  if (schema.success !== true || !Array.isArray(schema.result?.[0]?.results)) throw new Error('D1 schema inventory failed');
  let rows = null;
  if (schema.result[0].results.length) {
    rows = [];
    let after = '';
    for (;;) {
      const page = await request(`/d1/database/${encodeURIComponent(database)}/query`, {
        sql: 'SELECT id, repo, created_at, status FROM walkthroughs WHERE id > ? ORDER BY id LIMIT 1000', params: [after],
      });
      if (page.success !== true || !Array.isArray(page.result?.[0]?.results)) throw new Error('D1 reference inventory failed');
      const batch = page.result[0].results;
      rows.push(...batch);
      if (batch.length < 1000) break;
      const last = batch.at(-1).id;
      if (last <= after) throw new Error('D1 pagination did not advance');
      after = last;
    }
  }
  return { auditedAt: new Date(now).toISOString(), namespaces, onboarding,
    referenceAuthority: rows === null ? 'walkthroughs-table-absent' : 'D1-plus-external-references-required',
    walkthroughs: classifyWalkthroughs(objects, rows, now) };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--account', '--bucket', '--database', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Expected --account ID --bucket NAME --database ID --out PRIVATE_DIR');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.account || !options.bucket || !options.database || !options.out || !process.env.CLOUDFLARE_API_TOKEN) throw new Error('Missing audit options or Cloudflare credential');
  const request = async (path, body) => {
    // POST is only D1 SELECT, never an arbitrary mutation.
    if (body && (!/^SELECT\b/i.test(body.sql) || !/^\/d1\/database\/[^/]+\/query$/.test(path))) throw new Error('Read-only audit refused request');
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.account)}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Cloudflare read failed (HTTP ${response.status})`);
    return response.json();
  };
  const inventory = await inventoryRetiredData(request, options);
  const counts = summarize(inventory);
  await mkdir(options.out, { recursive: true, mode: 0o700 });
  // Exclusive files prevent overwriting receipts or following existing symlinks.
  await writeFile(resolve(options.out, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(options.out, 'counts.json'), JSON.stringify(counts, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(counts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Audit failed; no remote data was changed.'); process.exitCode = 1; });
}
