import { expect, test } from "bun:test"
import { NotificationReadReceiptSchema, notificationReceiptKey, notificationWasRead, notificationReadVersion, processRepositoryEvents, type RepositoryEvent, type RepositoryNotification } from "./RepositoryNotifications"
const event: RepositoryEvent = { source: "github", sourceId: "3", kind: "issue", number: 3, title: "Fix greetings", state: "open", updatedAt: "2026-09-10T00:00:00Z", tags: ["bug"] }
const process = (events: RepositoryEvent[], previous: Parameters<typeof processRepositoryEvents>[3] = []) => processRepositoryEvents("alice", "org/repo", events, previous, 1)
test("deduplicates delivery, tracks announcement separately from read, and announces changed versions", () => {
  const first = process([event, event])
  expect(first.rows).toHaveLength(1)
  expect(first.fresh).toHaveLength(1)
  const announced = { ...first.rows[0]!, announcedVersion: first.rows[0]!.version }
  expect(process([event], [announced]).fresh).toHaveLength(0)
  expect(announced.readVersion).toBeUndefined()
  const read = { ...announced, readVersion: announced.version }
  expect(process([event], [read]).fresh).toHaveLength(0)
  expect(process([{ ...event, updatedAt: "2026-09-11T00:00:00Z" }], [read]).fresh).toHaveLength(1)
})
test("closed baseline is quiet, a newly closed issue is an update, stale events cannot roll back receipts", () => {
  const baseline = process([{ ...event, state: "closed" }])
  expect(baseline.fresh).toHaveLength(0)
  expect(process([{ ...event, state: "closed" }], baseline.rows).fresh).toHaveLength(0)
  const prior = process([event]).rows
  expect(process([{ ...event, state: "closed", updatedAt: "2026-09-11T00:00:00Z" }], prior).fresh).toHaveLength(1)
  expect(process([{ ...event, updatedAt: "2026-09-09T00:00:00Z" }], prior).rows).toHaveLength(0)
})
test("account and repository scopes isolate receipts; source marks read and custom tags survive", () => {
  const first = process([event]).rows[0]!
  const prior = { ...first, announcedVersion: first.version, tags: ["follow-up"] }
  expect(processRepositoryEvents("bob", "org/repo", [event], [prior], 2).fresh).toHaveLength(1)
  expect(processRepositoryEvents("alice", "other/repo", [event], [prior], 2).fresh).toHaveLength(1)
  const read = process([{ ...event, read: true }], [prior])
  expect(read.fresh).toHaveLength(0)
  expect(read.rows[0]!.readVersion).toBe(read.rows[0]!.version)
  expect(read.rows[0]!.tags).toEqual(["follow-up", "bug"])
})


const ID = '["alice","org/repo","github","issue","3"]'
const VERSION = '["2026-09-10T00:00:00Z","open","Fix greetings"]'
test("the complete projected row has literal identity/version and never mutates input tags", () => {
  const events: RepositoryEvent[] = [{ ...event, tags: ["bug", "bug", "urgent"] }]
  const before = structuredClone(events)
  const expected = { source: "github", sourceId: "3", kind: "issue", number: 3, title: "Fix greetings", state: "open", updatedAt: "2026-09-10T00:00:00Z",
    tags: ["bug", "urgent"], id: ID, scope: "alice", repo: "org/repo", version: VERSION, processedAt: 1 } satisfies RepositoryNotification
  expect(process(events)).toEqual({ rows: [expected], fresh: [expected] })
  expect(events).toEqual(before)
  const prior = { ...expected, announcedVersion: VERSION, tags: ["custom", "bug"] }
  const saved = structuredClone(prior)
  const next = process([{ ...event, tags: ["bug", "urgent", "custom"] }], [prior])
  expect(next.rows[0]?.tags).toEqual(["custom", "bug", "urgent"])
  expect(next.fresh).toEqual([])
  expect(prior).toEqual(saved)
})

test("source and kind own independent notification identities even with the same source number", () => {
  const result = process([event, { ...event, source: "smithers" }, { ...event, kind: "pr" }, { ...event, kind: "notification" }])
  expect(result.rows.map(row => row.id)).toEqual([
    '["alice","org/repo","github","issue","3"]', '["alice","org/repo","smithers","issue","3"]',
    '["alice","org/repo","github","pr","3"]', '["alice","org/repo","github","notification","3"]'
  ])
  expect(result.fresh.map(row => row.id)).toEqual([
    '["alice","org/repo","github","issue","3"]', '["alice","org/repo","smithers","issue","3"]',
    '["alice","org/repo","github","pr","3"]', '["alice","org/repo","github","notification","3"]'
  ])
})

