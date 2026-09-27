import { scopedControllers } from "../ControllerTestScope"
import { silentAgent } from "../TestFixtures"
import type { AppServices } from "../AppController"
import { enforceSchemaVersion } from "../../chain/SchemaVersion"
import { ENVELOPE_STORAGE_KEY } from "../../chain/TransactionalStorage"
import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"
import * as Y from "yjs"
import { decodeWikiState, editWikiState, encodeWikiState, wikiDocumentId } from "../../wiki/CloudWiki"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createCloudWikiController } from "./cloud-wiki"
import { createControllerContext } from "./context"
import { createFramesController } from "./frames"

const createAppController = scopedControllers()
const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((close) => close())
})
const repo = "owner/repo"
const id = wikiDocumentId(repo, 42)
const memory = (): StorageApi => {
  const rows = new Map<string, string>()
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => {
      rows.set(key, value)
    },
    removeItem: (key) => {
      rows.delete(key)
    }
  }
}
const signIn = (store: AppStore, login = "will") =>
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login,
    allowlisted: true,
    admin: false,
    scopesPlain: null
  }).isPersisted.promise
const until = async (predicate: () => boolean) => {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Wiki state did not settle")
}

const fixture = async (storage = memory()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await signIn(store)
  const doc = new Y.Doc()
  doc.getText("markdown").insert(0, "# Page\n\nStart")
  let revision = 1
  let slug = "home"
  let pageId = 42
  let loseAck = false
  let wrongAck = false
  let pauseAck: Promise<void> | undefined
  let streamsClosed = 0
  const posts: Array<{ page_id: number; update_id: string; update: string }> = []
  const accepted = new Map<string, number>()
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const bootstrap = () => ({
    page: {
      id: pageId,
      slug,
      title: "Page",
      body: doc.getText("markdown").toString(),
      revision,
      author: { id: 1, login: "will" },
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z"
    },
    state: encodeWikiState(Y.encodeStateAsUpdate(doc)),
    state_vector: encodeWikiState(Y.encodeStateVector(doc))
  })
  const connect = (store: AppStore) => {
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        const url = String(input)
        if (url.includes("/stream?")) {
          return new Response(
            new ReadableStream({
              start(controller) {
                streams.add(controller)
                controller.enqueue(new TextEncoder().encode(": connected\n\n"))
              },
              cancel() {
                streamsClosed++
              }
            }),
            { headers: { "content-type": "text/event-stream" } }
          )
        }
        if (url.endsWith("/document")) return Response.json(bootstrap())
        if (url.endsWith("/updates") && init?.method === "POST") {
          const update = JSON.parse(String(init.body)) as typeof posts[number]
          posts.push(update)
          if (wrongAck) {
            return Response.json({ document: bootstrap(), update_id: update.update_id, accepted_revision: revision })
          }
          if (update.page_id !== pageId) {
            return Response.json({ message: "Page was replaced" }, { status: 409 })
          }
          if (!accepted.has(update.update_id)) {
            Y.applyUpdate(doc, decodeWikiState(update.update))
            revision++
            accepted.set(update.update_id, revision)
          }
          if (loseAck) {
            loseAck = false
            throw new Error("lost ack")
          }
          await pauseAck
          return Response.json({
            document: bootstrap(),
            update_id: update.update_id,
            accepted_revision: accepted.get(update.update_id)
          })
        }
        throw new Error(`Unexpected Wiki request ${url}`)
      }
    }
    const ctx = createControllerContext(store, silentAgent, services)
    // Forking announces itself through the toast law; a bare context has no failure controller.
    ctx.resolveToast = (key, outcome) => {
      store.dispatch({ type: "toast.resolved", actor: "system", key, ...outcome })
    }
    const wiki = createCloudWikiController(ctx, () => 1)
    cleanup.push(() => {
      ctx.dispose()
    })
    return { ctx, wiki, services }
  }
  const { ctx, wiki, services } = connect(store)
  cleanup.push(() => doc.destroy())
  const emit = (event: string, data: unknown, seq?: number) => {
    for (const stream of streams) {
      stream.enqueue(
        new TextEncoder().encode(
          `event: ${event}\n${seq === undefined ? "" : `id: ${seq}\n`}data: ${JSON.stringify(data)}\n\n`
        )
      )
    }
  }
  const remote = (body: string, newSlug = slug) => {
    Y.applyUpdate(doc, decodeWikiState(editWikiState(bootstrap().state, body).update))
    revision++
    slug = newSlug
    emit("wiki.update", { id: revision, page_id: pageId, revision, deleted: false, slug }, revision)
  }
  return {
    store,
    storage,
    ctx,
    wiki,
    posts,
    services,
    remote,
    bootstrap,
    emit,
    doc,
    reopen: async () => {
      ctx.dispose()
      const reopened = await createAppStore({ kind: "localStorage", storage })
      return { store: reopened, ...connect(reopened) }
    },
    loseAck: () => {
      loseAck = true
    },
    wrongAck: () => {
      wrongAck = true
    },
    pause: (promise: Promise<void>) => {
      pauseAck = promise
    },
    closed: () => streamsClosed,
    replace: () => {
      pageId = 43
    }
  }
}

