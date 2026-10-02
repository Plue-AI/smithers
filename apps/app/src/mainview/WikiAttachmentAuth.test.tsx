import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { startLocalServer } from "../bun/server"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { ControllerContext } from "./ControllerContext"
import { WorldSurface } from "./WorldSurface"
import { createApplicationClient } from "./runtime/ApplicationClient"
import type { AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import { memoryStorage, waitFor } from "./state/TestFixtures"
import { createWikiAttachmentStore } from "./wiki/WikiAttachmentStore"
import { WikiPageView } from "./wiki/WikiPageView"

const networkFetch = globalThis.fetch.bind(globalThis)
const NetworkResponse = globalThis.Response
const NetworkRequest = globalThis.Request
const NetworkHeaders = globalThis.Headers
const NetworkAbortController = globalThis.AbortController
const NetworkAbortSignal = globalThis.AbortSignal
GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const repo = "owner/repo"
const imagePath = "/api/repos/owner/repo/wiki/history/3/1/content?visibility=private"
const archivePath = "/api/repos/owner/repo/wiki/history/4/2/content?visibility=private"
const imageBytes = new Uint8Array([137, 80, 78, 71, 0, 1])
const archiveBytes = new Uint8Array([80, 75, 3, 4, 0, 2])
const page = (id: number, revision: number, path: string, mediaType: string, size: number) => ({
  id, revision, slug: path.split("/").pop()!.toLowerCase(), title: path.split("/").pop()!, path,
  updatedAt: "2026-09-29T00:00:00Z", tags: [], aliases: [], headings: [], links: [], backlinks: [],
  attachment: { digest: "a".repeat(64), mediaType, size }
})

test("the Wiki pane uses its selected application identity to display and download private attachment bytes", async () => {
  const browserFetch = globalThis.fetch
  const browserRequest = globalThis.Request
  const browserResponse = globalThis.Response
  const browserHeaders = globalThis.Headers
  const browserAbortController = globalThis.AbortController
  const browserAbortSignal = globalThis.AbortSignal
  globalThis.fetch = networkFetch
  globalThis.Request = NetworkRequest
  globalThis.Response = NetworkResponse
  globalThis.Headers = NetworkHeaders
  globalThis.AbortController = NetworkAbortController
  globalThis.AbortSignal = NetworkAbortSignal
  const dist = mkdtempSync(join(tmpdir(), "smithers-wiki-attachment-"))
  writeFileSync(join(dist, "index.html"), "<div id='root'></div>")
  const seen: Array<{ path: string; authorization: string | null }> = []
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    const path = `${url.pathname}${url.search}`
    seen.push({ path, authorization: request.headers.get("authorization") })
    if (request.headers.get("authorization") !== "Bearer selected-pat") return new NetworkResponse("Unauthorized", { status: 401 })
    if (path === imagePath) return new NetworkResponse(imageBytes, { headers: { "content-type": "image/png" } })
    if (path === archivePath) return new NetworkResponse(archiveBytes, { headers: { "content-type": "application/zip" } })
    return new NetworkResponse("Not found", { status: 404 })
  } })
  const native = await startLocalServer({ port: 0, distDir: dist, cloudMode: "hybrid",
    identityUpstream: null, cloudApi: `http://127.0.0.1:${remote.port}`, home: "/test/home", log: () => {},
    cloudAuth: { token: () => "selected-pat", session: () => ({ state: "signed-in", username: "owner", expiresAt: null }),
      start: async () => ({ error: "already signed in" }), signOut: async () => {}, stop: async () => {} }
  })
  const blobUrls = new Map<string, Blob>()
  const revoked: string[] = []
  let nextBlob = 0
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = (blob) => {
    if (!("arrayBuffer" in blob) || typeof blob.arrayBuffer !== "function") {
      throw new Error("Expected attachment bytes as a Blob")
    }
    const url = `blob:wiki-attachment-${++nextBlob}`
    blobUrls.set(url, blob)
    return url
  }
  URL.revokeObjectURL = (url) => { revoked.push(url); blobUrls.delete(url) }
  let root: ReturnType<typeof createRoot> | undefined
  let host: HTMLDivElement | undefined
  let store: Awaited<ReturnType<typeof createAppStore>> | undefined
  try {
    const target = resolveApplicationTarget({ apiVersion: 1, mode: "local-plue", apiOrigin: native.origin,
      auth: { kind: "bearer" }, cors: "same-origin", developerExternal: false }, native.origin)
    const client = createApplicationClient(target, { token: () => "selected-pat", pageOrigin: native.origin,
      // Bun's fetch lacks the browser's relative-URL resolution for a same-origin renderer.
      fetchImpl: (input, init) => {
        const url = new URL(String(input), native.origin)
        const headers = new NetworkHeaders(init?.headers)
        headers.set(LOCAL_SESSION_HEADER, native.sessionToken)
        return networkFetch(new URL(`/api/cloud${url.pathname}${url.search}`, native.origin).toString(), { ...init, headers })
      } })
    const wikiAttachments = createWikiAttachmentStore({ http: client.fetch, baseUrl: client.baseUrl })
    store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: repo, org: "owner", ownerKind: "user", name: "repo", head: null }
    ] }).isPersisted.promise
    await store.dispatch({ type: "wiki.space.changed", actor: "user", space: "private" }).isPersisted.promise
    const index = { id: `${repo}#private`, repo, space: "private" as const, loadedAt: 1,
      pages: [page(3, 1, "assets/logo.png", "image/png", imageBytes.length),
        page(4, 2, "assets/archive.zip", "application/zip", archiveBytes.length)],
      folders: ["assets"], tags: [] }
    const wikiIndexes = { get: (candidate: string, space: string) => candidate === repo && space === "private" ? index : undefined,
      subscribe: () => () => {} }
    const controller = { store, wikiIndexes, wikiAttachments, runCommand: () => {},
      changeWorldDocument: () => {}, attachWikiEditor: () => {}, attachWorldEditor: () => {} } as unknown as AppController
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    flushSync(() => root!.render(<ControllerContext value={controller}><WorldSurface documents={[]} /></ControllerContext>))

    await store.dispatch({ type: "world.document.selected", actor: "user", id: `wiki:${repo}:3` }).isPersisted.promise
    try {
      await waitFor(() => host!.querySelector<HTMLImageElement>('[data-testid="wiki-attachment"] img')?.src.startsWith("blob:") === true)
    } catch (error) {
      throw new Error(`image did not load: selected=${store.session().selectedWorldDocumentId}; attachment=${host.querySelector('[data-testid="wiki-attachment"]')?.innerHTML}; requests=${JSON.stringify(seen)}; snapshot=${JSON.stringify(wikiAttachments.get(imagePath))}`, { cause: error })
    }
    const imageUrl = host.querySelector<HTMLImageElement>('[data-testid="wiki-attachment"] img')!.src
    expect(await blobUrls.get(imageUrl)?.arrayBuffer().then((buffer) => [...new Uint8Array(buffer)])).toEqual([...imageBytes])
    expect(blobUrls.get(imageUrl)?.type).toBe("image/png")

    await store.dispatch({ type: "world.document.selected", actor: "user", id: `wiki:${repo}:4` }).isPersisted.promise
    await waitFor(() => host!.querySelector<HTMLAnchorElement>('[data-testid="wiki-attachment"] a')?.href.startsWith("blob:") === true)
    const download = host.querySelector<HTMLAnchorElement>('[data-testid="wiki-attachment"] a')!
    expect(download.download).toBe("archive.zip")
    expect(await blobUrls.get(download.href)?.arrayBuffer().then((buffer) => [...new Uint8Array(buffer)])).toEqual([...archiveBytes])
    expect(revoked).toContain(imageUrl)

    const raw = await networkFetch(`${native.origin}/api/cloud${imagePath}`)
    const foreign = await networkFetch(`${native.origin}/api/cloud${archivePath}`, { headers: { authorization: "Bearer foreign-pat" } })
    expect([raw.status, foreign.status]).toEqual([401, 401])
    expect(seen.filter((request) => request.authorization === "Bearer selected-pat").map((request) => request.path))
      .toEqual([imagePath, archivePath])
    // Unauthenticated local requests are refused before reaching the upstream.
    expect(seen.filter((request) => request.authorization === null)).toEqual([])
    const downloadUrl = download.href
    flushSync(() => root!.render(<ControllerContext value={controller}><WikiPageView
      body="![[assets/logo.png]]" links={[{ target: "assets/logo.png", embed: true, pageId: 3 }]}
      index={index} repo={repo} space="private" onOpen={() => {}}
    /></ControllerContext>))
    await waitFor(() => host!.querySelector<HTMLImageElement>('[data-testid="wiki-embed"] img')?.src.startsWith("blob:") === true)
    const embeddedImageUrl = host.querySelector<HTMLImageElement>('[data-testid="wiki-embed"] img')!.src
    expect(await blobUrls.get(embeddedImageUrl)?.arrayBuffer().then((buffer) => [...new Uint8Array(buffer)])).toEqual([...imageBytes])
    expect(seen.at(-1)).toEqual({ path: imagePath, authorization: "Bearer selected-pat" })
    wikiAttachments.clear()
    await waitFor(() => revoked.includes(downloadUrl))
    await waitFor(() => revoked.includes(embeddedImageUrl))
  } finally {
    if (root !== undefined) {
      const mountedRoot = root
      flushSync(() => mountedRoot.unmount())
    }
    host?.remove()
    await store?.dispose?.()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    await native.stop()
    remote.stop(true)
    rmSync(dist, { recursive: true, force: true })
    globalThis.fetch = browserFetch
    globalThis.Request = browserRequest
    globalThis.Response = browserResponse
    globalThis.Headers = browserHeaders
    globalThis.AbortController = browserAbortController
    globalThis.AbortSignal = browserAbortSignal
  }
})

