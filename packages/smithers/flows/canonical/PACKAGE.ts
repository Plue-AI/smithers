import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/canonical"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/canonical" })

/** Exercises the emitted ESM and CommonJS exports after building the library. */
const distSmoke = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("test/dist-smoke.mjs")]),
  srcs: [],
  deps: [lib],
  cwd: "packages/smithers/flows/canonical"
})

/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every source file. Checks name what digest
 * determinism and bounded JSON admission must guarantee to their callers.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/canonical",
  include: ["src/**"],
  checks: [
    {
      id: "canonical-digest-injectivity",
      title: "Distinct values never canonicalize to the same bytes",
      threat:
        "A flow author or run input supplies a value whose canonical form collides with another, so a cache key, step key, or plan digest reuses or approves someone else's work.",
      lookFor: [
        "A non-plain object (Map, Set, typed array, class instance, Proxy of one) that serializes as {} or an index-keyed object instead of throwing canonical_unsupported_value.",
        "Object keys sorted by anything other than UTF-16 code units, or a key emitted without JSON.stringify escaping.",
        "The loneSurrogates \"escape\" mode reachable from a digest path that expects strict RFC 8785 output.",
        "A toJSON result or boxed primitive whose bytes depend on overridable toString/valueOf rather than the internal slot."
      ],
      paths: ["src/internal/canonicalize.ts", "src/Canonical.ts", "src/Serializer.ts"]
    },
    {
      id: "canonical-resource-bounds",
      title: "Canonicalization and admission terminate within stated limits on hostile input",
      threat:
        "A client whose request body or run output is digested or persisted submits a deep, wide, or shared-reference value that exhausts memory or CPU in that host.",
      lookFor: [
        "Recursion on the JS call stack instead of the explicit task or generator stack.",
        "An allocation sized by a caller-controlled length (array length, Reflect.ownKeys result, string length) before the member, node, or byte limit is checked.",
        "A byte or member counter that can overflow Number.MAX_SAFE_INTEGER or skip the maxTotalMembers check.",
        "canonicalize tracking only ancestors, so a non-cyclic shared-reference DAG (x = [y, y], y = [z, z], ...) expands exponentially with no node or byte cap; confirm callers only pass BoundedJson-admitted or JSON.parse output.",
        "admit's byte count diverging from canonicalize's output (number formatting, key or string escapes, array commas), so a value under maxBytes persists larger than the limit."
      ],
      paths: ["src/internal/canonicalize.ts", "src/BoundedJson.ts"]
    },
    {
      id: "bounded-json-no-user-code",
      title: "admit and admitStrict never execute caller-owned getters, toJSON, or accessors",
      threat:
        "An untrusted value runs code during admission, mutating itself between check and copy so the persisted tree differs from what was validated.",
      lookFor: [
        "A property read with value[key] or spread instead of Object.getOwnPropertyDescriptor(...).value.",
        "A Proxy trap exception or a TOCTOU second read that escapes the inspection refusal.",
        "An admitted container that is not a fresh, frozen copy, so later mutation of the input changes the stored value."
      ],
      paths: ["src/BoundedJson.ts"]
    },
    {
      id: "bounded-json-prototype-keys",
      title: "Admitted records cannot pollute or shadow prototypes",
      threat:
        "A request body with __proto__, constructor, or prototype keys changes object behavior in a consumer that reads the admitted record.",
      lookFor: [
        "Output records built with {} and ordinary assignment instead of Object.create(null) or defineProperty.",
        "The strict ordinaryRecords option admitting a reserved key on any code path, including boundedText.",
        "Symbol keys or non-enumerable members copied into the output."
      ],
      paths: ["src/BoundedJson.ts"]
    },
    {
      id: "canonical-diagnostic-leak",
      title: "Error messages and paths never echo stored values or unbounded caller text",
      threat:
        "A secret inside a rejected value, or a crafted key, reaches logs or API error bodies through a complaint, CanonicalError message, or schema path.",
      lookFor: [
        "A complaint or CanonicalError detail that interpolates the rejected value rather than its path and rule.",
        "describe() output not truncated, or a thrown value's toString invoked outside the try.",
        "firstPath or admitStrict rendering a raw key without escaping, so a key containing '.' or ']' forges a different path.",
        "Canonical's decode failure building SchemaIssue.InvalidValue with the whole rejected input as its actual value, where a caller's issue formatter or log serializer prints it."
      ],
      paths: [
        "src/internal/describe.ts",
        "src/IssuePath.ts",
        "src/BoundedJson.ts",
        "src/internal/canonicalize.ts",
        "src/Canonical.ts"
      ]
    },
    {
      id: "readonly-map-immutability",
      title: "ReadonlyMap.make exposes no path to mutate its private map",
      threat: "A consumer of a shared registry mutates entries other callers trust as immutable.",
      lookFor: [
        "A facade method or iterator that returns the backing Map itself.",
        "A forEach callback receiving the backing map instead of the frozen facade."
      ],
      paths: ["src/ReadonlyMap.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, distSmoke, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