const commandsFor = (f: Awaited<ReturnType<typeof fixture>>) => {
  const admissions: Array<ReturnType<typeof Promise.withResolvers<void>>> = []
  const controller = createAppController({ ...f.store, dispatch: transition => {
    const receipt = f.store.dispatch(transition)
    if (transition.type !== "command.intent.accepted" || transition.name !== "wiki.edit") return receipt
    const held = Promise.withResolvers<void>()
    admissions.push(held)
    return new Proxy(receipt, { get: (target, key, receiver) => key === "isPersisted"
    ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise) }
    : Reflect.get(target, key, receiver) })
  } }, silentAgent, f.services)
  return { controller, admissions }
}

describe("cloud Wiki controller", () => {
  test("a store with unadmitted Wiki input refuses version-14 writers without changing its bytes", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    const prepared = f.wiki.prepareCloudWiki(id, "# Private draft")!
    try {
      await f.store.settled?.()
      const before = f.storage.getItem(ENVELOPE_STORAGE_KEY)
      expect(f.store.committedWorldDocument(id)?.cloud?.pending[0]?.admitted).toBe(false)
      expect(() => enforceSchemaVersion(f.storage, { version: 14 })).toThrow("cannot be opened")
      expect(f.storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(before)
      expect(f.posts).toHaveLength(0)
    } finally { prepared.release() }
  })
  test("queued Wiki commands never project an older body over newer native typing", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    await controller.openCloudWiki(repo, "home")
    let text = f.store.collections.worldDocuments.get(id)!.body
    const replacements: string[] = []
    controller.attachWorldEditor(id, "card", {
      getMarkdown: () => text,
      setMarkdown: value => { replacements.push(value); text = value },
      scrollToLine: () => true
    })
    const firstBody = "# Page\n\nStart C", latestBody = "# Page\n\nStart Collaboration"
    text = firstBody
    const first = controller.commands.run("wiki.edit", `${id} ${JSON.stringify(text)}`)
    text = latestBody
    const latest = controller.commands.run("wiki.edit", `${id} ${JSON.stringify(text)}`)
    try {
      await f.store.settled?.()
      expect(f.posts).toHaveLength(0)
      admissions[0]!.resolve()
      expect((await first).status).toBe("executed")
      expect(text).toBe(latestBody)
      expect(replacements).toEqual([])
      expect(f.bootstrap().page.body).toBe(firstBody)
      admissions[1]!.resolve()
      expect((await latest).status).toBe("executed")
      expect(f.bootstrap().page.body).toBe(latestBody)
      expect(f.store.collections.worldDocuments.get(id)?.cloud?.pending).toEqual([])
    } finally {
      for (const held of admissions) held.resolve()
      await Promise.all([first, latest])
    }
  })

  test("a later accepted edit includes earlier typing without replaying it when receipts finish backwards", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    await controller.openCloudWiki(repo, "home")
    const first = controller.commands.run("wiki.edit", `${id} ${JSON.stringify("# Page\n\nC")}`)
    const latest = controller.commands.run("wiki.edit", `${id} ${JSON.stringify("# Page\n\nCollaboration")}`)
    try {
      admissions[1]!.resolve()
      expect((await latest).status).toBe("executed")
      expect(f.bootstrap().page.body).toBe("# Page\n\nCollaboration")
      const posts = f.posts.length
      admissions[0]!.resolve()
      expect((await first).status).toBe("executed")
      expect(f.posts).toHaveLength(posts)
      expect(f.store.collections.worldDocuments.get(id)?.body).toBe("# Page\n\nCollaboration")
    } finally {
      for (const held of admissions) held.resolve()
      await Promise.all([first, latest])
    }
  })

  test("a peer update and a held acknowledgement cannot publish or overwrite unadmitted typing", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    await controller.openCloudWiki(repo, "home")
    const ack = Promise.withResolvers<void>()
    f.pause(ack.promise)
    const first = controller.commands.run("wiki.edit", `${id} ${JSON.stringify("# Page\n\nStart C")}`)
    admissions[0]!.resolve()
    await until(() => f.posts.length === 1)
    const latest = controller.commands.run("wiki.edit", `${id} ${JSON.stringify("# Page\n\nStart Collaboration")}`)
    try {
      f.remote("# Peer\n\n# Page\n\nStart C")
      await until(() => f.store.collections.worldDocuments.get(id)?.body.includes("Peer") === true)
      expect(f.store.collections.worldDocuments.get(id)?.body).toContain("Collaboration")
      ack.resolve()
      expect((await first).status).toBe("executed")
      expect(f.posts).toHaveLength(1)
      expect(f.bootstrap().page.body).not.toContain("Collaboration")
      admissions[1]!.resolve()
      expect((await latest).status).toBe("executed")
      expect(f.bootstrap().page.body).toContain("Collaboration")
      expect(f.bootstrap().page.body).toContain("Peer")
      expect(f.store.collections.worldDocuments.get(id)?.cloud?.pending).toEqual([])
    } finally {
      ack.resolve()
      for (const held of admissions) held.resolve()
      await Promise.all([first, latest])
    }
  })

  test("Refresh cannot admit an active gesture; refused input stays local until an explicit retry", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    await controller.openCloudWiki(repo, "home")
    const pending = controller.commands.run("wiki.edit", `${id} ${JSON.stringify("# Saved private draft")}`)
    try {
      await controller.retryCloudWiki(id)
      expect(f.posts).toHaveLength(0)
      admissions[0]!.reject(new Error("admission storage failed"))
      expect((await pending).status).toBe("failed")
      expect(f.store.collections.worldDocuments.get(id)?.body).toBe("# Saved private draft")
      expect(f.posts).toHaveLength(0)
      await controller.retryCloudWiki(id)
      expect(f.bootstrap().page.body).toBe("# Saved private draft")
      expect(f.store.collections.worldDocuments.get(id)?.cloud?.pending).toEqual([])
    } finally {
      for (const held of admissions) held.resolve()
      await pending
    }
  })

  test("resubmitting the same refused text admits its existing update without duplicating it", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    await controller.openCloudWiki(repo, "home")
    const args = `${id} ${JSON.stringify("# Same saved draft")}`
    const first = controller.commands.run("wiki.edit", args)
    admissions[0]!.reject(new Error("admission failed"))
    expect((await first).status).toBe("failed")
    const update = f.store.collections.worldDocuments.get(id)!.cloud!.pending[0]!
    const second = controller.commands.run("wiki.edit", args)
    try {
      expect(f.store.collections.worldDocuments.get(id)?.cloud?.pending).toHaveLength(1)
      expect(f.posts).toHaveLength(0)
      admissions[1]!.resolve()
      expect((await second).status).toBe("executed")
      expect(f.posts).toHaveLength(1)
      expect(f.posts[0]).toMatchObject({ update_id: update.updateId, update: update.update })
      expect(f.bootstrap().page.body).toBe("# Same saved draft")
    } finally {
      for (const held of admissions) held.resolve()
      await second
    }
  })

  test("reload retains a prepared edit privately until Refresh authorizes publication", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    const prepared = f.wiki.prepareCloudWiki(id, "# Recovered draft")!
    await f.store.settled?.()
    prepared.release()
    const reopened = await f.reopen()
    expect(reopened.store.collections.worldDocuments.get(id)?.body).toBe("# Recovered draft")
    await reopened.wiki.openCloudWiki(repo, "home")
    expect(f.posts).toHaveLength(0)
    expect(reopened.store.collections.worldDocuments.get(id)?.cloud?.pending[0]?.admitted).toBe(false)
    await reopened.wiki.retryCloudWiki(id)
    expect(f.bootstrap().page.body).toBe("# Recovered draft")
    expect(reopened.store.collections.worldDocuments.get(id)?.cloud?.pending).toEqual([])
  })

  test("sign-out retires a prepared command without publishing or restoring its text", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    await controller.openCloudWiki(repo, "home")
    const pending = controller.commands.run("wiki.edit", `${id} ${JSON.stringify("# Private draft")}`)
    try {
      await f.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      admissions[0]!.resolve()
      expect((await pending).status).toBe("failed")
      expect(f.posts).toHaveLength(0)
      expect(f.store.collections.worldDocuments.get(id)).toBeUndefined()
    } finally {
      for (const held of admissions) held.resolve()
      await pending
    }
  })

  test("agent edits wait for admission before changing local text or publishing", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    await controller.openCloudWiki(repo, "home")
    const before = f.store.collections.worldDocuments.get(id)!.body
    const pending = controller.commands.runForAgent("wiki.edit", `${id} ${JSON.stringify("# Agent edit")}`)
    try {
      await f.store.settled?.()
      expect(f.store.collections.worldDocuments.get(id)?.body).toBe(before)
      expect(f.posts).toHaveLength(0)
      admissions[0]!.resolve()
      expect((await pending).status).toBe("executed")
      expect(f.bootstrap().page.body).toBe("# Agent edit")
      expect(f.store.collections.worldDocuments.get(id)?.updatedBy).toBe("system")
    } finally {
      for (const held of admissions) held.resolve()
      await pending
    }
  })

  test("local Wiki edits also prepare the latest text without replaying delayed commands", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    await f.store.dispatch({ type: "world.document.upserted", actor: "user", select: false,
      document: { id: "local-note", path: "Note.md", title: "Note", body: "# Note", tags: [], links: [], sources: [], confidence: 1 }
    }).isPersisted.promise
    const first = controller.commands.run("wiki.edit", `local-note ${JSON.stringify("# Note\n\nC")}`)
    const latest = controller.commands.run("wiki.edit", `local-note ${JSON.stringify("# Note\n\nCollaboration")}`)
    try {
      expect(f.store.collections.worldDocuments.get("local-note")?.body).toBe("# Note\n\nCollaboration")
      admissions[0]!.resolve()
      expect((await first).status).toBe("executed")
      expect(f.store.collections.worldDocuments.get("local-note")?.body).toBe("# Note\n\nCollaboration")
      admissions[1]!.resolve()
      expect((await latest).status).toBe("executed")
      expect(f.posts).toHaveLength(0)
    } finally {
      for (const held of admissions) held.resolve()
      await Promise.all([first, latest])
    }
  })

  test("open embeds the real page, persists a local edit, and reconciles a peer edit into the same row/editor", async () => {
    const f = await fixture()
    expect(await f.wiki.openCloudWiki(repo, "home")).toMatchObject({ value: expect.stringContaining("# Page") })
    expect(f.store.session().surface).toBe("chat")
    expect(f.store.collections.cards.get(`wiki-open-${id}`)?.kind).toBe("world")
    await f.wiki.editCloudWiki(id, "# Page\n\nLocal")
    expect(f.store.collections.worldDocuments.get(id)?.cloud).toMatchObject({ remoteRevision: 2, pending: [] })
    let editorText = "# Page\n\nLocal"
    f.wiki.attachWorldEditor(id, "card", {
      getMarkdown: () => editorText,
      setMarkdown: (text) => {
        editorText = text
      },
      scrollToLine: () => true
    })
    f.remote("# Page\n\nLocal\n\nPeer", "renamed")
    await until(() => f.store.collections.worldDocuments.get(id)?.cloud?.remoteRevision === 3)
    expect(f.store.collections.worldDocuments.get(id)?.path).toBe("owner/repo/wiki/renamed.md")
    expect(editorText).toBe("# Page\n\nLocal\n\nPeer")
  })

  test("an editor that escapes [[wikilinks]] is never overwritten by its own persisted body", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    await f.wiki.editCloudWiki(id, "# Page\n\nSee [[Other note]] here.")
    let pushes = 0
    f.wiki.attachWorldEditor(id, "card", {
      getMarkdown: () => "# Page\n\nSee \\[\\[Other note]] here.",
      setMarkdown: () => {
        pushes++
      },
      scrollToLine: () => true
    })
    await f.wiki.editCloudWiki(id, "# Page\n\nSee [[Other note]] here.")
    expect(f.store.collections.worldDocuments.get(id)?.body).toBe("# Page\n\nSee [[Other note]] here.")
    expect(pushes).toBe(0)
  })

  test("a lost acknowledgement retains exact UUID and bytes, reload retries those bytes once", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    f.loseAck()
    expect(await f.wiki.editCloudWiki(id, "# Page\n\nDurable edit")).toContain("pending edits")
    const pending = f.store.collections.worldDocuments.get(id)!.cloud!.pending[0]!
    expect(pending.updateId).toBe(f.posts[0]!.update_id)
    expect(pending.update).toBe(f.posts[0]!.update)
    const reopened = await f.reopen()
    expect(reopened.store.collections.worldDocuments.get(id)?.cloud?.phase).toBe("cached")
    expect(reopened.store.collections.worldDocuments.get(id)?.cloud?.pending[0]).toEqual(pending)
    expect(f.posts).toHaveLength(1)
    await reopened.wiki.retryCloudWiki(id)
    await until(() => reopened.store.collections.worldDocuments.get(id)?.cloud?.pending.length === 0)
    expect(f.posts[1]).toEqual(f.posts[0])
    expect(f.bootstrap().page.revision).toBe(2)
    expect(f.bootstrap().page.body).toBe("# Page\n\nDurable edit")
  })

  test("an acknowledgement UUID alone cannot clear a delta absent from the returned state", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    f.wrongAck()
    expect(await f.wiki.editCloudWiki(id, "# Page")).toContain("does not contain")
    expect(f.store.collections.worldDocuments.get(id)?.body).toBe("# Page")
    expect(f.store.collections.worldDocuments.get(id)?.cloud?.pending).toHaveLength(1)
  })

  test("an acknowledgement cannot discard typing that happened while its POST was in flight", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    let release!: () => void
    f.pause(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const first = f.wiki.editCloudWiki(id, "# Page\n\nFirst")
    await until(() => f.posts.length === 1)
    const second = f.wiki.editCloudWiki(id, "# Page\n\nFirst and second")
    expect(f.store.collections.worldDocuments.get(id)!.cloud!.pending).toHaveLength(2)
    release()
    await Promise.all([first, second])
    expect(f.store.collections.worldDocuments.get(id)?.body).toBe("# Page\n\nFirst and second")
    expect(f.store.collections.worldDocuments.get(id)?.cloud?.pending).toEqual([])
    expect(f.posts).toHaveLength(2)
  })

  test("sign-out clears cloud content and stops a late response from restoring it", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    let release!: () => void
    f.pause(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const editing = f.wiki.editCloudWiki(id, "# Page\n\nPrivate")
    await until(() => f.posts.length === 1)
    await f.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    release()
    await editing
    expect(f.store.collections.worldDocuments.get(id)).toBeUndefined()
    await until(() => f.closed() > 0)
  })

  test("forking a recorded page cannot publish pending edits from its original branch", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    f.loseAck()
    await f.wiki.editCloudWiki(id, "# Pending original")
    const before = f.posts.length
    const sourceBranch = f.store.session().activeBranchId
    const frames = createFramesController(f.ctx, undefined)
    frames.maximizeCard(`wiki-open-${id}`)
    await until(() => f.store.session().maximizedCardId !== null)
    await frames.forkFrame()
    await until(() => f.store.session().activeBranchId !== sourceBranch)
    expect(f.store.collections.worldDocuments.get(id)?.cloud?.phase).toBe("cached")
    expect(await f.wiki.editCloudWiki(id, "# Attempted historical edit")).toContain("Refresh")
    await f.wiki.retryCloudWiki(id)
    expect(f.store.collections.worldDocuments.get(id)?.cloud?.pending).toEqual([])
    expect(f.posts).toHaveLength(before)
    expect(
      f.store.collections.branches.get(sourceBranch!)?.snapshot?.worldDocuments.find((row) => row.id === id)?.cloud
        ?.pending
    ).toHaveLength(1)
  })

  test("revocation clears the page and deletion retains unsent edits without recreating the slug", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    f.emit("revoked", {})
    await until(() => f.store.collections.worldDocuments.get(id) === undefined)
    const g = await fixture()
    await g.wiki.openCloudWiki(repo, "home")
    g.loseAck()
    await g.wiki.editCloudWiki(id, "# Local draft")
    g.emit("wiki.update", { id: 3, page_id: 42, revision: 3, deleted: true, slug: "home" }, 3)
    await until(() => g.store.collections.worldDocuments.get(id)?.cloud?.phase === "deleted")
    await until(() => g.closed() === 1)
    expect(g.store.collections.worldDocuments.get(id)?.cloud?.pending).toHaveLength(1)
    expect(await g.wiki.editCloudWiki(id, "# Another draft")).toContain("Refresh")
    expect(g.posts).toHaveLength(1)
  })

  test("refresh cannot attach saved edits to a newly created page with the same slug", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    f.loseAck()
    await f.wiki.editCloudWiki(id, "# Original page edit")
    f.replace()
    expect(await f.wiki.retryCloudWiki(id)).toContain("different page")
    expect(f.store.collections.worldDocuments.get(id)?.cloud).toMatchObject({ pageId: 42, phase: "deleted" })
    expect(f.store.collections.worldDocuments.get(id)?.cloud?.pending).toHaveLength(1)
    expect(f.store.collections.worldDocuments.get(wikiDocumentId(repo, 43))).toBeUndefined()
    expect(f.posts).toHaveLength(1)
  })
})
