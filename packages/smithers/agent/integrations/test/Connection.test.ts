import * as Credential from "@smthrs/control/Credential"
import * as SqlCredentialStore from "@smthrs/control/SqlCredentialStore"
import * as WebCryptoCipher from "@smthrs/control/WebCryptoCipher"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Redacted } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import {
  ANY_CONTAINER,
  type Authorize,
  type Connection,
  containersAllowed,
  decode,
  personalPolicy,
  resolveSecret
} from "../src/core/Connection.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"

const KEY = Redacted.make(Buffer.from(new Uint8Array(32).fill(7)).toString("base64"))
const SECRET = "xoxb-example-secret"

const shared: Connection = {
  id: "team-chat",
  provider: "example",
  label: "Team chat",
  credential: { id: "team-chat-token", name: "team-chat" },
  scopes: ["channels:history"],
  personal: false,
  containers: ["c-general"]
}

const personal: Connection = {
  ...shared,
  id: "owner-mail",
  credential: { id: "owner-mail-token", name: "owner-mail" },
  personal: true
}

/** A real credential broker: encrypted rows in SQLite behind the control Credential service. */
const withBroker = <A, E>(
  body: (credentials: Credential.Credential) => Effect.Effect<A, E, SqlClient.SqlClient>
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* SqlCredentialStore.make
      const cipher = yield* WebCryptoCipher.make({ key: KEY })
      const credentials = Credential.make({ store, cipher })
      yield* credentials.create({ id: "team-chat-token", name: "team-chat", secret: Redacted.make(SECRET) })
      yield* credentials.create({
        id: "owner-mail-token",
        name: "owner-mail",
        secret: Redacted.make("personal-secret")
      })
      return yield* body(credentials)
    }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
  )

const policy = personalPolicy({ personalPrincipals: ["assistant"] })

describe("containersAllowed", () => {
  it("allows only listed containers, or every container under the wildcard", () => {
    expect(containersAllowed(shared, "c-general")).toBe(true)
    expect(containersAllowed(shared, "c-random")).toBe(false)
    expect(containersAllowed({ containers: [] }, "c-general")).toBe(false)
    expect(containersAllowed({ containers: [ANY_CONTAINER] }, "c-random")).toBe(true)
  })

  it("decodes a journal-safe connection", async () => {
    expect(await Effect.runPromise(decode(shared))).toEqual(shared)
  })
})

describe("personalPolicy", () => {
  it("lets only the named principals use a personal connection, whatever the shared rule says", async () => {
    const decisions = await Effect.runPromise(Effect.all([
      policy("assistant", personal),
      policy("builder", personal),
      policy("builder", shared),
      personalPolicy({ personalPrincipals: [], shared: () => Effect.succeed(true) })("assistant", personal),
      personalPolicy({
        personalPrincipals: ["assistant"],
        shared: (principal) => Effect.succeed(principal === "lead")
      })(
        "builder",
        shared
      )
    ]))
    expect(decisions).toEqual([true, false, true, false, false])
  })
})

describe("resolveSecret", () => {
  it("resolves the secret for an authorized principal, still redacted", async () => {
    const secret = await withBroker((credentials) =>
      resolveSecret({ credentials, connection: shared, principal: "builder", authorize: policy })
    )
    expect(Redacted.isRedacted(secret)).toBe(true)
    expect(Redacted.value(secret)).toBe(SECRET)
  })

  it("resolves a personal connection only for the personal principal", async () => {
    const [allowed, refused] = await withBroker((credentials) =>
      Effect.all([
        resolveSecret({ credentials, connection: personal, principal: "assistant", authorize: policy }),
        Effect.flip(resolveSecret({ credentials, connection: personal, principal: "lead", authorize: policy }))
      ])
    )
    expect(Redacted.value(allowed)).toBe("personal-secret")
    expect(refused.reason).toBe("permission-denied")
    expect(refused.details).toMatchObject({ connectionId: "owner-mail", principal: "lead" })
    expect(JSON.stringify(refused.details)).not.toContain("personal-secret")
  })

  it("never reaches the broker when the policy refuses", async () => {
    let brokerCalls = 0
    const failure = await withBroker((credentials) =>
      Effect.flip(resolveSecret({
        credentials: {
          ...credentials,
          resolve: (reference) =>
            Effect.suspend(() => {
              brokerCalls += 1
              return credentials.resolve(reference)
            })
        },
        connection: shared,
        principal: "builder",
        authorize: () => Effect.succeed(false)
      }))
    )
    expect(failure.reason).toBe("permission-denied")
    expect(brokerCalls).toBe(0)
  })

  it("passes a policy failure through unchanged", async () => {
    const refusal = new IntegrationError("invalid-config", "policy unavailable")
    const failing: Authorize = () => Effect.fail(refusal)
    const failure = await withBroker((credentials) =>
      Effect.flip(resolveSecret({ credentials, connection: shared, principal: "builder", authorize: failing }))
    )
    expect(failure).toBe(refusal)
  })

  it("maps a forged or unknown reference to permission-denied", async () => {
    const failures = await withBroker((credentials) =>
      Effect.all([
        Effect.flip(resolveSecret({
          credentials,
          connection: { ...shared, credential: { id: "team-chat-token", name: "forged-name" } },
          principal: "builder",
          authorize: policy
        })),
        Effect.flip(resolveSecret({
          credentials,
          connection: { ...shared, credential: { id: "missing", name: "missing" } },
          principal: "builder",
          authorize: policy
        }))
      ])
    )
    expect(failures.map((failure) => [failure.reason, failure.details?.["credentialFailure"]])).toEqual([
      ["permission-denied", "unauthorized"],
      ["permission-denied", "unauthorized"]
    ])
  })

  it("maps a sealed value the broker cannot open, or no storage, to credentials-missing", async () => {
    const [tampered, unavailable] = await withBroker((credentials) =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE control_credentials SET ciphertext = ${Buffer.from("tampered").toString("base64")}
          WHERE id = 'team-chat-token'`
        return [
          yield* Effect.flip(
            resolveSecret({ credentials, connection: shared, principal: "builder", authorize: policy })
          ),
          yield* Effect.flip(resolveSecret({
            credentials: Credential.makeNoop(),
            connection: shared,
            principal: "builder",
            authorize: policy
          }))
        ] as const
      })
    )
    expect([tampered.reason, tampered.details?.["credentialFailure"]]).toEqual([
      "credentials-missing",
      "persistence_failed"
    ])
    expect([unavailable.reason, unavailable.details?.["credentialFailure"]]).toEqual([
      "credentials-missing",
      "unavailable"
    ])
    expect(JSON.stringify(tampered.details)).not.toContain(SECRET)
  })
})
