import { NOTHING_ANSWERED } from "@smthrs/rpc/RefusalCopy"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CardSchema } from "@smthrs/rpc/Cards"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { fileOptions } from "./FilesSeam"
const PAGE_COMMIT = "a".repeat(40)

/*
 * The repo files seam (FilesSeam.ts) through the real command path: /files.list
 * reads GET /api/repos/{owner}/{repo}/contents[/path] and surfaces the
 * "file-list" card (entries sorted dirs-first, then by name); /files.read reads
 * the same route for a file path and surfaces the "file" card (base64 decoded,
 * capped at 16 KB, binary refused). Failures are honest strings, never throws;
 * a 404 is reported as the not-found it is, because the platform codes a
 * missing path and an unknown repository alike. The wire shapes mirror multi
 * src/files/filesClient.ts: a directory answers a JSON array of {name, path,
 * type} entries, a file answers one {path, content, encoding, size} record.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64")

/** A README with a multi-byte character: the decode must answer UTF-8, not mojibake. */
const README_TEXT = "# Flows — the runtime\n\nbun install\n"
/** Longer than the 16 KB card cap, so the card truncates honestly. */
const BIG_TEXT = "x".repeat(16 * 1024 + 100)

const WORD_LIST = "apple\nberry\n".repeat(25)
const SHA256SUMS = Array.from({ length: 8 }, (_, index) => `${String(index).repeat(64)}\n`).join("")

interface SeenRequest {
  readonly method: string
  readonly url: string
}

/*
 * The deployed platform's own 404 body for a path an IMPORTED repository does
 * not have (C088: /files.read docs/mvp-unlisted-probe.txt on b416, real
 * account, while GET /api/repos/{owner}/{name} answered 200). It carries the
 * same `not_found` code as a repository the platform has never seen, which is
 * why no message and no code can name the cause here.
 */
const CONTENT_NOT_FOUND = { status: "error", code: "not_found", message: "content not found" }

/*
 * The platform double: one imported repository (will/flows) answered in the
 * reference wire shape. Directory answers are DELIBERATELY unsorted and carry
 * one malformed row, so the card pins the seam's sorting and dropping. Every
 * other namespace 404s the way the platform 404s an un-imported repo.
 */
