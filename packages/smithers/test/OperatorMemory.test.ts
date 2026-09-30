import * as MemoryStore from "@smthrs/memory/MemoryStore"
import type * as Namespace from "@smthrs/memory/Namespace"
import { Effect } from "effect"
import { Cli } from "incur"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryCli, withMemory } from "../src/operator/Memory.ts"
import { localRoot } from "../src/operator/Store.ts"

const ports = vi.hoisted(() => ({ layer: undefined as typeof MemoryStore.layer | undefined }))
vi.mock("@smthrs/memory/MemoryStore", async (load) => {
  const actual = await load<typeof import("@smthrs/memory/MemoryStore")>()
  return {
    ...actual,
    get layer() {
      return ports.layer ?? actual.layer
    }
  }
})
const asNamespace = (input: MemoryStore.NamespaceInput): Namespace.Namespace => {
  if (typeof input === "string") throw new Error(`the CLI passed an undecoded namespace: ${input}`)
  return input
}

const roots: Array<string> = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-operator-memory-"))
  roots.push(root)
  return root
}
const invoke = async (root: string, args: Array<string>) => {
  let output = ""
  let code = 0
  await Cli.create("smthrs").command(createMemoryCli()).serve(["memory", ...args, "--root", root, "--json"], {
    stdout: (value) => {
      output += value
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, data: JSON.parse(output) as any, output }
}

beforeEach(() => {
  vi.stubEnv("SMITHERS_REMOTE", undefined)
})
afterEach(() => {
  ports.layer = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("operator memory", () => {
  it.each(["list", "get", "set", "rm"])("refuses invalid identities before memory %s opens its store", async (verb) => {
    for (const namespace of ["team:alpha", "user:", "alpha", "user:alpha\0tail"]) {
      const root = fixture()
      const result = await invoke(root, [
        verb,
        ...(verb === "list" ? [] : ["key"]),
        ...(verb === "set" ? ["value"] : []),
        "--namespace",
        namespace
      ])
      expect(result.code).toBe(1)
      expect(result.data.code).toBe("operator_failed")
      expect(result.data.message).toBe(
        namespace.includes("\0")
          ? "Memory namespace IDs cannot contain control characters"
          : "Use --namespace user:<id>, flow:<id>, agent:<id>, or global:<id>"
      )
      expect(existsSync(join(root, ".flows", "control.db"))).toBe(false)
    }
  })

  it("preserves one Unicode namespace identity across all four verbs", async () => {
    const seen: Array<Namespace.Namespace> = []
    const namespace = { kind: "user" as const, id: "álîçé-用户-😀" }
    ports.layer = MemoryStore.layerNoop({
      listFacts: (input) => Effect.sync(() => (seen.push(asNamespace(input.namespace)), [])),
      getFact: (input) =>
        Effect.sync(() => {
          seen.push(asNamespace(input.namespace))
          return {
            namespace: asNamespace(input.namespace),
            key: input.key,
            value: "found",
            provenance: {},
            createdAtMs: 0,
            updatedAtMs: 0
          }
        }),
      putFact: (input) => Effect.sync(() => void seen.push(asNamespace(input.namespace))),
      deleteFact: (input) => Effect.sync(() => (seen.push(asNamespace(input.namespace)), true))
    })
    const root = fixture()
    for (const name of ["list", "get", "set", "rm"] as const) {
      const result = await invoke(root, [
        name,
        ...(name === "list" ? [] : ["key"]),
        ...(name === "set" ? ["value"] : []),
        "--namespace",
        `user:${namespace.id}`
      ])
      expect(result.code, result.output).toBe(0)
    }
    expect(seen).toEqual([namespace, namespace, namespace, namespace])
  })

  it("never lets an unknown kind address a valid user's record", async () => {
    const facts = new Map<string, MemoryStore.Fact>()
    let reads = 0
    const keyOf = (input: MemoryStore.GetFactInput) => {
      const namespace = asNamespace(input.namespace)
      return `${namespace.kind}:${namespace.id}:${input.key}`
    }
    ports.layer = MemoryStore.layerNoop({
      putFact: (input) =>
        Effect.sync(() => {
          facts.set(keyOf(input), {
            namespace: asNamespace(input.namespace),
            key: input.key,
            value: input.value,
            provenance: input.provenance,
            createdAtMs: 0,
            updatedAtMs: 0
          })
        }),
      getFact: (input) =>
        Effect.sync(() => {
          reads += 1
          return facts.get(keyOf(input))
        })
    })
    const root = fixture()
    expect((await invoke(root, ["set", "key", "value", "--namespace", "user:alpha"])).code).toBe(0)
    const valid = await invoke(root, ["get", "key", "--namespace", "user:alpha"])
    const refused = await invoke(root, ["get", "key", "--namespace", "team:alpha"])
    expect(valid.data.value).toBe("value")
    expect(refused.code).toBe(1)
    expect(refused.data.code).toBe("operator_failed")
    expect(refused.data.value).toBeUndefined()
    expect(reads).toBe(1)
  })

  it("keeps facts durable, uses the legacy user:cli namespace, and auto-decodes JSON", async () => {
    const root = fixture()
    expect((await invoke(root, ["set", "settings", "{\"fast\":true}"])).code).toBe(0)
    const read = await invoke(root, ["get", "settings"])
    expect(read.data).toMatchObject({ value: { fast: true }, namespace: { kind: "user", id: "cli" } })
    expect((await invoke(root, ["set", "plain", "hello there"])).code).toBe(0)
    expect((await invoke(root, ["get", "plain"])).data.value).toBe("hello there")
    expect((await invoke(root, ["set", "flag", "false"])).code).toBe(0)
    expect((await invoke(root, ["get", "flag"])).data.value).toBe(false)
    expect((await invoke(root, ["set", "special", "17", "--namespace", "flow:review"])).code).toBe(0)
    expect((await invoke(root, ["get", "special", "--namespace", "flow", "--id", "review"])).data.value).toBe(17)
    expect((await invoke(root, ["get", "special"])).code).toBe(1)
    const direct = await withMemory(
      { root },
      Effect.gen(function*() {
        return yield* (yield* MemoryStore.MemoryStore).getFact({
          namespace: { kind: "user", id: "cli" },
          key: "settings"
        })
      })
    )
    expect(direct?.value).toEqual({ fast: true })
    expect((await invoke(root, ["rm", "plain"])).data.deleted).toBe(true)
    expect((await invoke(root, ["list", "--prefix", "set"])).data).toHaveLength(1)
  })

  it("reads and writes the SMITHERS_MEMORY_DB store the executor honors", async () => {
    const root = fixture()
    const shared = join(root, "shared", "memory.db")
    vi.stubEnv("SMITHERS_MEMORY_DB", shared)
    expect((await invoke(root, ["notes", "add", "override learning", "--note-id", "learned", "--status", "pending"])).code)
      .toBe(0)
    expect(existsSync(shared)).toBe(true)
    expect(existsSync(join(root, ".flows", "control.db"))).toBe(false)
    expect((await invoke(root, ["notes", "list"])).data).toHaveLength(1)
    expect((await invoke(root, ["notes", "status", "learned", "accepted"])).code).toBe(0)
    expect((await invoke(root, ["notes", "get", "learned"])).data.status).toBe("accepted")
    vi.stubEnv("SMITHERS_MEMORY_DB", undefined)
    expect((await invoke(root, ["notes", "list"])).data).toEqual([])
  })

  it("recalls accepted notes with keyword and FTS while honoring supersession", async () => {
    const root = fixture()
    expect((await invoke(root, ["notes", "add", "amber deployment guide", "--note-id", "guide"])).code).toBe(0)
    expect((await invoke(root, ["notes", "add", "amber draft", "--note-id", "draft", "--status", "pending"])).code)
      .toBe(0)
    const keyword = await invoke(root, ["recall", "amber"])
    expect(keyword.data.map((row: { key: string }) => row.key)).toEqual(["guide"])
    expect((await invoke(root, ["recall", "amber", "--method", "fts"])).data.map((row: { key: string }) => row.key))
      .toEqual(["guide"])
    expect(
      (await invoke(root, ["notes", "add", "amber new guide", "--note-id", "guide-v2", "--supersedes", "guide"])).code
    ).toBe(0)
    expect((await invoke(root, ["recall", "amber"])).data.map((row: { key: string }) => row.key)).toEqual(["guide-v2"])
    expect((await invoke(root, ["notes", "status", "draft", "accepted"])).code).toBe(0)
    expect((await invoke(root, ["notes", "get", "draft"])).data.status).toBe("accepted")
    expect((await invoke(root, ["notes", "list", "--include-superseded"])).data).toHaveLength(3)
    expect((await invoke(root, ["notes", "add", "bad tags", "--tag", "invalid"])).code).toBe(1)
  })

  it("persists standalone supersession without mutating notes or bypassing the replacement's status gate", async () => {
    const root = fixture()
    expect((await invoke(root, ["notes", "add", "amber original guide", "--note-id", "original"])).code).toBe(0)
    const original = await invoke(root, ["notes", "get", "original"])
    expect(original.code, original.output).toBe(0)

    const refused = await invoke(root, ["notes", "supersede", "original", "missing"])
    expect(refused.code, refused.output).toBe(1)
    expect(refused.data.code).toBe("operator_failed")
    expect((await invoke(root, ["notes", "get", "original"])).data).toEqual(original.data)
    expect((await invoke(root, ["recall", "amber"])).data.map((row: { key: string }) => row.key)).toEqual(["original"])

    expect(
      (await invoke(root, [
        "notes",
        "add",
        "amber replacement guide",
        "--note-id",
        "replacement",
        "--status",
        "pending"
      ])).code
    ).toBe(0)
    // Each invocation opens and closes the real SQLite store. Repeating the
    // command must retain one durable edge, while a pending replacement must
    // leave the accepted original visible to a later recall.
    for (let attempt = 0; attempt < 2; attempt++) {
      const replaced = await invoke(root, ["notes", "supersede", "original", "replacement"])
      expect(replaced.code, replaced.output).toBe(0)
      expect(replaced.data).toEqual({ superseded: "original", replacement: "replacement" })
    }
    expect((await invoke(root, ["recall", "amber"])).data.map((row: { key: string }) => row.key)).toEqual(["original"])
    expect((await invoke(root, ["notes", "status", "replacement", "accepted"])).code).toBe(0)
    for (const method of ["keyword", "fts"]) {
      expect((await invoke(root, ["recall", "amber", "--method", method])).data.map((row: { key: string }) => row.key))
        .toEqual(["replacement"])
    }
    expect((await invoke(root, ["notes", "get", "original"])).data).toEqual(original.data)
    expect((await invoke(root, ["notes", "list", "--include-superseded"])).data).toHaveLength(2)
    expect((await invoke(root, ["notes", "status", "replacement", "rejected"])).code).toBe(0)
    expect((await invoke(root, ["recall", "amber"])).data.map((row: { key: string }) => row.key)).toEqual(["original"])
  })

  it("compacts persisted history atomically while preserving retained messages", async () => {
    const root = fixture()
    expect((await invoke(root, ["threads", "create", "--thread-id", "history", "--title", "Review"])).code).toBe(0)
    for (let index = 1; index <= 5; index++) {
      expect(
        (await invoke(root, [
          "messages",
          "add",
          "history",
          `message ${index}`,
          "--message-id",
          `m${index}`,
          "--at",
          String(index * 100)
        ])).code
      ).toBe(0)
    }
    const dry = await invoke(root, [
      "compact",
      "history",
      "--summary",
      "The first three messages",
      "--before",
      "1000",
      "--keep",
      "2",
      "--dry-run"
    ])
    expect(dry.data).toMatchObject({ eligible: 3, removed: 0, dryRun: true })
    expect((await invoke(root, ["messages", "list", "history"])).data).toHaveLength(5)
    const result = await invoke(root, [
      "compact",
      "history",
      "--summary",
      "The first three messages",
      "--before",
      "1000",
      "--keep",
      "2"
    ])
    expect(result.data.removed).toBe(3)
    const messages = (await invoke(root, ["threads", "show", "history"])).data.messages
    expect(messages.map((message: { text: string }) => message.text)).toEqual([
      "The first three messages",
      "message 4",
      "message 5"
    ])
    const page = await invoke(root, ["messages", "list", "history", "--after-id", "m4", "--after-at", "400"])
    expect(page.data.map((message: { id: string }) => message.id)).toEqual(["m5"])
    expect((await invoke(root, ["messages", "list", "history", "--after-id", "m4"])).code).toBe(1)
    expect((await invoke(root, ["compact", "absent", "--summary", "x", "--before", "1"])).code).toBe(1)
    expect((await invoke(root, ["threads", "rm", "history"])).data.deleted).toBe(true)
    expect((await invoke(root, ["threads", "list"])).data).toEqual([])
  })

  it("refuses remote access without opening a local database and discovers ancestor roots", async () => {
    const root = fixture()
    expect((await invoke(root, ["list", "--remote", "http://localhost:3000"])).code).toBe(1)
    expect(existsSync(join(root, ".flows"))).toBe(false)
    mkdirSync(join(root, ".flows"))
    const nested = join(root, "src", "nested")
    mkdirSync(nested, { recursive: true })
    vi.spyOn(process, "cwd").mockReturnValue(nested)
    expect(localRoot({})).toBe(root)
    vi.stubEnv("SMITHERS_REMOTE", "")
    expect(localRoot({})).toBe(root)
  })
})
