/**
 * The credential contract: create, resolve, rotate, revoke, unauthorized
 * access, redaction, and encrypted persistence.
 */
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { Unauthorized } from "../src/ControlError.ts"
import * as Credential from "../src/Credential.ts"
import * as CredentialCipher from "../src/CredentialCipher.ts"
import * as CredentialStore from "../src/CredentialStore.ts"
import * as WebCryptoCipher from "../src/WebCryptoCipher.ts"

/** 32 raw bytes, base64 — the shape a host key takes. */
const hostKey = Redacted.make(btoa("0123456789abcdef0123456789abcdef"))

const boundary = (
  options: { readonly authorize?: Credential.Options["authorize"] } = {}
): Effect.Effect<{
  readonly credentials: Credential.Credential
  readonly store: CredentialStore.Service
}> =>
  Effect.gen(function*() {
    const store = CredentialStore.makeMemory()
    const cipher = yield* WebCryptoCipher.make({ key: hostKey }).pipe(Effect.orDie)
    return {
      store,
      credentials: Credential.make({
        store,
        cipher,
        ...(options.authorize === undefined ? {} : { authorize: options.authorize })
      })
    }
  })

const created = (credentials: Credential.Credential, secret = "sk-live-1") =>
  credentials.create({ id: "exa", name: "Exa search", secret: Redacted.make(secret) })

/**
 * The typed error an effect failed with.
 *
 * Asserted field by field: these errors extend `Error`, whose `cause` is a
 * getter, and a structural matcher tries to write to it.
 */
const failureOf = async (effect: Effect.Effect<unknown, unknown>): Promise<Record<string, unknown>> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a typed failure")
  return Cause.squash(exit.cause) as Record<string, unknown>
}

const expectUnavailable = (error: Record<string, unknown>, feature?: string): void => {
  expect(error._tag).toBe("/control/Unavailable")
  expect(error.ticket).toBe("control-credential-storage")
  if (feature !== undefined) expect(error.feature).toBe(feature)
}

/** A stored record that does not open under its own metadata. */
const expectOpenRefused = (error: Record<string, unknown>): void => {
  expect(error._tag).toBe("/control/PersistenceError")
  expect(error.operation).toBe("credential.open")
}

const expectUnauthorized = (error: Record<string, unknown>, message?: string): void => {
  expect(error._tag).toBe("/control/Unauthorized")
  if (message !== undefined) expect(error.message).toBe(message)
}

/**
 * A store whose row moves on between the read a caller derived its update from
 * and the write that commits it — the interleaving a compare-and-set exists to
 * refuse.
 */
const racingStore = (): CredentialStore.Service => {
  const inner = CredentialStore.makeMemory()
  return CredentialStore.make({
    ...inner,
    read: (id) =>
      Effect.tap(inner.read(id), (found) =>
        Option.isNone(found)
          ? Effect.void
          : Effect.orDie(inner.write({ ...found.value, version: found.value.version + 1 })))
  })
}