const filesBackend = () => {
  const requests: SeenRequest[] = []
  const routes: Record<string, () => Response> = {
    "/api/repos/will/flows/contents": () =>
      json(200, [
        { name: "zeta.txt", path: "zeta.txt", type: "file" },
        { name: "src", path: "src", type: "dir" },
        { name: "README.md", path: "README.md", type: "file" },
        { name: "docs", path: "docs", type: "dir" },
        { name: "broken", path: "broken", type: "symlink" },
        null
      ]),
    "/api/repos/will/flows/contents/src": () =>
      json(200, [
        { name: "lib", path: "src/lib", type: "dir" },
        // No name — the seam derives it from the path's last segment.
        { path: "src/app.ts", type: "file" }
      ]),
    "/api/repos/will/flows/contents/src/lib": () => json(200, []),
    "/api/repos/will/flows/contents/README.md": () =>
      json(200, {
        path: "README.md",
        content: base64(README_TEXT),
        encoding: "base64",
        size: README_TEXT.length
      }),
    "/api/repos/will/flows/contents/plain.txt": () =>
      json(200, { path: "plain.txt", content: "hello, plain wire\n", encoding: "", size: 18 }),
    "/api/repos/will/flows/contents/big.txt": () =>
      json(200, { path: "big.txt", content: base64(BIG_TEXT), encoding: "base64", size: BIG_TEXT.length }),
    "/api/repos/will/flows/contents/logo.png": () =>
      json(200, {
        path: "logo.png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]).toString("base64"),
        encoding: "base64",
        size: 7
      }),
    "/api/repos/will/flows/contents/raw.bin": () =>
      json(200, { path: "raw.bin", content: "PK\u0000\u0003", encoding: "", size: 4 }),
    /*
     * The shape the real platform answers for blob.bin: base64 bytes with
     * `encoding: "utf-8"` on them.
     */
    "/api/repos/will/flows/contents/mislabelled.bin": () =>
      json(200, {
        path: "mislabelled.bin",
        content: Buffer.from(
          Array.from({ length: 512 }, (_byte, index) => (index * 7 + 3) % 256)
        ).toString("base64"),
        encoding: "utf-8",
        size: 512
      }),
    "/api/repos/will/flows/contents/long.md": () =>
      json(200, {
        path: "long.md",
        content: `# Smithers\n\n${"Smithers keeps what it learns in world notes. ".repeat(40)}`,
        encoding: "utf-8",
        size: 2000
      }),
    ...Object.fromEntries(Object.entries({ "words.txt": WORD_LIST, SHA256SUMS }).map(([path, content]) => [
      `/api/repos/will/flows/contents/${path}`,
      () => json(200, { path, content, encoding: "utf-8", size: Buffer.byteLength(content) })
    ])),
    "/api/repos/will/flows/contents/missing.txt": () => json(404, { message: "Path not found: missing.txt" }),
    /* What the deployed platform answers for a path it does not have (C088, b416, real account). */
    "/api/repos/will/flows/contents/docs/mvp-unlisted-probe.txt": () => json(404, CONTENT_NOT_FOUND),
    "/api/repos/will/flows/contents/docs/ghost": () => json(404, CONTENT_NOT_FOUND),
    "/api/repos/will/flows/contents/boom.txt": () => json(500, { message: "the platform fell over" })
  }
  const services: AppServices = {
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes("/contents")) {
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
      // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this seam's request.
      if (url.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
      if (/\/api\/repos\/[^/]+\/[^/]+\/home$/.test(url.split("?")[0]!)) return json(404, { status: "error", message: "no homepage" })
      requests.push({ method: "GET", url })
      if (url === "/api/repos/will/flows/contents/oversized") {
        return json(200, Array.from({ length: 10_001 }, (_, index) => ({ name: `file-${index}`, type: "file" })))
      }
      if (url.startsWith("/api/repos/will/flows/contents/paged")) {
        return url.includes("after=paged%2Ffirst")
          ? new Response(JSON.stringify([{ name: "second", path: "paged/second", type: "file" }]), { headers: { "X-Contents-Commit": PAGE_COMMIT } })
          : new Response(JSON.stringify([{ name: "first", path: "paged/first", type: "file" }]), { status: 200, headers: { "X-Next-Cursor": "paged/first", "X-Contents-Commit": PAGE_COMMIT, "content-type": "application/json" } })
      }
      if (url.includes("net.txt")) throw new Error("socket hang up")
      /*
       * Addressed by path: a read AT a revision asks the same route with
       * `?ref=`, and this double holds one repository whose files do not
       * differ between revisions. Which revision was ASKED for is what the
       * recorded url above proves.
       */
      const route = routes[new URL(url, "https://app.test").pathname]
      if (route !== undefined) return route()
      // The platform 404s the whole namespace of a repo it never imported.
      return json(404, { code: "not_found", message: "repository not found" })
    }
  }
  return { services, requests }
}

const freshController = async (wrapFetch?: (base: NonNullable<AppServices["fetchImpl"]>) => NonNullable<AppServices["fetchImpl"]>) => {
  const backend = filesBackend()
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const services = wrapFetch === undefined ? backend.services : {
    ...backend.services,
    fetchImpl: wrapFetch(backend.services.fetchImpl!)
  }
  return {
    store,
    requests: backend.requests,
    controller: createAppController(store, unavailableAgent, services)
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const ready = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  // Lane piper: the inventory (not the retired watch-list) is the repo source.
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{
      id: "will/flows",
      org: "will",
      ownerKind: "user",
      name: "flows",
      head: { bookmark: "main", changeId: "change123", commitId: "commit123" }
    }]
  })
  await settled()
}