test.each([
  { kind: "issue", state: "open", fresh: true }, { kind: "issue", state: "closed", fresh: false },
  { kind: "pr", state: "open", fresh: true }, { kind: "pr", state: "closed", fresh: false },
  { kind: "notification", state: "open", fresh: true }, { kind: "notification", state: "closed", fresh: true }
] as const)("an initial $kind $state observation has the declared announcement policy", ({ kind, state, fresh }) => {
  const result = process([{ ...event, kind, state }])
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]?.state).toBe(state)
  expect(result.fresh).toEqual(fresh ? result.rows : [])
})

test("a changed title/state at the same timestamp is a new version, while later duplicates settle once", () => {
  const prior = { ...process([event]).rows[0]!, announcedVersion: VERSION, readVersion: VERSION }
  const changed = { ...event, title: "New title", state: "closed" }
  const result = process([changed, changed], [prior])
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]?.version).toBe('["2026-09-10T00:00:00Z","closed","New title"]')
  expect(result.rows[0]?.readVersion).toBe(VERSION)
  expect(result.fresh.map(row => [row.id, row.version])).toEqual([[ID, '["2026-09-10T00:00:00Z","closed","New title"]']])
})

test("receipts distinguish exact notification/version pairs and enforce their strict key", () => {
  expect(notificationReceiptKey("a:b", "c")).toBe('["a:b","c"]')
  expect(notificationReceiptKey("a", "b:c")).toBe('["a","b:c"]')
  const receipts = new Map<string, unknown>([['["notice","v1"]', {}]])
  expect(notificationWasRead(receipts, "notice", "v1")).toBe(true)
  expect(notificationWasRead(receipts, "notice", "v2")).toBe(false)
  expect(notificationWasRead(receipts, "other", "v1")).toBe(false)
  expect(notificationReadVersion({ id: "notice", version: "v1" }, receipts)).toBe("v1")
  expect(notificationReadVersion({ id: "notice", version: "v2" }, receipts)).toBeUndefined()
  const valid = { id: '["notice","v1"]', notificationId: "notice", version: "v1" }
  expect(NotificationReadReceiptSchema.parse(valid)).toEqual(valid)
  expect(NotificationReadReceiptSchema.safeParse({ ...valid, version: "v2" }).success).toBe(false)
  expect(NotificationReadReceiptSchema.safeParse({ ...valid, at: 1 }).success).toBe(false)
})


const observed: RepositoryNotification = {
  id: ID, scope: "alice", repo: "org/repo", source: "github", sourceId: "3", kind: "issue", number: 3,
  title: "Fix greetings", state: "open", updatedAt: "2026-09-10T00:00:00Z", version: VERSION, tags: ["bug"], processedAt: 0
}
test.each([
  { title: "Changed title", state: "open", version: '["2026-09-10T00:00:00Z","open","Changed title"]' },
  { title: "Fix greetings", state: "closed", version: '["2026-09-10T00:00:00Z","closed","Fix greetings"]' }
])("title $title and state $state independently change the observed version", ({ title, state, version }) => {
  const prior = { ...observed, announcedVersion: VERSION, readVersion: VERSION }
  const before = structuredClone(prior)
  const result = process([{ ...event, title, state }], [prior])
  expect(result.rows).toEqual([{ ...observed, title, state, version, processedAt: 1, announcedVersion: VERSION, readVersion: VERSION }])
  expect(result.fresh.map(row => [row.id, row.version])).toEqual([[ID, version]])
  expect(prior).toEqual(before)
})

