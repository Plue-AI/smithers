/**
 * Every spelling a failure message gives a credential once reached the log
 * line and the remote caller's `FlowHandlerDefect` past `renderDiagnostic`.
 * Each case builds its message the way the leak arrived, most of them through
 * `util.inspect`, and pins that the secret's bytes are gone and a redaction
 * marker stands in their place. All secrets are synthetic.
 */
import { describe, expect, it } from "@effect/vitest"
import * as FastCheck from "fast-check"
import { inspect } from "node:util"
import { renderDiagnostic } from "../src/internal/Diagnostic.ts"

const secret = "ZqSynthetic7Secret4Value9"
const hex = (text: string) => [...Buffer.from(text)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")

/** Twelve 64-character body lines, the shape of a real key, each carrying the secret. */
const pem = [
  "-----BEGIN PRIVATE KEY-----",
  ...Array.from({ length: 12 }, (_, line) => `${secret}${line}`.padEnd(64, "A")),
  "-----END PRIVATE KEY-----"
].join("\n")

const expectRedacted = (rendered: string, ...leaks: ReadonlyArray<string>) => {
  for (const leak of [secret, ...leaks]) expect(rendered).not.toContain(leak)
  expect(rendered).toContain("[REDACTED]")
}

describe("renderDiagnostic redacts each inspected leak form", () => {
  it("a PEM body util.inspect split into a `'…' +` concatenation", () => {
    const message = inspect({ privateKey: pem })
    expect(message).toContain("' +\n")
    expectRedacted(renderDiagnostic(new Error(message)))
  })

  it("a PEM body under a name no rule knows", () => {
    expectRedacted(renderDiagnostic(new Error(inspect({ blob: pem }))))
  })

  it("a PEM body the 512-character bound would cut before its footer", () => {
    const message = `${"x".repeat(400)} ${pem}`
    expectRedacted(renderDiagnostic(new Error(message)))
  })

  it("the bytes of a <Buffer ..>", () => {
    const message = inspect({ token: Buffer.from(secret) })
    expect(message).toContain("<Buffer")
    expectRedacted(renderDiagnostic(new Error(message)), hex(secret))
  })

  it("a value after a <ref *1> marker", () => {
    const holder: Record<string, unknown> = { value: secret }
    holder["self"] = holder
    const message = inspect({ apiKey: holder })
    expect(message).toContain("<ref *1>")
    expectRedacted(renderDiagnostic(new Error(message)))
  })

  it("a backtick-quoted value", () => {
    const message = inspect({ password: `it's "a ${secret} b"` })
    expect(message).toContain("`")
    expectRedacted(renderDiagnostic(new Error(message)))
  })

  it("a spaced api-key name", () => {
    expectRedacted(renderDiagnostic(new Error(`request refused: API key = ${secret}`)))
  })

  it("a bare key=", () => {
    expectRedacted(renderDiagnostic(new Error(`lookup failed for key=${secret}`)))
  })

  it("a multi-word value", () => {
    expectRedacted(renderDiagnostic(new Error(`password=correct horse ${secret}`)))
  })

  it("a separated CLI -p value", () => {
    expectRedacted(renderDiagnostic(new Error(`command failed: sshpass -p ${secret} ssh host`)))
  })

  it("an attached CLI -p value", () => {
    expectRedacted(renderDiagnostic(new Error(`command failed: mysql -u root -p${secret} app`)))
  })

  it("a CLI -p value held as two argv elements", () => {
    expectRedacted(renderDiagnostic({ message: "spawn failed", "~effect/Effect/args": ["mysql", "-p", secret] }))
  })

  it("a long credential flag held as two argv elements", () => {
    expectRedacted(renderDiagnostic({ "~effect/Effect/args": ["deploy", "--api-token", secret] }))
  })

  it("keeps the context a -p flag does not hide", () => {
    for (const message of ["mkdir -p /tmp/work failed", "mysql -p --database app failed", "find . -print failed"]) {
      expect(renderDiagnostic(new Error(message))).toBe(JSON.stringify({ message }))
    }
  })
})

const credentialNames = ["password", "apiKey", "api_key", "token", "secret", "privateKey", "API key", "key"]
const flags = ["-p", "--password", "--api-key", "--token", "--secret"]

/** One random placement of the secret, and the bytes that must not survive it. */
const placement: FastCheck.Arbitrary<{ readonly value: unknown; readonly leaks: ReadonlyArray<string> }> = FastCheck
  .oneof(
    // A nested object or array whose credential member util.inspect renders.
    FastCheck.tuple(
      FastCheck.constantFrom(...credentialNames),
      FastCheck.constantFrom("string", "multiline", "buffer", "array", "object"),
      FastCheck.nat(3)
    ).map(([name, shape, depth]) => {
      const leaf = shape === "string"
        ? `a ${secret} b`
        : shape === "multiline"
        ? `${secret}\n`.repeat(6)
        : shape === "buffer"
        ? Buffer.from(secret)
        : shape === "array"
        ? [secret, secret]
        : { inner: { value: secret } }
      let value: unknown = { [name]: leaf }
      for (let level = 0; level < depth; level++) value = level % 2 === 0 ? { nested: value } : [value]
      return { value: new Error(inspect(value, { depth: 8 })), leaks: shape === "buffer" ? [hex(secret)] : [] }
    }),
    // A PEM body inside a multi-line string, alone or inspected.
    FastCheck.tuple(FastCheck.boolean(), FastCheck.string({ maxLength: 40 })).map(([inspected, prefix]) => ({
      value: new Error(inspected ? inspect({ prefix, data: pem }) : `${prefix}\n${pem}`),
      leaks: []
    })),
    // A command line, as argv or joined into the message.
    FastCheck.tuple(
      FastCheck.constantFrom(...flags),
      FastCheck.array(FastCheck.constantFrom("run", "-v", "--quiet", "host", "app"), { maxLength: 4 }),
      FastCheck.constantFrom("argv", "joined", "json")
    ).map(([flag, rest, form]) => {
      const argv = ["tool", ...rest, flag, secret, ...rest]
      return {
        value: form === "argv"
          ? { message: "spawn failed", "~effect/Effect/args": argv }
          : new Error(form === "joined" ? `spawn failed: ${argv.join(" ")}` : JSON.stringify(argv)),
        leaks: []
      }
    })
  )

describe("renderDiagnostic under random secret placements", () => {
  it("never renders the secret and always marks where it was", () => {
    FastCheck.assert(
      FastCheck.property(placement, ({ leaks, value }) => {
        expectRedacted(renderDiagnostic(value), ...leaks)
      }),
      {
        numRuns: Number(process.env.FC_NUM_RUNS ?? 300),
        ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) })
      }
    )
  })
})
