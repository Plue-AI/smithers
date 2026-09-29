/**
 * The refusals this package raises are Effect tagged errors: a caller routes
 * each by `_tag` and reads the typed fields, and the message stays the
 * sentence an operator already reads.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { parseWorkflow, WorkflowParseError } from "../src/GithubWorkflow.ts"
import * as Outward from "../src/Outward.ts"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"

const thrown = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error("expected a throw")
}

const route = (error: unknown): string =>
  Effect.runSync(
    Effect.fail(error as Outward.Refused | WorkflowParseError | SecretProxy.SecretUnavailable).pipe(
      Effect.catchTags({
        "smithers-build/Refused": (refusal) => Effect.succeed(`refused ${refusal.code}`),
        "smithers-build/WorkflowParseError": (failure) => Effect.succeed(`workflow ${failure.reason}`),
        "smithers-build/SecretUnavailable": (failure) => Effect.succeed(`unset ${failure.env}`)
      })
    )
  )

describe("Outward.Refused", () => {
  it("routes by tag and keeps the rule: code: detail sentence", () => {
    const refusal = Outward.refuse(
      { rule: "Npm.Publish", required: ["NPM_TOKEN"], declared: [], approval: undefined },
      { approvalGranted: true }
    )
    expect(route(refusal)).toBe("refused missing_secret")
    expect(refusal?.message).toBe(
      "Npm.Publish: missing_secret: declares no S.HttpSecret(S.Secret(\"NPM_TOKEN\"), [...]) in secrets"
    )
  })
})

describe("WorkflowParseError", () => {
  const job = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
  const cases: ReadonlyArray<readonly [string, string, WorkflowParseError["reason"], number]> = [
    ["too large", "#".repeat(2_000_000), "too_large", 1],
    ["invalid YAML", "on: push\nname: \"open\n", "invalid_yaml", 3],
    ["an alias", `on: &a push\nx: *a\n${job}`, "unsupported", 2],
    ["a duplicate top-level key", `on: push\non: pull_request\n${job}`, "duplicate", 2],
    ["a missing trigger", job, "missing", 1],
    ["a sequence at the top level", "- a\n", "invalid_shape", 1]
  ]
  for (const [label, source, reason, line] of cases) {
    it(`carries reason ${reason} for ${label}`, () => {
      const failure = thrown(() => parseWorkflow(source))
      expect(failure).toBeInstanceOf(WorkflowParseError)
      expect(failure).toMatchObject({ reason, line })
      expect(route(failure)).toBe(`workflow ${reason}`)
      expect((failure as WorkflowParseError).message).toMatch(new RegExp(`^line ${line}: `))
    })
  }
})

describe("SecretProxy refusals", () => {
  const token = Secret.HttpSecret(Secret.Secret("TAGGED_TEST_TOKEN"), ["https://api.example.test"])

  it("routes an unset secret by tag and names only the variable", () => {
    const vault = SecretProxy.makeVault({ read: () => undefined })
    const placeholder = vault.mint(token)
    const failure = thrown(() => vault.request("https://api.example.test").substitute(placeholder))
    expect(route(failure)).toBe("unset TAGGED_TEST_TOKEN")
    expect((failure as Error).message).toBe("the declared secret TAGGED_TEST_TOKEN is not set on this host")
  })

  it("tags an invalid value and a denied audience with their own variants", () => {
    const invalid = SecretProxy.makeVault({ read: () => "line\nbreak" })
    const invalidFailure = thrown(() => invalid.request("https://api.example.test").substitute(invalid.mint(token)))
    expect(invalidFailure).toMatchObject({ _tag: "smithers-build/SecretValueInvalid", env: "TAGGED_TEST_TOKEN" })

    const denied = SecretProxy.makeVault({ read: () => "value" })
    const deniedFailure = thrown(() => denied.request("https://other.example.test").substitute(denied.mint(token)))
    expect(deniedFailure).toMatchObject({
      _tag: "smithers-build/SecretAudienceDenied",
      env: "TAGGED_TEST_TOKEN",
      audience: "https://other.example.test"
    })
    expect((deniedFailure as Error).message).not.toContain("value")
  })
})