const listCard = (store: AppStore, id: string) => {
  const card = store.collections.cards.get(id)
  if (card === undefined || card.kind !== "file-list") return undefined
  return card
}

const fileCard = (store: AppStore, id: string) => {
  const card = store.collections.cards.get(id)
  if (card === undefined || card.kind !== "file") return undefined
  return card
}

describe("files seam — files.list", () => {
  test("follows directory cursors before showing a file-list card", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    expect((await controller.commands.run("files.list", "paged")).status).toBe("executed")
    expect(requests.map((request) => request.url)).toEqual([
      "/api/repos/will/flows/contents/paged",
      `/api/repos/will/flows/contents/paged?ref=${PAGE_COMMIT}&after=paged%2Ffirst`
    ])
    expect(listCard(store, "files-will/flows-paged")?.payload.entries).toEqual([
      { name: "first", kind: "file" },
      { name: "second", kind: "file" }
    ])
  })

  test("does not publish a partial card when the directory exceeds the cap", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "oversized")
    expect(outcome.status).toBe("failed")
    expect(JSON.stringify(outcome)).toContain("Directory listing exceeds 10,000 entries.")
    expect(listCard(store, "files-will/flows-oversized")).toBeUndefined()
  })
  test("rejects dot-segment and mixed-separator traversal before any request", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    for (const path of ["../../api/admin/health", "src/../secret", String.raw`..\api\admin`, "%2e%2e/admin"]) {
      const outcome = await controller.commands.run("files.list", path)
      expect(outcome.status).toBe("failed")
    }
    expect(requests).toEqual([])
  })
  test("the bare command lists the root: entries sorted dirs-first then by name, malformed rows dropped", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toEqual([{ method: "GET", url: "/api/repos/will/flows/contents" }])

    const card = listCard(store, "files-will/flows-/")
    expect(card).toBeDefined()
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.path).toBe("")
    expect(card?.payload.entries).toEqual([
      { name: "docs", kind: "dir" },
      { name: "src", kind: "dir" },
      { name: "README.md", kind: "file" },
      { name: "zeta.txt", kind: "file" }
    ])
    // The payload matches the shared wire schema exactly.
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("a \"/\" path is the root too: the same card id, one route", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "/")
    expect(outcome.status).toBe("executed")
    expect(requests[0]?.url).toBe("/api/repos/will/flows/contents")
    expect(listCard(store, "files-will/flows-/")).toBeDefined()
  })

  test("a path plus an explicit owner/repo targets that directory; names derive from paths when absent", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src will/flows")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests[0]?.url).toBe("/api/repos/will/flows/contents/src")
    const card = listCard(store, "files-will/flows-src")
    expect(card).toBeDefined()
    expect(card?.payload.path).toBe("src")
    expect(card?.payload.entries).toEqual([
      { name: "lib", kind: "dir" },
      { name: "app.ts", kind: "file" }
    ])
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("an empty directory surfaces an empty-entries card, not an error", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src/lib")
    expect(outcome.status).toBe("executed")
    expect(listCard(store, "files-will/flows-src/lib")?.payload.entries).toEqual([])
  })

  test("a directory the platform does not have is reported as not found, never as a missing import", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "docs/ghost")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Path not found: docs/ghost in will/flows")
    }
    expect(listCard(store, "files-will/flows-docs/ghost")).toBeUndefined()
  })

  /* Was "answers the /repos.import hint": the same code answers both causes, so it named the wrong one (C088). */
  test("an unknown repository's namespace 404 is reported as not found too", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src acme/ghost")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Path not found: src in acme/ghost")
    }
    expect(listCard(store, "files-acme/ghost-src")).toBeUndefined()
  })
})

