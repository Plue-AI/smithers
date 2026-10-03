/**
 * The hermetic pre-check, read directly rather than through a spawner.
 *
 * The scan has its own security history: three independent bypasses, each
 * sufficient on its own to defeat it, are closed in it. Exercising it through
 * `Bash.run` proves only that nothing spawned; these cases state what the scan
 * itself classifies, which is the property the bypasses broke.
 */
import { Effect, Path } from "effect"
import { describe, expect, it } from "vitest"
import { commandReferences, outsideEnvelope } from "../src/internal/EnvelopePrecheck.ts"

const path = Effect.runSync(Effect.provide(
  Effect.gen(function*() {
    return yield* Path.Path
  }),
  Path.layer
))

interface Refusal {
  readonly code: string
  readonly path: string
}

interface Case {
  readonly name: string
  readonly text: string
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly refusal: Refusal | undefined
}

const refused: ReadonlyArray<Case> = [
  // A newline ends a command, so line two is classified on its own rather than
  // under line one's `echo`.
  {
    name: "an rm on the second script line",
    text: "echo hi\nrm -rf /work/target\n",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  },
  {
    name: "an mv destination on the second script line",
    text: "echo hi\nmv /work/a /work/b\n",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/b" }
  },
  {
    name: "a tee destination on the second script line",
    text: "echo hi\ntee /work/out\n",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/out" }
  },
  // A prefix wrapper does not lend its own read classification to the command
  // it wraps.
  {
    name: "an rm behind an env prefix",
    text: "env FOO=bar rm /work/target",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  },
  {
    name: "an rm behind a sudo prefix",
    text: "sudo rm /work/target",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  },
  {
    name: "an rm behind a quoted assignment whose value holds whitespace",
    text: `FOO="a b" rm /work/target`,
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  },
  // Every token and every declared entry is resolved before comparison.
  {
    name: "a dot-dot escape from a declared read",
    text: "cat /work/../outside/secret.txt",
    reads: ["/work"],
    writes: [],
    refusal: { code: "outside_declared_reads", path: "/outside/secret.txt" }
  },
  {
    name: "an ordinary path disguised as process plumbing",
    text: "cat /dev/../etc/passwd",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_reads", path: "/etc/passwd" }
  },
  {
    name: "a redirection into an undeclared file",
    text: "echo hi > /work/out",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/out" }
  }
]

const accepted: ReadonlyArray<Case> = [
  {
    name: "a declared read",
    text: "cat /work/input",
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "a declared write behind a wrapper",
    text: "env FOO=bar rm /work/target",
    reads: ["/work/**"],
    writes: ["/work/target"],
    refusal: undefined
  },
  {
    name: "process plumbing",
    text: "cat /work/input 2>/dev/null",
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "a quoted path holding whitespace",
    text: `cat "/work/a b.txt"`,
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "a path named only inside a comment",
    text: "cat /work/input # /outside/secret.txt",
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  }
]

describe("outsideEnvelope", () => {
  for (const { name, reads, refusal, text, writes } of [...refused, ...accepted]) {
    it(`${refusal === undefined ? "admits" : "refuses"} ${name}`, () => {
      const violation = outsideEnvelope({ cwd: undefined, reads, writes }, text, path)
      if (refusal === undefined) {
        expect(violation).toBeUndefined()
        return
      }
      expect(violation).toMatchObject(refusal)
    })
  }

  it("refuses a working directory outside the declared reads", () => {
    const violation = outsideEnvelope({ cwd: "/outside", reads: ["/work/**"], writes: [] }, "echo hi", path)
    expect(violation).toMatchObject({ code: "outside_declared_reads", path: "/outside" })
  })
})

describe("commandReferences", () => {
  it.each(
    [
      ["", []],
      ["# /outside/ignored", []],
      ["env NAME=value --verbose", []],
      ["sudo -u builder cat ./input", [{ access: "read", value: "./input" }]],
      ["sudo -u builder touch ../output", [{ access: "write", value: "../output" }]],
      ["cat . .. ./a ../b nested/file C:\\work\\input", [
        { access: "read", value: "." },
        { access: "read", value: ".." },
        { access: "read", value: "./a" },
        { access: "read", value: "../b" },
        { access: "read", value: "nested/file" },
        { access: "read", value: "C:\\work\\input" }
      ]],
      ["cat '' '/work/a b' >> /work/output", [
        { access: "read", value: "/work/a b" },
        { access: "write", value: "/work/output" }
      ]],
      ["cp", []],
      ["cat < /work/input", [{ access: "read", value: "/work/input" }]],
      ["cat /work/a && touch /work/b || cat /work/c; rm /work/d | tee /work/e & cat /work/f", [
        { access: "read", value: "/work/a" },
        { access: "write", value: "/work/b" },
        { access: "read", value: "/work/c" },
        { access: "write", value: "/work/d" },
        { access: "write", value: "/work/e" },
        { access: "read", value: "/work/f" }
      ]]
    ] as const
  )("classifies boundary command %s", (command, expected) => {
    expect(commandReferences(path, command)).toEqual(expected)
  })

  it.each([
    {
      name: "classifies a delete on the second line as a write",
      command: "echo hi\nrm -rf /work/target",
      expected: [{ access: "write", value: "/work/target" }]
    },
    {
      name: "classifies a copy's last path as its destination",
      command: "cp /work/a /work/b",
      expected: [{ access: "read", value: "/work/a" }, { access: "write", value: "/work/b" }]
    },
    {
      name: "classifies a redirection target as a write",
      command: "cat /work/in > /work/out",
      expected: [{ access: "read", value: "/work/in" }, { access: "write", value: "/work/out" }]
    },
    {
      name: "keeps a quoted path holding whitespace as one reference",
      command: `cat "/work/a b.txt"`,
      expected: [{ access: "read", value: "/work/a b.txt" }]
    },
    {
      name: "drops a path named only inside a comment",
      command: "cat /work/in # /outside/secret.txt",
      expected: [{ access: "read", value: "/work/in" }]
    },
    {
      name: "reads no path from a command that names none",
      command: "echo hi",
      expected: []
    }
  ])("$name", ({ command, expected }) => {
    expect(commandReferences(path, command)).toEqual(expected)
  })
})

it("resolves relative declarations against a declared nondefault working directory", () => {
  expect(outsideEnvelope({ cwd: "/work", reads: ["."], writes: ["./out"] }, "cat ./in >> ./out", path))
    .toBeUndefined()
  expect(outsideEnvelope({ cwd: ".", reads: [], writes: [] }, "echo ready", path)).toBeUndefined()
})