test("retiring an attachment request discards delayed bytes and a later selection retries", async () => {
  const held = Promise.withResolvers<Response>()
  const replacement = Promise.withResolvers<Response>()
  const seenSignals: AbortSignal[] = []
  let reads = 0
  const created: string[] = []
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => { const url = `blob:retired-${created.length + 1}`; created.push(url); return url }
  URL.revokeObjectURL = () => {}
  const attachments = createWikiAttachmentStore({ baseUrl: "https://app.test", http: async (_input, init) => {
    reads++
    seenSignals.push(init?.signal as AbortSignal)
    return reads === 1 ? held.promise : replacement.promise
  } })
  try {
    let notices = 0
    const unsubscribe = attachments.subscribe(imagePath, () => { notices++ })
    expect(reads).toBe(1)
    attachments.clear()
    expect(seenSignals[0]?.aborted).toBe(true)
    expect(attachments.get(imagePath)?.error?.sentence).toBe("Attachment unavailable.")
    expect(created).toEqual([])
    unsubscribe()

    const retry = attachments.subscribe(imagePath, () => { notices++ })
    expect(reads).toBe(2)
    held.resolve(new Response(imageBytes, { headers: { "content-type": "image/png" } }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(attachments.get(imagePath)).toBeUndefined()
    expect(created).toEqual([])
    replacement.resolve(new Response(imageBytes, { headers: { "content-type": "image/png" } }))
    await waitFor(() => attachments.get(imagePath)?.url !== undefined)
    expect(reads).toBe(2)
    expect(attachments.get(imagePath)?.url).toBe("blob:retired-1")
    expect(notices).toBeGreaterThan(0)
    retry()
    expect(attachments.get(imagePath)).toBeUndefined()
  } finally {
    held.resolve(new Response(imageBytes))
    replacement.resolve(new Response(imageBytes))
    attachments.dispose()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test("an attachment refusal surfaces an error and a new selection can recover", async () => {
  let allowed = false
  const attachments = createWikiAttachmentStore({ baseUrl: "https://app.test", http: async () => allowed
    ? new Response(archiveBytes, { headers: { "content-type": "application/zip" } })
    : new Response("Forbidden", { status: 403 }) })
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => "blob:recovered-attachment"
  URL.revokeObjectURL = () => {}
  try {
    const denied = attachments.subscribe(archivePath, () => {})
    await waitFor(() => attachments.get(archivePath)?.error !== undefined)
    expect(attachments.get(archivePath)?.error).toMatchObject({
      tag: "WikiAttachmentReadFailed", sentence: "Attachment unavailable."
    })
    denied()
    allowed = true
    const retry = attachments.subscribe(archivePath, () => {})
    await waitFor(() => attachments.get(archivePath)?.url !== undefined)
    expect(attachments.get(archivePath)).toEqual({ url: "blob:recovered-attachment" })
    retry()
  } finally {
    attachments.dispose()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test("a session-authenticated attachment keeps its browser session through the selected browser transport", async () => {
  const browserFetch = globalThis.fetch
  const browserRequest = globalThis.Request
  const browserResponse = globalThis.Response
  const browserHeaders = globalThis.Headers
  const browserAbortController = globalThis.AbortController
  const browserAbortSignal = globalThis.AbortSignal
  globalThis.fetch = networkFetch
  globalThis.Request = NetworkRequest
  globalThis.Response = NetworkResponse
  globalThis.Headers = NetworkHeaders
  globalThis.AbortController = NetworkAbortController
  globalThis.AbortSignal = NetworkAbortSignal
  const dist = mkdtempSync(join(tmpdir(), "smithers-wiki-session-"))
  writeFileSync(join(dist, "index.html"), "<div id='root'></div>")
  const seen: Array<{ path: string; cookie: string | null }> = []
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname + new URL(request.url).search
    seen.push({ path, cookie: request.headers.get("cookie") })
    if (path === "/api/login") return new NetworkResponse("signed in", {
      headers: { "set-cookie": "smithers_session=owner; HttpOnly; Path=/" }
    })
    return request.headers.get("cookie") === "smithers_session=owner" && path === imagePath
      ? new NetworkResponse(imageBytes, { headers: { "content-type": "image/png" } })
      : new NetworkResponse("Unauthorized", { status: 401 })
  } })
  const native = { origin: `http://127.0.0.1:${remote.port}`, stop: async () => {} }
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => "blob:session-attachment"
  URL.revokeObjectURL = () => {}
  try {
    expect((await networkFetch(`${native.origin}/api/login`)).status).toBe(200)
    const target = resolveApplicationTarget({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "",
      auth: { kind: "session" }, cors: "same-origin", developerExternal: false }, native.origin)
    const client = createApplicationClient(target, { pageOrigin: native.origin,
      fetchImpl: (input, init) => {
        expect(init?.credentials).toBe("include")
        const headers = new NetworkHeaders(init?.headers)
        // Native fetch has no browser cookie jar; this is the renderer's stored cookie.
        headers.set("cookie", "smithers_session=owner")
        return networkFetch(new URL(String(input), native.origin).toString(), { ...init, headers })
      } })
    const attachments = createWikiAttachmentStore({ http: client.fetch, baseUrl: client.baseUrl })
    try {
      const unsubscribe = attachments.subscribe(imagePath, () => {})
      try { await waitFor(() => attachments.get(imagePath)?.url !== undefined) }
      catch (error) { throw new Error(`session attachment failed: ${JSON.stringify({ seen, snapshot: attachments.get(imagePath), baseUrl: client.baseUrl })}`, { cause: error }) }
      expect(attachments.get(imagePath)?.url).toBe("blob:session-attachment")
      unsubscribe()
      expect((await networkFetch(`${native.origin}${imagePath}`, { headers: { cookie: "smithers_session=owner" } })).status).toBe(200)
      expect(seen).toEqual([
        { path: "/api/login", cookie: null },
        { path: imagePath, cookie: "smithers_session=owner" },
        { path: imagePath, cookie: "smithers_session=owner" }
      ])
    } finally { attachments.dispose() }
  } finally {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    await native.stop()
    remote.stop(true)
    rmSync(dist, { recursive: true, force: true })
    globalThis.fetch = browserFetch
    globalThis.Request = browserRequest
    globalThis.Response = browserResponse
    globalThis.Headers = browserHeaders
    globalThis.AbortController = browserAbortController
    globalThis.AbortSignal = browserAbortSignal
  }
})

test("two views share one large attachment read and revoke its URL after the last view closes", async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024 + 1)
  bytes[0] = 1
  bytes[bytes.length - 1] = 2
  let reads = 0
  let object: Blob | undefined
  const revoked: string[] = []
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = (blob) => {
    if (!("arrayBuffer" in blob) || typeof blob.arrayBuffer !== "function") {
      throw new Error("Expected attachment bytes as a Blob")
    }
    object = blob
    return "blob:shared-large-attachment"
  }
  URL.revokeObjectURL = (url) => { revoked.push(url) }
  const attachments = createWikiAttachmentStore({ baseUrl: "https://app.test", http: async () => {
    reads++
    return new NetworkResponse(bytes, { headers: { "content-type": "application/octet-stream" } })
  } })
  try {
    const first = attachments.subscribe(archivePath, () => {})
    const second = attachments.subscribe(archivePath, () => {})
    await waitFor(() => attachments.get(archivePath)?.url !== undefined)
    expect(reads).toBe(1)
    expect(object?.size).toBe(bytes.length)
    expect(object?.type).toBe("application/octet-stream")
    expect(new Uint8Array(await object!.arrayBuffer()).at(-1)).toBe(2)
    first()
    expect(attachments.get(archivePath)?.url).toBe("blob:shared-large-attachment")
    expect(revoked).toEqual([])
    second()
    expect(revoked).toEqual(["blob:shared-large-attachment"])
  } finally {
    attachments.dispose()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test("disposing an attachment store aborts work, revokes bytes, and refuses a new read", async () => {
  let reads = 0
  let aborted = false
  const revoked: string[] = []
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => "blob:disposed-attachment"
  URL.revokeObjectURL = (url) => { revoked.push(url) }
  const attachments = createWikiAttachmentStore({ baseUrl: "https://app.test", http: async (_input, init) => {
    reads++
    init?.signal?.addEventListener("abort", () => { aborted = true })
    return new NetworkResponse(imageBytes, { headers: { "content-type": "image/png" } })
  } })
  try {
    const unsubscribe = attachments.subscribe(imagePath, () => {})
    await waitFor(() => attachments.get(imagePath)?.url !== undefined)
    attachments.dispose()
    expect(aborted).toBe(true)
    expect(revoked).toEqual(["blob:disposed-attachment"])
    const later = attachments.subscribe(imagePath, () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toBe(1)
    later()
    unsubscribe()
  } finally {
    attachments.dispose()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test("an untrusted attachment route cannot invoke the authenticated transport", async () => {
  let reads = 0
  const attachments = createWikiAttachmentStore({ baseUrl: "https://app.test", http: async () => {
    reads++
    return new NetworkResponse(imageBytes)
  } })
  try {
    const unsubscribe = attachments.subscribe("https://foreign.example/api/repos/owner/repo/wiki/history/3/1/content?visibility=private", () => {})
    await waitFor(() => attachments.get("https://foreign.example/api/repos/owner/repo/wiki/history/3/1/content?visibility=private")?.error !== undefined)
    expect(reads).toBe(0)
    unsubscribe()
  } finally { attachments.dispose() }
})

test("a retained view shares a retry after identity clear until both views release it", async () => {
  let reads = 0
  let nextUrl = 0
  const revoked: string[] = []
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => `blob:identity-retry-${++nextUrl}`
  URL.revokeObjectURL = (url) => { revoked.push(url) }
  const attachments = createWikiAttachmentStore({ baseUrl: "https://app.test", http: async () => {
    reads++
    return new NetworkResponse(imageBytes, { headers: { "content-type": "image/png" } })
  } })
  let leaveA: (() => void) | undefined
  let leaveB: (() => void) | undefined
  try {
    const aSnapshots: Array<string | undefined> = []
    leaveA = attachments.subscribe(imagePath, () => { aSnapshots.push(attachments.get(imagePath)?.url) })
    await waitFor(() => attachments.get(imagePath)?.url === "blob:identity-retry-1")
    expect(aSnapshots.at(-1)).toBe("blob:identity-retry-1")
    attachments.clear()
    expect(revoked).toEqual(["blob:identity-retry-1"])
    expect(reads).toBe(1)
    expect(attachments.get(imagePath)?.error?.sentence).toBe("Attachment unavailable.")

    leaveB = attachments.subscribe(imagePath, () => {})
    await waitFor(() => attachments.get(imagePath)?.url === "blob:identity-retry-2")
    expect(reads).toBe(2)
    expect(aSnapshots.at(-1)).toBe("blob:identity-retry-2")
    leaveB()
    leaveB = undefined
    expect(attachments.get(imagePath)?.url).toBe("blob:identity-retry-2")
    expect(revoked).toEqual(["blob:identity-retry-1"])
    leaveA()
    leaveA = undefined
    expect(revoked).toEqual(["blob:identity-retry-1", "blob:identity-retry-2"])
    expect(attachments.get(imagePath)).toBeUndefined()
  } finally {
    leaveB?.()
    leaveA?.()
    attachments.dispose()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})
