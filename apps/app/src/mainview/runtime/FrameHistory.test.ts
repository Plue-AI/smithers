import { describe,expect,test } from "bun:test"
import type { FrameLocation } from "./FrameHistory"
import { createBrowserFrameHistory,framePath,parseFramePath } from "./FrameHistory"

describe("frame URLs", () => {
  test("round-trip opaque workspace, branch, and frame ids", () => {
    const location = {
      workspaceId: "workspace/acme",
      branchId: "branch:main",
      frameId: "frame-card:branch:card/1"
    }
    const path = framePath(location)
    expect(path).toBe("/w/workspace%2Facme/b/branch%3Amain/f/frame-card%3Abranch%3Acard%2F1")
    expect(parseFramePath(path)).toEqual(location)
  })

  test("rejects unrelated, incomplete, and malformed paths", () => {
    expect(parseFramePath("/")).toBeUndefined()
    expect(parseFramePath("/w/a/b/b")).toBeUndefined()
    expect(parseFramePath("/w/%E0%A4%A/b/b/f/f")).toBeUndefined()
  })
})

/** A browser: an entry stack with a cursor, where back/forward move the cursor and fire popstate. */
const browser = (pathname: string) => {
  const entries: Array<{ state: unknown; pathname: string }> = [{ state: null, pathname }]
  let index = 0
  const listeners = new Set<() => void>()
  const travel = (step: number): void => {
    const next = index + step
    if (next < 0 || next >= entries.length) return
    index = next
    for (const listener of listeners) listener()
  }
  const host = {
    location: {
      get pathname() { return new URL(entries[index]!.pathname, "https://smithers.sh").pathname },
      get search() { return new URL(entries[index]!.pathname, "https://smithers.sh").search }
    },
    history: {
      get state() { return entries[index]!.state },
      pushState: (state: unknown, _unused: string, url?: string | URL | null) => {
        entries.splice(index + 1)
        entries.push({ state, pathname: String(url) })
        index = entries.length - 1
      },
      replaceState: (state: unknown, _unused: string, url?: string | URL | null) => {
        entries[index] = { state, pathname: String(url) }
      },
      back: () => travel(-1),
      forward: () => travel(1)
    },
    addEventListener: (_type: "popstate", listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: "popstate", listener: () => void) => void listeners.delete(listener)
  }
  return { host, entries: () => entries.map((entry) => entry.pathname) }
}

const root: FrameLocation = { workspaceId: "workspace-default", branchId: "branch-main", frameId: "frame-root:branch-main" }
const card: FrameLocation = { workspaceId: "workspace-default", branchId: "branch-main", frameId: "frame-card:branch-main:card-1" }

describe("browser frame history", () => {
  test.each(["codex", "claude"])("%s session links survive frame replacement, navigation and reload", agent => {
    const { host, entries } = browser(`/?${agent}=0199aaaa&tutorial`)
    const history = createBrowserFrameHistory(host)
    history.replace(root)
    history.push(card)
    expect(entries()).toEqual([`${framePath(root)}?${agent}=0199aaaa`, `${framePath(card)}?${agent}=0199aaaa`])
    const restored = createBrowserFrameHistory(host)
    expect(restored.current()).toEqual(card)
    restored.replace(card)
    expect(host.location.search).toBe(`?${agent}=0199aaaa`)
    restored.back()
    expect(restored.current()).toEqual(root)
  })

  test("legacy tutorial query does not change repository frame navigation", () => {
    const { host, entries } = browser("/smithersai/smithers/?tutorial")
    const history = createBrowserFrameHistory(host)
    history.replace(root)
    history.push(card)
    expect(entries()).toEqual(["/smithersai/smithers/", "/smithersai/smithers/"])
    const restored = createBrowserFrameHistory(host)
    restored.replace(card)
    expect(host.location.search).toBe("")
    restored.back()
    expect(restored.current()).toEqual(root)
  })

  test("booted from /owner/name, push and replace leave the pathname untouched and back/forward still report frames", () => {
    const { host, entries } = browser("/smithersai/smithers")
    const history = createBrowserFrameHistory(host)
    const seen: Array<FrameLocation | undefined> = []
    history.subscribe((location) => seen.push(location))

    expect(history.current()).toBeUndefined()
    history.replace(root)
    history.push(card)
    expect(host.location.pathname).toBe("/smithersai/smithers")
    expect(entries()).toEqual(["/smithersai/smithers", "/smithersai/smithers"])
    expect(history.current()).toEqual(card)

    history.back()
    expect(host.location.pathname).toBe("/smithersai/smithers")
    expect(seen).toEqual([root])
    history.forward()
    expect(seen).toEqual([root, card])
  })

  test("mounted with keepUrl at /, push and replace leave / in the address bar and back/forward still report frames", () => {
    const { host, entries } = browser("/")
    const history = createBrowserFrameHistory(host, { keepUrl: true })
    history.replace(root)
    history.push(card)
    expect(entries()).toEqual(["/", "/"])
    expect(history.current()).toEqual(card)
    history.back()
    expect(history.current()).toEqual(root)
    history.forward()
    expect(history.current()).toEqual(card)
  })

  test("booted from /, push and replace write the frame path and read it back", () => {
    const { host, entries } = browser("/")
    const history = createBrowserFrameHistory(host)
    history.replace(root)
    history.push(card)
    expect(host.location.pathname).toBe(framePath(card))
    expect(entries()).toEqual([framePath(root), framePath(card)])
    expect(history.current()).toEqual(card)
    const seen: Array<FrameLocation | undefined> = []
    history.subscribe((location) => seen.push(location))
    history.back()
    expect(seen).toEqual([root])
  })

  test("booted from a frame path, the entry is the current frame and pushes keep writing frame paths", () => {
    const { host } = browser(framePath(root))
    const history = createBrowserFrameHistory(host)
    expect(history.current()).toEqual(root)
    history.push(card)
    expect(host.location.pathname).toBe(framePath(card))
  })

  test("a foreign entry's state on a repository path is no frame", () => {
    const { host } = browser("/smithersai/smithers")
    host.history.replaceState({ smithersFrame: true, location: { workspaceId: 1 } }, "", "/smithersai/smithers")
    expect(createBrowserFrameHistory(host).current()).toBeUndefined()
  })
})
