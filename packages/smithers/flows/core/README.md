# @smthrs/core

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://core.smithers.sh

Metadata and compatibility adapters over `@smthrs/flow`. Author flows with its canonical `Flow.make(tag, { payload, success, body })`. Beside that it publishes the metadata projections the registry and execution layers read: annotations, effects, placement, key material, digests, and Markdown lowering. The node model is `@smthrs/plan`'s and the graph builder is `@smthrs/flow`'s; `Node` and `Graph` here are the names this package's consumers reach them through.

JavaScript and TypeScript declarations and all planning callbacks must be trusted. `Graph.build` executes flow bodies, `Node.andThen` builders, `Node.catch` recovery callbacks, and an optional `resolveLayers` callback in the caller process with ambient process authority. Purity is a caller obligation, not an enforced boundary. Placement, capability, and effect metadata does not sandbox planning, including sandbox placement, empty capability grants, and sealed effects.

For agent-generated declarations, use a constrained data-only ingestion boundary that trusted code validates and translates into nodes, or load and plan untrusted code in an externally isolated environment with restricted permissions and resources. See [Plan time](https://core.smithers.sh/concepts/plan-time/#planning-requires-trusted-declarations).

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

The full API reference lives at [core.smithers.sh/reference/api](https://core.smithers.sh/reference/api/).

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/core/<Module>`.

| Module        | Public exports                                                                                                                                                                                                                                                                                                                                                                                     | Description                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Annotations` | `empty`, `add`, `merge`, `getOption`, `Placement`, `Effects`, `Priority`                                                                                                                                                                                                                                                                                                                           | Builds and reads typed lexical annotations carried by flows and plan nodes.        |
| `Digest`      | `provideSync`, `digest`, `canonical`                                                                                                                                                                                                                                                                                                                                                               | Synchronous SHA-256 and canonical JSON for pure identity constructors.             |
| `Effects`     | `Declaration`, `NarrowResult`, `make`, `covers`, `narrow`, `overlaps`, `sealed`                                                                                                                                                                                                                                                                                                     | Normalizes effect declarations and checks path coverage, narrowing, and conflicts. |
| `Flow`        | `TypeId`, `Flow`, `Any`, `Payload`, `Reference`, `Seat`, `Input`, `Output`, `Error`, `isFlow`, `within`, `annotate`, `withFlows`                                                                                                                                                                                                                                            | Retains Markdown signatures and their metadata combinators.          |
| `Graph`       | `build`, `nodes`, `edges`, `drafts`, `diagnostics`, `evaluatedFrom`, `maximumGraphDepth`, `Graph`, `GraphNode`, `Edge`, `EdgeReason`, `LayerRequest`, `BuildOptions`                                                                                                                                                                                                                               | `@smthrs/flow`'s plan-time graph builder, re-exported.                             |
| `KeyMaterial` | `InputRef`, `KeyMaterial`, `Entry`                                                                                                                                                                                                                                                                                                                                                                 | Defines the stable key projection emitted from a built graph. Types only.          |
| `Markdown`    | `splitFrontmatter`, `MarkdownFrontmatter`, `SkillFrontmatter`, `SkillDocument`, `MarkdownErrorCode`, `MarkdownError`, `lowerMarkdown`, `isSkillName`, `validateSkillFrontmatter`, `parseSkill`, `lowerSkill`                                                                                                                                                                                       | Parses and lowers Markdown and Agent Skills declarations to signatures.            |
| `Node`        | `TypeId`, `Ast`, `Node`, `Any`, `Success`, `Error`, `CallMode`, `isNode`, `succeed`, `fail`, `all`, `race`, `any`, `quorum`, `map`, `andThen`, `branch`, `catch`, `capture`, `priority`, `declaredPriority`, `bindPlanned`, `plannedReference`, `branchSubject`, `catchSubject`, `catchFilter`, `continuation`, `mapper`, `predicate`, `declaration`, `flowCall`, `actionCall`, `functionIdentity` | `@smthrs/plan`'s inert, pipeable plan AST, re-exported.                            |
| `Placement`   | `Options`, `Placement`, `local`, `client`, `sandbox`, `remote`                                                                                                                                                                                                                                                                                                                                     | Creates serializable host-placement declarations.                                  |

```ts
import { Graph, Node, Placement } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"

const greeting = Flow.make("greeting", {
  payload: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  body: ({ name }) => Node.succeed(`Hello, ${name}`)
}).annotate(Flow.Placement, Placement.sandbox())

const graph = Graph.build(greeting, { name: "world" })
```

`@smthrs/core/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## Canonical flows and actions

A flow has a required tag, a struct payload schema, a success schema, and a body returning a node. Work a host implements is an explicit action:

```ts
import { Action } from "@smthrs/flow"
import { Effect, Schema } from "effect"

const read = Action.make("std/read", {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
  capabilities: ["fs"],
  tier: "irreversible"
})

const layer = read.toLayer(({ path }) => Effect.succeed(path))
```

Struct schemas, including `Schema.Class`, can be the canonical payload schema. Calls accept their constructor input.

## Identity and caching

`@smthrs/plan` compiles a built graph's digest-free key material into step keys, so two declarations with equal key material are the same step.

An unannotated mapper, continuation, or flow body receives a process-local `sha256-source-ephemeral/v4` identity, because JavaScript cannot inspect closure state: two processes give the same function two different digests. Only `Node.capture` produces the cross-process-stable `sha256-source-captures/v5` identity, by folding the canonicalized inert values a function closes over into its digest. A step whose result must survive a restart has to declare its captures.

```ts
const scaled = Node.capture({ factor: 3 }, (value: number) => value * 3)
```

An authored captured body retains its identity through core lowering and
decorators, including the adapter for a non-struct input. An uncaptured body
remains process-local. Generated action-only wrappers also remain process-local:
use `Interpreter.layer`, or explicitly select `callbackIdentity: "process-local"`
when registering them. A stable composition uses authored captured bodies or
native declarations with explicit capture contracts.

Capture data must be finite, inert, plain data. Accessors, cycles, non-finite numbers, symbols, functions, and non-plain prototypes are rejected rather than hashed incompletely, and accepted capture data is copied and deeply frozen. A function expression reads the copy through its `this` receiver; the returned function keeps its ordinary arguments. Caller objects remain unchanged. Built-in brands and Proxies are refused, and object capture requires `structuredClone`. Captures are compared by structural value: two references to one shared object digest identically to two structurally equal copies, so aliasing is not identity.

## Failure behavior

Construction failures throw; declaration failures are recorded.

| Surface                                                                           | Failure                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node.capture` on a non-function operation or non-inert capture data              | throws `TypeError`; a capture-data failure names the offending path in its `Node.capture:`-prefixed message                                                                                                                                                                                                                       |
| `Markdown.parseSkill`, `Markdown.lowerSkill`, `Markdown.validateSkillFrontmatter` | returns `Result.fail(MarkdownError)` with code `skill_missing_frontmatter`, `skill_invalid_frontmatter`, `skill_missing_name`, `skill_invalid_name`, `skill_missing_description`, `skill_invalid_description`, `skill_invalid_allowed_tools`, `skill_invalid_compatibility`, `skill_invalid_metadata`, or `skill_invalid_license` |
| `Graph.build` on an invalid declaration                                           | records a `GraphBuildError` in `Graph.diagnostics`; `@smthrs/flow` documents the codes and which of them are fatal                                                                                                                                                                                                                |

`Markdown.parseSkill` enforces the intrinsic rules of the Agent Skills specification: a `name` of 1 to 64 lowercase ASCII letters, digits, or single hyphens that does not start or end with a hyphen, a `description` of 1 to 1024 characters counted in code points, a scalar `allowed-tools`, a scalar `license`, a `compatibility` of 1 to 500 characters, and `metadata` mapping string keys to scalar values. `Markdown.validateSkillFrontmatter` applies the same rules to already-parsed frontmatter. The rule that `name` equals the skill directory name needs the file system and stays with `@smthrs/registry`.

## Mutability

A compatibility signature is immutable: every combinator returns a fresh one built from the same declaration, and the original keeps the capabilities, annotations, and collaborators it was made with. A collaborator array handed to `Flow.withFlows` is copied, so mutating it afterwards changes nothing.

Plan values are not copied. `Node.succeed`, `Node.fail`, and a call retain the caller's value by reference and read it when the graph is built, so mutating one between construction and `Graph.build` changes the recorded identity.