describe("Credential", () => {
  it("creates, lists, gets, and resolves a stored credential", async () => {
    const resolved = await Effect.runPromise(Effect.gen(function*() {
      const { credentials } = yield* boundary()
      const reference = yield* created(credentials)
      const listed = yield* credentials.list()
      const fetched = yield* credentials.get("exa")
      const secret = yield* credentials.resolve(reference)
      return { reference, listed, fetched, secret: Redacted.value(secret) }
    }))

    expect(resolved.reference).toEqual({ id: "exa", name: "Exa search" })
    expect(resolved.listed).toEqual([{ id: "exa", name: "Exa search" }])
    expect(resolved.fetched).toEqual({ id: "exa", name: "Exa search" })
    expect(resolved.secret).toBe("sk-live-1")
  })

  it.each([
    ["trailing high", "key-\uD800"],
    ["trailing low", "key-\uDC00"],
    ["leading high", "\uD800key"],
    ["leading low", "\uDC00key"]
  ])("refuses a %s lone surrogate on create without storing it", async (_kind, secret) => {
    const { credentials, store } = await Effect.runPromise(boundary())
    const error = await failureOf(created(credentials, secret))

    expect(error._tag).toBe("/control/InvalidInput")
    expect(error.code).toBe("invalid_input")
    expect(error.issue).toBe("Credential secret must be well-formed Unicode")
    expect(Option.isNone(await Effect.runPromise(store.read("exa")))).toBe(true)
  })

  it("round-trips a non-ASCII secret with a surrogate pair", async () => {
    const secret = "clé-雪-🔐"
    const resolved = await Effect.runPromise(Effect.gen(function*() {
      const { credentials } = yield* boundary()
      const reference = yield* created(credentials, secret)
      return Redacted.value(yield* credentials.resolve(reference))
    }))

    expect(resolved).toBe(secret)
  })

  it("persists ciphertext, never plaintext", async () => {
    const stored = await Effect.runPromise(Effect.gen(function*() {
      const { credentials, store } = yield* boundary()
      yield* created(credentials, "sk-live-secret")
      const records = yield* store.list()
      return records[0]!
    }))

    expect(stored.ciphertext).not.toContain("sk-live-secret")
    expect(JSON.stringify(stored)).not.toContain("sk-live-secret")
    expect(stored.version).toBe(1)
    expect(stored.nonce.length).toBeGreaterThan(0)
  })

  it("refuses a sealed blob moved onto another credential record", async () => {
    expectOpenRefused(
      await failureOf(Effect.gen(function*() {
        const { credentials, store } = yield* boundary()
        const approved = yield* credentials.create({
          id: "credential-a",
          name: "Credential A",
          secret: Redacted.make("secret-a")
        })
        yield* credentials.create({
          id: "credential-b",
          name: "Credential B",
          secret: Redacted.make("secret-b")
        })
        const first = Option.getOrThrow(yield* store.read("credential-a"))
        const second = Option.getOrThrow(yield* store.read("credential-b"))
        yield* store.write({
          ...first,
          ciphertext: second.ciphertext,
          nonce: second.nonce,
          version: first.version + 1
        })
        return yield* credentials.resolve(approved)
      }))
    )
  })

  it("keeps the resolved secret out of logs and serialized values", async () => {
    const secret = await Effect.runPromise(Effect.gen(function*() {
      const { credentials } = yield* boundary()
      const reference = yield* created(credentials, "sk-do-not-print")
      return yield* credentials.resolve(reference)
    }))

    expect(String(secret)).not.toContain("sk-do-not-print")
    expect(JSON.stringify({ secret })).not.toContain("sk-do-not-print")
    expect(Redacted.value(secret)).toBe("sk-do-not-print")
  })

  it("rotates the secret and bumps the stored version", async () => {
    const rotated = await Effect.runPromise(Effect.gen(function*() {
      const { credentials, store } = yield* boundary()
      const reference = yield* created(credentials, "old")
      yield* credentials.rotate(reference, Redacted.make("nouveau-é-🔐"))
      const secret = yield* credentials.resolve(reference)
      const record = yield* store.read("exa")
      return { secret: Redacted.value(secret), version: Option.getOrThrow(record).version }
    }))

    expect(rotated).toEqual({ secret: "nouveau-é-🔐", version: 2 })
  })

  it.each([
    ["trailing high", "key-\uD800"],
    ["trailing low", "key-\uDC00"],
    ["leading high", "\uD800key"],
    ["leading low", "\uDC00key"]
  ])("refuses a %s lone surrogate on rotate without changing the record", async (_kind, secret) => {
    const { credentials, store } = await Effect.runPromise(boundary())
    const reference = await Effect.runPromise(created(credentials, "original-🔐"))
    const before = Option.getOrThrow(await Effect.runPromise(store.read("exa")))

    const error = await failureOf(credentials.rotate(reference, Redacted.make(secret)))

    expect(error._tag).toBe("/control/InvalidInput")
    expect(error.code).toBe("invalid_input")
    expect(error.issue).toBe("Credential secret must be well-formed Unicode")
    expect(Option.getOrThrow(await Effect.runPromise(store.read("exa")))).toEqual(before)
    expect(Redacted.value(await Effect.runPromise(credentials.resolve(reference)))).toBe("original-🔐")
  })

  it("refuses a rotation that lost the race", async () => {
    const error = await failureOf(Effect.gen(function*() {
      const cipher = yield* WebCryptoCipher.make({ key: hostKey }).pipe(Effect.orDie)
      const credentials = Credential.make({ store: racingStore(), cipher })
      const reference = yield* created(credentials)
      // A second writer commits between this caller's read and its write, so
      // the rotation must be refused rather than clobber the winner.
      return yield* credentials.rotate(reference, Redacted.make("late"))
    }))

    expect(error._tag).toBe("/control/CredentialConflict")
    expect(error.expectedVersion).toBe(1)
    expect(error.actualVersion).toBe(2)
  })

  it("revokes a credential and refuses to resolve it afterwards", async () => {
    expectUnauthorized(
      await failureOf(Effect.gen(function*() {
        const { credentials } = yield* boundary()
        const reference = yield* created(credentials)
        yield* credentials.revoke(reference)
        return yield* credentials.resolve(reference)
      }))
    )
  })

  it("refuses a forged reference whose name no longer matches the record", async () => {
    expectUnauthorized(
      await failureOf(Effect.gen(function*() {
        const { credentials } = yield* boundary()
        yield* created(credentials)
        return yield* credentials.resolve({ id: "exa", name: "Something else" })
      }))
    )
  })

  it("reports an unknown id as unauthorized rather than disclosing it is missing", async () => {
    expectUnauthorized(
      await failureOf(Effect.gen(function*() {
        const { credentials } = yield* boundary()
        return yield* credentials.get("nope")
      })),
      "Credential nope is not available to this caller"
    )
  })

  it("applies the host authorization policy to every operation", async () => {
    const seen: Array<Credential.Operation> = []
    const error = await failureOf(Effect.gen(function*() {
      const { credentials } = yield* boundary({
        authorize: (operation) => {
          seen.push(operation)
          return operation === "resolve"
            ? Effect.fail(new Unauthorized({ message: "resolve is denied" }))
            : Effect.void
        }
      })
      const reference = yield* created(credentials)
      return yield* credentials.resolve(reference)
    }))

    expect(seen).toEqual(["create", "resolve"])
    expectUnauthorized(error, "resolve is denied")
  })

  it("resolves the reference snapshot authorized before a caller mutation", async () => {
    const resolved = await Effect.runPromise(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { credentials } = yield* boundary({
        authorize: (operation) =>
          operation === "resolve"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void
      })
      const approved = yield* credentials.create({
        id: "credential-a",
        name: "Credential A",
        secret: Redacted.make("secret-a")
      })
      yield* credentials.create({
        id: "credential-b",
        name: "Credential B",
        secret: Redacted.make("secret-b")
      })
      const reference = { ...approved }
      const running = yield* credentials.resolve(reference).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      reference.id = "credential-b"
      reference.name = "Credential B"
      yield* Deferred.succeed(release, undefined)
      return Redacted.value(yield* Fiber.join(running))
    }))

    expect(resolved).toBe("secret-a")
  })

  it("rotates the reference snapshot authorized before a caller mutation", async () => {
    const resolved = await Effect.runPromise(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { credentials } = yield* boundary({
        authorize: (operation) =>
          operation === "rotate"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void
      })
      const approved = yield* credentials.create({
        id: "credential-a",
        name: "Credential A",
        secret: Redacted.make("secret-a")
      })
      const other = yield* credentials.create({
        id: "credential-b",
        name: "Credential B",
        secret: Redacted.make("secret-b")
      })
      const reference = { ...approved }
      const running = yield* credentials.rotate(reference, Redacted.make("rotated-a")).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      reference.id = "credential-b"
      reference.name = "Credential B"
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      return {
        approved: Redacted.value(yield* credentials.resolve(approved)),
        other: Redacted.value(yield* credentials.resolve(other))
      }
    }))

    expect(resolved).toEqual({ approved: "rotated-a", other: "secret-b" })
  })

  it("revokes the reference snapshot authorized before a caller mutation", async () => {
    const records = await Effect.runPromise(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { credentials, store } = yield* boundary({
        authorize: (operation) =>
          operation === "revoke"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void
      })
      const approved = yield* credentials.create({
        id: "credential-a",
        name: "Credential A",
        secret: Redacted.make("secret-a")
      })
      yield* credentials.create({
        id: "credential-b",
        name: "Credential B",
        secret: Redacted.make("secret-b")
      })
      const reference = { ...approved }
      const running = yield* credentials.revoke(reference).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      reference.id = "credential-b"
      reference.name = "Credential B"
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      return {
        approved: yield* store.read("credential-a"),
        other: yield* store.read("credential-b")
      }
    }))

    expect(Option.isNone(records.approved)).toBe(true)
    expect(Option.isSome(records.other)).toBe(true)
  })

  it("creates from the input snapshot authorized before a caller mutation", async () => {
    const stored = await Effect.runPromise(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { credentials, store } = yield* boundary({
        authorize: (operation) =>
          operation === "create"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void
      })
      const input = { id: "approved-id", name: "Approved name", secret: Redacted.make("approved-secret") }
      const running = yield* credentials.create(input).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      input.id = "mutated-id"
      input.name = "Mutated name"
      input.secret = Redacted.make("mutated-secret")
      yield* Deferred.succeed(release, undefined)
      const reference = yield* Fiber.join(running)
      return { reference, record: yield* store.read("approved-id") }
    }))

    expect(stored.reference).toEqual({ id: "approved-id", name: "Approved name" })
    expect(Option.getOrThrow(stored.record)).toMatchObject({ id: "approved-id", name: "Approved name" })
  })

  it("authorizes get against the stored reference without leaking missing ids", async () => {
    const observed = await Effect.runPromise(Effect.gen(function*() {
      const { credentials } = yield* boundary({
        authorize: (operation, reference) => {
          if (operation !== "get" || Option.isNone(reference) || reference.value.id !== "denied-id") {
            return Effect.void
          }
          return Effect.fail(
            new Unauthorized({ message: "Credential denied-id is not available to this caller" })
          )
        }
      })
      yield* credentials.create({ id: "denied-id", name: "Denied", secret: Redacted.make("denied") })
      yield* credentials.create({ id: "allowed-id", name: "Allowed", secret: Redacted.make("allowed") })
      const denied = yield* Effect.flip(credentials.get("denied-id"))
      const allowed = yield* credentials.get("allowed-id")
      const missing = yield* Effect.flip(credentials.get("missing-id"))
      return { denied, allowed, missing }
    }))

    expectUnauthorized(observed.denied as unknown as Record<string, unknown>)
    expect(observed.allowed).toEqual({ id: "allowed-id", name: "Allowed" })
    expectUnauthorized(observed.missing as unknown as Record<string, unknown>)
    expect(observed.denied.message.replace("denied-id", "<id>"))
      .toBe(observed.missing.message.replace("missing-id", "<id>"))
  })

  it("still reports unavailable storage from the noop boundary", async () => {
    expectUnavailable(
      await failureOf(
        Effect.gen(function*() {
          const credentials = yield* Credential.Credential
          return yield* credentials.list()
        }).pipe(Effect.provide(Credential.layerNoop))
      )
    )
  })

  it("fails every noop operation with the same typed unavailable", async () => {
    const noop = Credential.makeNoop()
    const reference = { id: "x", name: "x" }
    for (
      const operation of [
        noop.list(),
        noop.get("x"),
        noop.create({ id: "x", name: "x", secret: Redacted.make("s") }),
        noop.resolve(reference),
        noop.rotate(reference, Redacted.make("s")),
        noop.revoke(reference)
      ]
    ) {
      expectUnavailable(await failureOf(operation))
    }
  })

  it("composes from the ambient store and cipher layers", async () => {
    const secret = await Effect.runPromise(
      Effect.gen(function*() {
        const credentials = yield* Credential.Credential
        const reference = yield* created(credentials, "layered")
        return Redacted.value(yield* credentials.resolve(reference))
      }).pipe(
        Effect.provide(
          Credential.layer().pipe(
            Layer.provide([CredentialStore.layerMemory, WebCryptoCipher.layer({ key: hostKey })])
          )
        ),
        Effect.orDie
      )
    )

    expect(secret).toBe("layered")
  })

  it("carries the host's authorization policy through the layer", async () => {
    // A composition that supplied a policy and got the permissive default
    // would hand every caller every secret, and nothing in the happy path
    // would say so.
    expectUnauthorized(
      await failureOf(
        Effect.gen(function*() {
          const credentials = yield* Credential.Credential
          return yield* created(credentials, "policed")
        }).pipe(
          Effect.provide(
            Credential.layer({
              authorize: () => Effect.fail(new Unauthorized({ message: "the host refuses every credential" }))
            }).pipe(Layer.provide([CredentialStore.layerMemory, WebCryptoCipher.layer({ key: hostKey })]))
          )
        )
      ),
      "the host refuses every credential"
    )
  })

  it("reports unavailable storage when the store cannot be reached", async () => {
    expectUnavailable(
      await failureOf(Effect.gen(function*() {
        const cipher = yield* WebCryptoCipher.make({ key: hostKey }).pipe(Effect.orDie)
        const credentials = Credential.make({ store: CredentialStore.makeNoop(), cipher })
        return yield* credentials.list()
      }))
    )
  })

  it("reports unavailable key material when the cipher cannot be reached", async () => {
    expectUnavailable(
      await failureOf(Effect.gen(function*() {
        const credentials = Credential.make({
          store: CredentialStore.makeMemory(),
          cipher: CredentialCipher.makeNoop()
        })
        return yield* created(credentials)
      })),
      "credential encryption"
    )
  })
})

