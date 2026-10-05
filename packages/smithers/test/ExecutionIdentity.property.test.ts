/**
 * Fuzzes `Descriptor.executionDigest` over where a flow was discovered.
 *
 * A plan records each check's execution identity on the lane that planned it,
 * and `coding/verify` compares it with the identity on whichever lane runs the
 * check (flows/coding/catalog.ts). Lanes never share a root, so the identity
 * must follow content and the layout within the root, and nothing else.
 *
 * Replay a counterexample with FC_SEED=<seed>; widen with FC_NUM_RUNS.
 */
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Option } from "effect"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 200),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

/** A path segment discovery could join; never `.` or `..`. */
const segment = FastCheck.stringMatching(/^[a-z0-9][a-z0-9._-]{0,11}$/)
const hex = FastCheck.stringMatching(/^[0-9a-f]{64}$/)
/** An absolute root, sometimes named with a trailing separator. */
const root = FastCheck.tuple(FastCheck.array(segment, { minLength: 1, maxLength: 6 }), FastCheck.boolean())
  .map(([parts, trailing]) => `/${parts.join("/")}${trailing ? "/" : ""}`)
/** Where the flow sits under its root. */
const layout = FastCheck.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"))

interface Shape {
  readonly module: boolean
  readonly layout: string
  readonly content: string
  readonly helper: string
  readonly capabilities: ReadonlyArray<string>
}
const shape = FastCheck.record({
  module: FastCheck.boolean(),
  layout,
  content: hex,
  helper: hex,
  capabilities: FastCheck.uniqueArray(FastCheck.stringMatching(/^[a-z]{1,6}:[a-z*]{1,6}$/), { maxLength: 3 })
})

/** The descriptor discovery records for `shape` under `at`, joining paths as discovery does. */
const discovered = (at: string, value: Shape, source = "repository-host") => {
  const directory = `${at.endsWith("/") ? at.slice(0, -1) : at}/${value.layout}`
  const entry = `${directory}/${value.module ? "flow.ts" : "flow.mdx"}`
  return new Descriptor.FlowDescriptor({
    name: "checks/fuzzed",
    description: "Fuzzed flow.",
    body: value.module
      ? new Descriptor.BodyRefModule({
        path: entry,
        contentDigest: value.content,
        imports: [new Descriptor.ModuleImport({ path: "./helper.ts", contentDigest: value.helper })]
      })
      : new Descriptor.BodyRefMarkdown({ path: entry, baseDirectory: directory, contentDigest: value.content }),
    input: value.module
      ? new Descriptor.SchemaRefModule({ path: entry, field: "input" })
      : new Descriptor.SchemaRefMarkdownArgs({}),
    output: value.module
      ? new Descriptor.SchemaRefModule({ path: entry, field: "output" })
      : new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: ["coding/CommandCheck"],
    capabilities: value.capabilities,
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    modelInvocable: true,
    path: entry,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source, root: at })
  })
}

describe("execution identity under any root", () => {
  it("is one identity for the same content and layout under any two roots", () => {
    FastCheck.assert(
      FastCheck.property(root, root, shape, (first, second, value) => {
        const identity = Descriptor.executionDigest(discovered(first, value))
        expect(identity).toMatch(/^[0-9a-f]{64}$/)
        expect(Descriptor.executionDigest(discovered(second, value))).toBe(identity)
      }),
      params
    )
  })

  it("is another identity when any measured byte changes, under any root", () => {
    FastCheck.assert(
      FastCheck.property(root, root, shape, hex, (first, second, value, other) => {
        FastCheck.pre(other !== value.content && other !== value.helper)
        const planned = Descriptor.executionDigest(discovered(first, value))
        expect(Descriptor.executionDigest(discovered(second, { ...value, content: other }))).not.toBe(planned)
        if (value.module) {
          expect(Descriptor.executionDigest(discovered(second, { ...value, helper: other }))).not.toBe(planned)
        }
      }),
      params
    )
  })

  it("is another identity when the layout within the root, the authority or the source changes", () => {
    FastCheck.assert(
      FastCheck.property(root, root, shape, layout, (first, second, value, moved) => {
        FastCheck.pre(moved !== value.layout)
        const planned = Descriptor.executionDigest(discovered(first, value))
        expect(Descriptor.executionDigest(discovered(second, { ...value, layout: moved }))).not.toBe(planned)
        expect(Descriptor.executionDigest(discovered(second, { ...value, capabilities: [...value.capabilities, "*"] })))
          .not.toBe(planned)
        expect(Descriptor.executionDigest(discovered(second, value, "project"))).not.toBe(planned)
      }),
      params
    )
  })

  it("never relates a path outside the root, however its name begins", () => {
    FastCheck.assert(
      FastCheck.property(root, segment, shape, (at, suffix, value) => {
        const inside = discovered(at, value)
        const base = at.endsWith("/") ? at.slice(0, -1) : at
        // A sibling whose name extends the root's last segment shares its prefix but not its directory.
        const outside = new Descriptor.FlowDescriptor({
          ...inside,
          path: `${base}${suffix}${inside.path.slice(base.length)}`
        })
        expect(Descriptor.executionDigest(outside)).not.toBe(Descriptor.executionDigest(inside))
      }),
      params
    )
  })
})