describe("files seam — files.read", () => {
  test("opening from a maximized Files pane reveals the file in place and Restore keeps coherent history", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    expect((await controller.commands.run("files.list", "")).status).toBe("executed")
    const files = listCard(store, "files-will/flows-/")!
    controller.maximizeCard(files.id)
    expect(store.session().maximizedCardId).toBe(files.id)

    expect((await controller.commands.run("files.read", "README.md", undefined, files.id)).status).toBe("executed")
    expect(store.collections.cards.get(files.id)).toMatchObject({
      id: files.id,
      kind: "file",
      loading: false,
      payload: { path: "README.md", content: README_TEXT }
    })
    expect(store.session().maximizedCardId).toBe(files.id)
    expect(store.collections.cards.size).toBe(1)

    controller.moveCardHistory(files.id, -1)
    expect(store.collections.cards.get(files.id)).toMatchObject({ kind: "file-list", payload: { path: "" } })
    expect(store.session().maximizedCardId).toBe(files.id)
    controller.minimizeCard()
    expect(store.session().maximizedCardId).toBeNull()
  })

  test("a file command from Chat returns to the transcript without replacing the maximized Files card", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    await controller.commands.run("files.list", "")
    const files = listCard(store, "files-will/flows-/")!
    controller.maximizeCard(files.id)

    expect((await controller.commands.run("files.read", "README.md")).status).toBe("executed")
    expect(store.session().maximizedCardId).toBeNull()
    expect(store.collections.cards.get(files.id)).toMatchObject({ kind: "file-list", payload: { path: "" } })
    expect(fileCard(store, "file-will/flows-README.md")?.payload.content).toBe(README_TEXT)
  })

  test("a slow file cannot replace a newer maximized navigation", async () => {
    const release = deferred<void>()
    const { store, controller } = await freshController((base) => async (input, init) => {
      if (String(input).includes("/contents/README.md")) await release.promise
      return base(input, init)
    })
    await ready(store)
    expect((await controller.commands.run("files.list", "")).status).toBe("executed")
    const files = listCard(store, "files-will/flows-/")!
    controller.maximizeCard(files.id)

    const stale = controller.commands.run("files.read", "README.md", undefined, files.id)
    await settled()
    expect(store.collections.cards.get(files.id)).toMatchObject({ loading: true })
    expect((await controller.commands.run("files.read", "plain.txt", undefined, files.id)).status).toBe("executed")
    expect(store.collections.cards.get(files.id)).toMatchObject({ kind: "file", payload: { path: "plain.txt" } })
    release.resolve(undefined)
    await stale
    expect(store.collections.cards.get(files.id)).toMatchObject({ kind: "file", payload: { path: "plain.txt" } })
    expect(store.session().maximizedCardId).toBe(files.id)
  })

  test("a failed read replaces the maximized loading destination with a visible retryable error", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    expect((await controller.commands.run("files.list", "")).status).toBe("executed")
    const files = listCard(store, "files-will/flows-/")!
    controller.maximizeCard(files.id)

    const outcome = await controller.commands.run("files.read", "missing.txt", undefined, files.id)
    expect(outcome.status).toBe("failed")
    expect(store.collections.cards.get(files.id)).toMatchObject({
      status: "error",
      loading: false,
      body: "Path not found: missing.txt"
    })
    expect(store.session().maximizedCardId).toBe(files.id)
    controller.moveCardHistory(files.id, -1)
    expect(store.collections.cards.get(files.id)).toMatchObject({ kind: "file-list", payload: { path: "" } })
  })

  test("reads a base64 file into the file card, UTF-8 decoded, untruncated", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "README.md")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toEqual([{ method: "GET", url: "/api/repos/will/flows/contents/README.md" }])
    const card = fileCard(store, "file-will/flows-README.md")
    expect(card).toBeDefined()
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.path).toBe("README.md")
    // The em-dash proves base64 bytes went back through UTF-8, not latin1.
    expect(card?.payload.content).toBe(README_TEXT)
    expect(card?.payload.truncated).toBe(false)
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("a plain (non-base64) wire answer passes through as-is", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "plain.txt")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-plain.txt")?.payload.content).toBe("hello, plain wire\n")
  })

  test("a file beyond 16 KB is cut at the cap with truncated: true", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "big.txt")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-big.txt")
    expect(card?.payload.content.length).toBe(16 * 1024)
    expect(card?.payload.truncated).toBe(true)
  })

  /*
   * §8.27: the read SUCCEEDED — the file is simply not text. That is an
   * answer about the file, so it is a card, and the card states it instead of
   * printing 42 000 pixels of base64 the reader can neither use nor reach.
   */
  test("binary base64 content (NUL bytes) renders a card that says so, never the bytes", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "logo.png")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-logo.png")
    expect(card?.payload.binary).toBe(true)
    expect(card?.payload.content).toBe("")
  })

  test("binary plain content (a NUL byte in the string) is stated the same way", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "raw.bin")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-raw.bin")?.payload.binary).toBe(true)
  })

  /*
   * The platform answers `encoding: "utf-8"` for a file whose content is
   * plainly base64-encoded bytes, so the declared encoding is not trusted on
   * its own. The byte size distinguishes encoded bytes from plain text,
   * even when the text uses only characters from the base64 alphabet.
   */
  test("base64 bytes mislabelled as utf-8 are still recognised as binary", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "mislabelled.bin")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-mislabelled.bin")?.payload.binary).toBe(true)
  })

  test("a long plain-text file is not mistaken for base64", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "long.md")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-long.md")
    expect(card?.payload.binary ?? false).toBe(false)
    expect(card?.payload.content).toContain("Smithers")
  })

  test.each([
    ["words.txt", WORD_LIST],
    ["SHA256SUMS", SHA256SUMS]
  ])("utf-8 %s stays text even when it uses only the base64 alphabet", async (path, content) => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", path)
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, `file-will/flows-${path}`)
    expect(card?.payload.binary ?? false).toBe(false)
    expect(card?.payload.content).toBe(content)
  })

  test("a missing path inside an imported repo answers the platform's path message, not the import hint", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "missing.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Path not found: missing.txt")
  })

  test("a path the platform does not have is reported as not found, never as a missing import", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "docs/mvp-unlisted-probe.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Path not found: docs/mvp-unlisted-probe.txt in will/flows")
    }
  })

  /* Was "answers the /repos.import hint": the same code answers both causes, so it named the wrong one (C088). */
  test("an unknown repository's namespace 404 is reported as not found too", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "README.md acme/ghost")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Path not found: README.md in acme/ghost")
    }
  })

  /* The one cause local state does name, and the only one left: a pin this launch never opened. */

})