describe("CredentialStore.layerNoop", () => {
  it("fails every operation with the storage ticket", async () => {
    const noop = CredentialStore.makeNoop()
    const record: CredentialStore.SealedRecord = {
      id: "x",
      name: "x",
      ciphertext: "",
      nonce: "",
      version: 1,
      updatedAtMs: 0
    }
    for (const operation of [noop.list(), noop.read("x"), noop.write(record), noop.remove("x")]) {
      expectUnavailable(await failureOf(operation))
    }
  })

  it("provides the noop store and cipher as layers", async () => {
    expectUnavailable(
      await failureOf(
        Effect.gen(function*() {
          const store = yield* CredentialStore.CredentialStore
          const cipher = yield* CredentialCipher.CredentialCipher
          yield* cipher.seal(Redacted.make("x"), { id: "x", name: "x", version: 1 })
          return yield* store.list()
        }).pipe(Effect.provide([CredentialStore.layerNoop(), CredentialCipher.layerNoop()]))
      ),
      "credential encryption"
    )
  })

  it("opens nothing from the noop cipher", async () => {
    expectUnavailable(
      await failureOf(
        CredentialCipher.makeNoop().open(
          { ciphertext: "", nonce: "" },
          { id: "x", name: "x", version: 1 }
        )
      ),
      "credential encryption"
    )
  })

  it("removes an unknown id from the memory store without failing", async () => {
    await Effect.runPromise(CredentialStore.makeMemory().remove("absent"))
  })

  it("copies records into and out of the memory store", async () => {
    const observed = await Effect.runPromise(Effect.gen(function*() {
      const store = CredentialStore.makeMemory()
      const input = {
        id: "copy",
        name: "Stored name",
        ciphertext: "stored-ciphertext",
        nonce: "stored-nonce",
        version: 1,
        updatedAtMs: 1
      }
      yield* store.write(input)
      input.name = "mutated input"
      input.ciphertext = "mutated input ciphertext"

      const first = Option.getOrThrow(yield* store.read("copy"))
      ;(first as { name: string }).name = "mutated output"
      ;(first as { ciphertext: string }).ciphertext = "mutated output ciphertext"
      return Option.getOrThrow(yield* store.read("copy"))
    }))

    expect(observed).toMatchObject({
      name: "Stored name",
      ciphertext: "stored-ciphertext"
    })
  })
})
