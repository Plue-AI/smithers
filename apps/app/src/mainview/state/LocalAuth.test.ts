import { describe, expect, test } from "bun:test"
import { ApplicationClientError, type LocalIdentityClient } from "../runtime/ApplicationClient"
import { createLocalAuthController } from "./LocalAuth"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("local owner authentication", () => {
  test("uses bootstrap before initialization and login afterwards", async () => {
    const calls: unknown[] = []
    let initialized = false
    const client: LocalIdentityClient = {
      status: async () => ({ enabled: true, initialized }),
      bootstrap: async (request) => {
        calls.push(["bootstrap", request])
        initialized = true
        return { user: { id: 1, username: request.username } }
      },
      login: async (request) => {
        calls.push(["login", request])
        return { user: { id: 1, username: request.username } }
      }
    }
    let authenticated = 0
    const auth = createLocalAuthController(client, async () => { authenticated += 1 })

    auth.open()
    await tick()
    await auth.submit({ username: "owner", password: "first secret", bootstrapToken: "setup" })
    expect(calls).toEqual([["bootstrap", {
      username: "owner",
      password: "first secret",
      bootstrapToken: "setup"
    }]])
    expect(authenticated).toBe(1)
    expect(auth.snapshot()).toEqual({
      open: false,
      pending: false,
      status: { enabled: true, initialized: true, username: "owner" },
      error: null
    })

    auth.open()
    await tick()
    await auth.submit({ username: "owner", password: "next secret" })
    expect(calls[1]).toEqual(["login", { username: "owner", password: "next secret" }])
    expect(authenticated).toBe(2)
    expect(JSON.stringify(auth.snapshot())).not.toContain("secret")
  })

  test("opening again retries a failed status read", async () => {
    let reads = 0
    const client: LocalIdentityClient = {
      status: async () => {
        reads += 1
        if (reads === 1) throw new Error("offline secret-socket-detail")
        return { enabled: true, initialized: true }
      },
      bootstrap: async () => { throw new Error("unused") },
      login: async ({ username }) => ({ user: { id: 1, username } })
    }
    const auth = createLocalAuthController(client, async () => {})
    auth.open()
    await tick()
    /* An untagged throw's text is never the sentence. */
    expect(auth.snapshot()).toMatchObject({ open: true, pending: false, status: null, error: "Local sign-in could not finish. Try again." })
    expect(JSON.stringify(auth.snapshot())).not.toContain("secret-socket-detail")

    auth.open()
    await tick()
    expect(reads).toBe(2)
    expect(auth.snapshot()).toMatchObject({ open: true, pending: false, status: { enabled: true, initialized: true }, error: null })
  })

  test("native setup reads its trusted bootstrap token only when submitted", async () => {
    let tokenReads = 0
    let received: unknown
    const client: LocalIdentityClient = {
      status: async () => ({ enabled: true, initialized: false }),
      bootstrap: async (request) => {
        received = request
        return { user: { id: 1, username: request.username } }
      },
      login: async () => { throw new Error("unused") }
    }
    const auth = createLocalAuthController(client, async () => {}, async () => {
      tokenReads += 1
      return "native bootstrap secret"
    })
    expect(auth.requiresBootstrapTokenInput).toBe(false)
    auth.open()
    await tick()
    expect(tokenReads).toBe(0)
    await auth.submit({ username: "owner", password: "strong password" })
    expect(tokenReads).toBe(1)
    expect(received).toEqual({
      username: "owner",
      password: "strong password",
      bootstrapToken: "native bootstrap secret"
    })
    expect(JSON.stringify(auth.snapshot())).not.toContain("native bootstrap secret")
  })

  test("a server refusal keeps its words; a dropped request never shows its thrown text", async () => {
    let answer: "refused" | "dropped" = "refused"
    const client: LocalIdentityClient = {
      status: async () => ({ enabled: true, initialized: true }),
      bootstrap: async () => { throw new Error("unused") },
      login: async () => {
        throw answer === "refused"
          ? new ApplicationClientError("unauthenticated", "Invalid username or password.", 401, "unauthenticated")
          : new ApplicationClientError("transport", "ECONNRESET secret-socket-detail", null, null, null, { cause: new TypeError("ECONNRESET secret-socket-detail") })
      }
    }
    const auth = createLocalAuthController(client, async () => {})
    auth.open()
    await tick()
    await auth.submit({ username: "owner", password: "wrong" })
    expect(auth.snapshot().error).toBe("Invalid username or password.")
    answer = "dropped"
    await auth.submit({ username: "owner", password: "wrong" })
    expect(auth.snapshot().error).not.toBeNull()
    expect(auth.snapshot().error).not.toContain("secret-socket-detail")
  })

  test("close and dispose cancel the outstanding status request", async () => {
    const signals: AbortSignal[] = []
    const client: LocalIdentityClient = {
      status: (signal) => {
        if (signal !== undefined) signals.push(signal)
        return new Promise(() => {})
      },
      bootstrap: async () => { throw new Error("unused") },
      login: async () => { throw new Error("unused") }
    }
    const auth = createLocalAuthController(client, async () => {})
    auth.open()
    expect(signals[0]?.aborted).toBe(false)
    auth.close()
    expect(signals[0]?.aborted).toBe(true)
    auth.open()
    auth.dispose()
    expect(signals[1]?.aborted).toBe(true)
  })
})