describe("files seam — honest failures", () => {
  test("a 500 answers what failed and whose fault it was, never a throw", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "boom.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Reading boom.txt in will/flows failed (500). That's a bug in Smithers, not something you did.")
      expect(outcome.error).not.toContain("the platform fell over")
    }
    expect(fileCard(store, "file-will/flows-boom.txt")).toBeUndefined()
  })

  /*
   * A throw naming the path and the repo, and now the verdict as well: nothing
   * answered, so nobody judged the request and the reader certainly did not
   * cause it. Never the capacity line — a socket that hung up tells us nothing
   * about our own fleet (`NOTHING_ANSWERED`, @smthrs/rpc/RefusalCopy).
   */
  test("a network throw answers an honest string naming the path and repo, and whose fault it was", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "net.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        `Could not reach the backend to read net.txt in will/flows. ${NOTHING_ANSWERED}`
      )
      /* The thrown text stays in the fetch tap, never in the answer. */
      expect(outcome.error).not.toContain("socket hang up")
    }
  })

  test("the file chooser's inventory answers a product sentence when a read throws, never the thrown text", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await ready(store)
    const answer = await fileOptions({
      store,
      baseUrl: "",
      http: async () => { throw new TypeError("ECONNRESET secret-socket-detail") }
    }, "will/flows")
    expect(answer).toEqual({ options: [], error: "Could not list files in will/flows." })
  })

  test("an inventory-less signed-in session answers the repo-resolution error before any request", async () => {
    const backend = filesBackend()
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableAgent,
      backend.services
    )
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    await settled()
    const outcome = await controller.commands.run("files.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"
      )
    }
    expect(backend.requests).toHaveLength(0)
  })
})