const oldVersion = '["2026-09-09T00:00:00Z","open","Earlier title"]'
test.each([
  { announcement: "same", read: "same", fresh: false }, { announcement: "same", read: "old", fresh: false }, { announcement: "same", read: "missing", fresh: false },
  { announcement: "old", read: "same", fresh: false }, { announcement: "old", read: "old", fresh: true }, { announcement: "old", read: "missing", fresh: true },
  { announcement: "missing", read: "same", fresh: false }, { announcement: "missing", read: "old", fresh: true }, { announcement: "missing", read: "missing", fresh: true }
])("current announcement=$announcement and read=$read decide freshness independently", ({ announcement, read, fresh }) => {
  const prior: RepositoryNotification = { ...observed,
    ...(announcement === "missing" ? {} : { announcedVersion: announcement === "same" ? VERSION : oldVersion }),
    ...(read === "missing" ? {} : { readVersion: read === "same" ? VERSION : oldVersion })
  }
  const before = structuredClone(prior)
  const result = process([event], [prior])
  expect(result.rows).toEqual([{ ...prior, processedAt: 1 }])
  expect(result.fresh.map(row => row.id)).toEqual(fresh ? [ID] : [])
  expect(prior).toEqual(before)
})

test("an unchanged closed baseline stays quiet, but reopening and closing it are real updates", () => {
  const closed = { ...event, state: "closed" }
  const baseline = process([closed])
  expect(baseline.rows[0]?.version).toBe('["2026-09-10T00:00:00Z","closed","Fix greetings"]')
  expect(baseline.fresh).toEqual([])
  expect(process([closed], baseline.rows).fresh).toEqual([])
  const reopened = process([{ ...event, updatedAt: "2026-09-11T00:00:00Z" }], baseline.rows)
  expect(reopened.fresh.map(row => row.version)).toEqual(['["2026-09-11T00:00:00Z","open","Fix greetings"]'])
  const reclosed = process([{ ...closed, updatedAt: "2026-09-12T00:00:00Z" }], reopened.rows)
  expect(reclosed.fresh.map(row => row.version)).toEqual(['["2026-09-12T00:00:00Z","closed","Fix greetings"]'])
})

test("missing timestamps are distinct observed versions without inventing chronological evidence", () => {
  const undated = process([{ ...event, updatedAt: null }])
  expect(undated.rows[0]?.version).toBe('[null,"open","Fix greetings"]')
  const dated = process([event], undated.rows)
  expect(dated.fresh.map(row => row.version)).toEqual([VERSION])
  const changed = process([{ ...event, title: "Undated update", updatedAt: null }], dated.rows)
  expect(changed.rows[0]?.updatedAt).toBeNull()
  expect(changed.fresh.map(row => row.version)).toEqual(['[null,"open","Undated update"]'])
})

test("an out-of-order duplicate cannot overwrite the latest row or merge obsolete tags", () => {
  const events = [
    { ...event, title: "Latest", updatedAt: "2026-09-12T00:00:00Z", tags: ["new"] },
    { ...event, title: "Old", updatedAt: "2026-09-11T00:00:00Z", tags: ["obsolete"] },
    { ...event, title: "Latest", updatedAt: "2026-09-12T00:00:00Z", tags: ["new"] }
  ]
  const before = structuredClone(events)
  const result = process(events, [observed])
  const expected = { ...observed, title: "Latest", updatedAt: "2026-09-12T00:00:00Z", version: '["2026-09-12T00:00:00Z","open","Latest"]', tags: ["bug", "new"], processedAt: 1 }
  expect(result).toEqual({ rows: [expected], fresh: [expected] })
  expect(events).toEqual(before)
})

test("quotes and delimiters cannot collide in receipt or event identities", () => {
  expect(notificationReceiptKey('a"b', "v\nx")).toBe(String.raw`["a\"b","v\nx"]`)
  expect(notificationReceiptKey("a,b", "c")).toBe('["a,b","c"]')
  expect(notificationReceiptKey("a", "b,c")).toBe('["a","b,c"]')
  const result = processRepositoryEvents('a"b', "r/x:y", [{ ...event, sourceId: "x,y", title: 'Quoted "title"' }], [], 2)
  expect(result.rows[0]?.id).toBe(String.raw`["a\"b","r/x:y","github","issue","x,y"]`)
  expect(result.rows[0]?.version).toBe(String.raw`["2026-09-10T00:00:00Z","open","Quoted \"title\""]`)
})

test.each([
  { notificationId: "notice", version: "v1" }, { id: '["notice","v1"]', notificationId: "notice" },
  { id: '["notice","v1"]', notificationId: 1, version: "v1" }, { id: '["notice","v1"]', notificationId: "notice", version: null }
])("a receipt requires string identity/version fields: %j", value => {
  expect(NotificationReadReceiptSchema.safeParse(value).success).toBe(false)
})
