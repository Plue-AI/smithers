import { mkdir, writeFile } from 'node:fs/promises'

const kinds = ['main', 'pr', 'checks', 'issue']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A selector names a production API field, never a second read from GitHub.
export function select(value, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error('JSON pointer required')
  for (const part of pointer.slice(1).split('/')) {
    value = value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  return value
}

export function includes(value, expected) {
  if (value === expected) return true
  if (typeof value === 'string' && typeof expected === 'string') return value.includes(expected)
  if (Array.isArray(value)) return value.some(v => includes(v, expected))
  if (value && typeof value === 'object') return Object.values(value).some(v => includes(v, expected))
  return false
}

export function summarize(samples, count) {
  return Object.fromEntries(kinds.map(kind => {
    const rows = samples.filter(s => s.kind === kind)
    const times = rows.filter(s => s.t1 !== null).map(s => s.t1 - s.t0).sort((a, b) => a - b)
    const percentile = p => times.length ? times[Math.ceil(times.length * p) - 1] : null
    return [kind, { n: times.length, missing: rows.length - times.length,
      p50: percentile(.5), p95: percentile(.95), max: times.at(-1) ?? null,
      passed: rows.length === count && times.length === count && times.every(t => Number.isFinite(t) && t >= 0) && percentile(.95) <= (kind === 'issue' ? 300000 : 60000) }]
  }))
}

export function comparePhases(inactive, dropped) {
  return inactive.phase === 'inactive' && dropped.phase === 'dropped' && kinds.every(kind => {
    const first = inactive.metrics[kind]
    const second = dropped.metrics[kind]
    return first?.passed && second?.passed && first.n === 100 && second.n === 100 && second.p95 <= first.p95 + 5000
  })
}

export async function runFreshness(config, { fetch: request = fetch, now = Date.now, wait = sleep,
  githubToken, installToken, count = 100, cadence = 20000, grace = 600000, poll = 1000,
  onSample = async () => {} } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository) || config.pulls?.length !== 10 || config.issues?.length !== 100) {
    throw new Error('canary repository, ten pulls and 100 issues required')
  }
  if (!['inactive', 'dropped'].includes(config.phase)) throw new Error('webhook phase required')
  if (!/^[\w-]+$/.test(config.run ?? '') || new Set(config.issues).size !== 100 ||
    config.issues.some(n => !Number.isSafeInteger(n) || n <= 0) || new Set(config.pulls.map(p => p.number)).size !== 10) throw new Error('unique fixtures and run marker required')
  if (!githubToken || !installToken) throw new Error('member GitHub and install tokens required')
  const origin = new URL(config.origin)
  const github = new URL(config.githubOrigin ?? 'https://api.github.com')
  const samples = []
  const record = async sample => { samples.push(sample); await onSample(sample) }
  const read = async (base, path, token, method = 'GET', body) => {
    const url = new URL(path, base)
    if (url.origin !== base.origin) throw new Error('cross-origin request refused')
    const response = await request(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error(`${method} ${url.pathname}: HTTP ${response.status}`)
    const t = now() // Local return timestamp, before JSON decoding; never GitHub time.
    return { value: await response.json(), t }
  }
  const api = (path, method, body) => read(github, `/repos/${config.repository}/${path}`, githubToken, method, body)
  const endpoint = (kind, item) => {
    const observation = config.observe?.[kind]
    if (!observation?.path?.startsWith('/api/') || !observation.pointer?.startsWith('/')) throw new Error(`production ${kind} observation required`)
    return { path: observation.path.replaceAll('{todo}', String(item?.todo)).replaceAll('{issue}', String(item)), pointer: observation.pointer }
  }
  const observe = async sample => {
    const { path, pointer } = endpoint(sample.kind, sample.item)
    return select((await read(origin, path, installToken)).value, pointer)
  }
  // Refuse missing projections before writing to the canary.
  for (const kind of kinds) {
    const item = kind === 'issue' ? config.issues[0] : config.pulls[0]
    if (await observe({ kind, item }) === undefined) throw new Error(`production ${kind} projection unavailable`)
  }
  for (const pull of config.pulls) {
    if (!Number.isSafeInteger(pull.number) || !Number.isSafeInteger(pull.todo) || !/^[a-f0-9]{40}$/.test(pull.head)) throw new Error('invalid pull fixture')
    const { value } = await api(`pulls/${pull.number}`)
    if (value.state !== 'open' || value.head?.sha !== pull.head) throw new Error('open pull head fixture changed')
    const statuses = (await api(`commits/${pull.head}/statuses?per_page=100`)).value
    if (statuses.find(s => s.context === 'freshness/hold')?.state !== 'pending') throw new Error('pending freshness/hold required')
  }
  const start = now()
  let next = start
  let i = 0
  let deadline = Infinity
  const observePending = async () => {
    for (const sample of samples) {
      if (sample.t1 !== null) continue
      if (includes(await observe(sample), sample.expected)) {
        sample.t1 = now()
        await onSample(sample)
      }
    }
  }
  while (i < count || now() < deadline && samples.some(s => s.t1 === null)) {
    if (i < count && now() >= next) {
      const pull = config.pulls[i % 10]
      const issue = config.issues[i % 100]
      const marker = `freshness-${config.run}-${config.phase}-${i}`
      const parent = (await api('git/ref/heads/main')).value.object.sha
      const commit = (await api(`git/commits/${parent}`)).value
      const tree = (await api('git/trees', 'POST', { base_tree: commit.tree.sha,
        tree: [{ path: `freshness/${marker}.txt`, mode: '100644', type: 'blob', content: marker }] })).value
      const head = (await api('git/commits', 'POST', { message: marker, tree: tree.sha, parents: [parent] })).value.sha
      const main = await api('git/refs/heads/main', 'PATCH', { sha: head, force: false })
      await record({ kind: 'main', i, item: pull, expected: head, t0: main.t, t1: null })
      const review = await api(`pulls/${pull.number}/reviews`, 'POST', { event: 'APPROVE', body: marker, commit_id: pull.head })
      await record({ kind: 'pr', i, item: pull, expected: review.value.id, t0: review.t, t1: null })
      const check = await api(`statuses/${pull.head}`, 'POST', { state: 'success', context: marker })
      await record({ kind: 'checks', i, item: pull, expected: marker, t0: check.t, t1: null })
      const old = (await api(`issues/${issue}`)).value
      const changed = await api(`issues/${issue}`, 'PATCH', { body: `${old.body ?? ''}\n${marker}` })
      await record({ kind: 'issue', i, item: issue, expected: marker, t0: changed.t, t1: null })
      i++
      next = start + i * cadence
      if (i === count) deadline = now() + grace
    }
    await observePending()
    if (i === count && samples.every(s => s.t1 !== null)) break
    await wait(poll)
  }
  return { samples, metrics: summarize(samples, count), phase: config.phase,
    elapsed: now() - start, qualification: 'unqualified: reference-host, webhook, counters and install receipts required' }
}

export async function writeEvidence(directory, result) {
  await mkdir(directory, { recursive: false })
  await writeFile(`${directory}/summary.json`, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  const rows = result.samples.map(s => `${s.kind},${s.i},${s.t0},${s.t1 ?? ''},${s.t1 === null ? '' : s.t1 - s.t0}`)
  await writeFile(`${directory}/samples.csv`, `kind,i,t0,t1,delta\n${rows.join('\n')}\n`, { flag: 'wx' })
}
