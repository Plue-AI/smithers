import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { PALETTE_MIRROR_KEY, rememberAppearance, THEME_MIRROR_KEY } from "./Appearance"
import { createAppStore, type AppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

/*
 * §20.4 — the persisted theme is painted BEFORE the first paint.
 *
 * Measured on canary: at first paint (t≈70ms) the document carried no
 * data-theme and no data-palette and the body was the built-in near-white; the
 * stored choice landed 155-290ms later. The store cannot fix this — it is
 * asynchronous by construction — so the fix is a synchronous bootstrap in the
 * document head reading a localStorage mirror.
 *
 * The bootstrap is inline script text in index.html, so this test executes THE
 * SHIPPED SOURCE rather than a copy of it: the script is extracted from the
 * file and run against a fake window and document. A regression that deletes
 * the script, or breaks it, fails here.
 */

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8")
const closeStore = async (store: AppStore): Promise<void> => {
  if (store.dispose === undefined) throw new Error("Fixture store has no disposal contract")
  await store.dispose()
}
const restoreStorage = (prior: PropertyDescriptor | undefined): void => {
  if (prior === undefined) Reflect.deleteProperty(globalThis, "localStorage")
  else Object.defineProperty(globalThis, "localStorage", prior)
}

/** The one inline (non-module) script the document carries. */
const bootstrapSource = (): string => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  if (match === null) throw new Error("index.html carries no inline appearance bootstrap")
  return match[1] ?? ""
}

interface FakeRoot {
  readonly attributes: Map<string, string>
}

const runBootstrap = (options: {
  readonly stored?: Readonly<Record<string, string>>
  readonly prefersDark?: boolean
  /** A browser that refuses storage entirely (private mode, disabled cookies). */
  readonly storageThrows?: boolean
}): FakeRoot => {
  const attributes = new Map<string, string>()
  const storage = {
    getItem: (key: string): string | null => {
      if (options.storageThrows === true) throw new Error("storage is disabled")
      return options.stored?.[key] ?? null
    }
  }
  const window = {
    get localStorage() {
      if (options.storageThrows === true) throw new Error("storage is disabled")
      return storage
    },
    matchMedia: (query: string) => ({
      matches: query.includes("dark") && options.prefersDark === true
    })
  }
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => void attributes.set(name, value)
    }
  }
  new Function("window", "document", bootstrapSource())(window, document)
  return { attributes }
}

describe("appearance mirroring when the storage accessor refuses access", () => {
  let originalStorage: PropertyDescriptor | undefined
  let storageReads: number

  beforeEach(() => {
    originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    storageReads = 0
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        storageReads += 1
        throw new DOMException("storage disabled", "SecurityError")
      }
    })
  })

  afterEach(() => {
    restoreStorage(originalStorage)
  })

  test("rememberAppearance returns when resolving localStorage throws", () => {
    expect(rememberAppearance(THEME_MIRROR_KEY, "dark")).toBeUndefined()
    expect(storageReads).toBeGreaterThan(0)
  })

  test("a memory-backed store boots and applies appearance changes", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    try {
      expect(store.persistenceMode).toBe("localStorage")
      expect(storageReads).toBeGreaterThanOrEqual(2)
      await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
      await store.dispatch({ type: "palette.changed", actor: "user", palette: "solarized" }).isPersisted.promise
      expect(store.session().theme).toBe("dark")
      expect(store.session().palette).toBe("solarized")
    } finally {
      await closeStore(store)
    }
  })
})

describe("the appearance bootstrap stamps the document before first paint", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const prefersDark of [false, true]) test(`the saved ${theme} choice overrides OS dark=${prefersDark}`, () => {
      const root = runBootstrap({ stored: { [THEME_MIRROR_KEY]: theme }, prefersDark })
      expect(root.attributes.get("data-theme")).toBe(theme)
      expect(root.attributes.get("data-palette")).toBe("paper")
    })
  }

  test("the mirrored light/dark choice is preserved while a legacy palette normalizes", () => {
    const root = runBootstrap({
      stored: { [THEME_MIRROR_KEY]: "dark", [PALETTE_MIRROR_KEY]: "rose-pine" }
    })
    expect(root.attributes.get("data-theme")).toBe("dark")
    expect(root.attributes.get("data-palette")).toBe("paper")
  })

  test("a first run with no mirror follows the operating system preference", () => {
    expect(runBootstrap({ prefersDark: true }).attributes.get("data-theme")).toBe("dark")
    expect(runBootstrap({ prefersDark: false }).attributes.get("data-theme")).toBe("light")
  })

  test("a junk mirror is ignored rather than stamped", () => {
    const root = runBootstrap({
      stored: { [THEME_MIRROR_KEY]: "neon", [PALETTE_MIRROR_KEY]: "\"><script>" },
      prefersDark: true
    })
    expect(root.attributes.get("data-theme")).toBe("dark")
    expect(root.attributes.get("data-palette")).toBe("paper")
  })

  test("a browser that refuses storage still paints a theme", () => {
    expect(runBootstrap({ storageThrows: true }).attributes.get("data-theme")).toBe("light")
  })

  test("the next boot reads light/dark and paints Paper despite a legacy palette mirror", async () => {
    // The mirror is written by AppStore's own apply step, so the value the
    // bootstrap finds is by construction the value the app last painted.
    const written = new Map<string, string>()
    const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    let store: AppStore | undefined
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => written.get(key) ?? null,
      setItem: (key: string, value: string) => void written.set(key, value),
      removeItem: (key: string) => void written.delete(key)
    } })
    try {
      store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
      await store.dispatch({ type: "palette.changed", actor: "user", palette: "solarized" }).isPersisted.promise
      expect(written.get(THEME_MIRROR_KEY)).toBe("dark")
      expect(written.get(PALETTE_MIRROR_KEY)).toBe("solarized")
      const root = runBootstrap({
        stored: Object.fromEntries(written)
      })
      expect(root.attributes.get("data-theme")).toBe("dark")
      expect(root.attributes.get("data-palette")).toBe("paper")
    } finally {
      try { if (store) await closeStore(store) } finally { restoreStorage(prior) }
    }
  })

  test("the bootstrap is inline in the head, ahead of the module that loads the app", () => {
    // A deferred module script runs after paint, which IS the defect: the
    // order and the inlining are both part of the fix.
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<script type=\"module\""))
    expect(html.indexOf("</head>")).toBeGreaterThan(html.indexOf("<script>"))
  })
})

describe("appearance mirrors remain best effort", () => {
  for (const [key, value, expectedKey] of [
    [THEME_MIRROR_KEY, "dark", "smithers-mvp.theme"],
    [PALETTE_MIRROR_KEY, "rose-pine", "smithers-mvp.palette"]
  ] as const) {
    for (const refuses of [false, true]) test(`mirror ${expectedKey} tolerates write refusal=${refuses}`, () => {
      const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
      const writes: Array<[string, string]> = []
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        setItem: (actualKey: string, actualValue: string) => {
          writes.push([actualKey, actualValue])
          if (refuses) throw new DOMException("fixture quota refused", "QuotaExceededError")
        }
      } })
      try {
        expect(rememberAppearance(key, value)).toBeUndefined()
        expect(writes).toEqual([[expectedKey, value]])
      } finally { restoreStorage(prior) }
    })
  }
})