describe("files seam — the model's copy of a Cloud read", () => {
  test("a Cloud files.read answers the file's text as its value, so the model quotes the file and never invents one", async () => {
    const { controller } = await freshController()
    await ready(controller.store ?? (await createAppStore({ kind: "localStorage", storage: memoryStorage() })))
    const outcome = await controller.commands.run("files.read", "README.md")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(`README.md in will/flows:\n${README_TEXT}`)
  })
})

/*
 * The line anchor (docs/code-intel/PLAN.md §1): `files.read <path>:<line>[:<col>]`
 * reads the same file through the same route and records the anchor on the
 * card, which scrolls to and marks the line. The card id stays
 * `file-<repo>-<path>` (the dedupe every definition jump relies on), and a
 * re-read without an anchor clears it: the card states where it stands.
 */
describe("files seam — the line anchor", () => {


  test("a Cloud read anchors the same way, and the model's copy is the file", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "README.md:1")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(`README.md in will/flows:\n${README_TEXT}`)
    expect(requests.map((request) => request.url)).toEqual(["/api/repos/will/flows/contents/README.md"])
    expect(fileCard(store, "file-will/flows-README.md")?.payload).toMatchObject({ path: "README.md", line: 1 })
  })
})

/*
 * D-068: a read AT a revision. A path says where a file is; only a revision
 * says which bytes were there, and the graph drawer's Code tab is the reader
 * that needs both. The Cloud contents route takes the revision as `ref`; a
 * local checkout serves its own working copy and says so rather than handing
 * back bytes nobody recorded.
 */
const REVISION = "b".repeat(40)

describe("files seam — reading at a revision", () => {
  test("the citation command preserves the revision and line through admission into the embedded file", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const result = await controller.commands.run("files.read", `README.md:1 will/flows --ref ${REVISION}`)
    expect(result.status).toBe("executed")
    expect(requests.map((request) => request.url)).toEqual([`/api/repos/will/flows/contents/README.md?ref=${REVISION}`])
    expect(fileCard(store, `file-will/flows-README.md@${REVISION}`)?.payload).toMatchObject({ ref: REVISION, line: 1, content: README_TEXT })
  })
  test("asks the contents route for that revision, and keeps it on its own card", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.readFile("README.md", "will/flows", undefined, REVISION)

    expect(typeof outcome === "string" ? outcome : undefined).toBeUndefined()
    expect(requests.map((request) => request.url))
      .toEqual([`/api/repos/will/flows/contents/README.md?ref=${REVISION}`])
    const card = fileCard(store, `file-will/flows-README.md@${REVISION}`)
    expect(card?.payload).toEqual({
      repo: "will/flows",
      path: "README.md",
      content: README_TEXT,
      truncated: false,
      address: "/will/flows/README.md",
      ref: REVISION
    })
    /*
     * `readAt` is the position a plain read is taken at — the repository head
     * this session last saw. This read asked for something else, so the card
     * states the revision it asked for and claims no head.
     */
    expect(card?.payload.readAt).toBeUndefined()
    expect(CardSchema.safeParse(card).success).toBe(true)

    /* And a plain read of the same path is its own card, at its own address. */
    await controller.commands.run("files.read", "README.md will/flows")
    expect(fileCard(store, "file-will/flows-README.md")?.payload.ref).toBeUndefined()
    expect(fileCard(store, `file-will/flows-README.md@${REVISION}`)?.payload.ref).toBe(REVISION)
  })


})
