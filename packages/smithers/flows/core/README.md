# @smthrs/core

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://core.smithers.sh

Schema-first sugar and metadata over `@smthrs/flow`. `Flow.make` takes one options object and lowers it onto the values that package executes: a declared action a host implements, and the flow that calls it. Beside that it publishes the metadata projections the registry and execution layers read: annotations, effects, placement, key material, digests, and Markdown lowering. The node model is `@smthrs/plan`'s and the graph builder is `@smthrs/flow`'s; `Node` and `Graph` here are the names this package's consumers reach them through.

JavaScript and TypeScript declarations and all planning callbacks must be trusted. `Graph.build` executes flow bodies, `Node.andThen` builders, `Node.catch` recovery callbacks, and an optional `resolveLayers` callback in the caller process with ambient process authority. Purity is a caller obligation, not an enforced boundary. Placement, capability, and effect metadata does not sandbox planning, including sandbox placement, empty capability grants, and sealed effects.

For agent-generated declarations, use a constrained data-only ingestion boundary that trusted code validates and translates into nodes, or load and plan untrusted code in an externally isolated environment with restricted permissions and resources. See [Plan time](https://core.smithers.sh/concepts/plan-time/#planning-requires-trusted-declarations).

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

The full API reference lives at [core.smithers.sh/reference/api](https://core.smithers.sh/reference/api/).

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/core/<Module>`.

| Module        | Public exports                                                                                                                                                                                                                                                                                                                                                            | Description                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Annotations` | `empty`, `add`, `merge`, `getOption`, `Placement`, `Effects`, `Priority`                                                                                                                                                                                                                                                                                                  | Builds and reads typed lexical annotations carried by flows and plan nodes.        |
| `Digest`      | `provideSync`, `digest`, `canonical`                                                                                                                                                                                                                                                                                                                                      | Synchronous SHA-256 and canonical JSON for pure identity constructors.             |
| `Effects`     | `Declaration`, `MakeOptions`, `NarrowResult`, `make`, `covers`, `narrow`, `overlaps`, `sealed`                                                                                                                                                                                                                                                                            | Normalizes effect declarations and checks path coverage, narrowing, and conflicts. |
| `Flow`        | `TypeId`, `Flow`, `Any`, `Payload`, `Reference`, `Seat`, `Input`, `Output`, `Error`, `MakeOptions`, `isFlow`, `make`, `withCapabilities`, `within`, `annotate`, `annotateMerge`, `withFlows`, `sealed`                                                                                                                                                                    | Declares schema-described signatures and lowers them onto `@smthrs/flow`.          |
| `Graph`       | `build`, `nodes`, `edges`, `drafts`, `diagnostics`, `evaluatedFrom`, `maximumGraphDepth`, `Graph`, `GraphNode`, `Edge`, `EdgeReason`, `LayerRequest`, `BuildOptions`                                                                                                                                                                                                      | `@smthrs/flow`'s plan-time graph builder, re-exported.                             |
| `KeyMaterial` | `InputRef`, `KeyMaterial`, `Entry`                                                                                                                                                                                                                                                                                                                                        | Defines the stable key projection emitted from a built graph. Types only.          |
| `Markdown`    | `splitFrontmatter`, `MarkdownFrontmatter`, `SkillFrontmatter`, `SkillDocument`, `MarkdownErrorCode`, `MarkdownError`, `lowerMarkdown`, `isSkillName`, `validateSkillFrontmatter`, `parseSkill`, `lowerSkill`                                                                                                                                                              | Parses and lowers Markdown and Agent Skills declarations to signatures.            |
| `Node`        | `TypeId`, `Ast`, `Node`, `Any`, `Success`, `Error`, `CallMode`, `isNode`, `succeed`, `fail`, `all`, `map`, `andThen`, `branch`, `catch`, `capture`, `priority`, `declaredPriority`, `bindPlanned`, `plannedReference`, `branchSubject`, `catchSubject`, `catchFilter`, `continuation`, `mapper`, `predicate`, `declaration`, `flowCall`, `actionCall`, `functionIdentity` | `@smthrs/plan`'s inert, pipeable plan AST, re-exported.                            |
| `Placement`   | `Options`, `Placement`, `local`, `client`, `sandbox`, `remote`                                                                                                                                                                                                                                                                                                            | Creates serializable host-placement declarations.                                  |

```ts
import { Flow, Graph, Node, Placement } from "@smthrs/core"
import { Schema } from "effect"

const greeting = Flow.make({
  name: "greeting",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  body: ({ name }) => Node.succeed(`Hello, ${name}`)
}).pipe(Flow.within(Placement.sandbox()))

const graph = Graph.build(greeting.flow, { name: "world" })
```

`@smthrs/core/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## What a signature lowers to

A signature carries one `name`, which is the tag of everything it lowers to.

With a `body`, `Flow.make` returns a value whose `flow` is a `@smthrs/flow` flow with that body: its nodes are the nodes the body returns, and `Graph.build` splices them into the caller's plan.

Without a body, it returns a value that also carries an `action`. The flow's whole body is one call to that action, which is the shape a declared capability ceiling is read off, and the action is what a host attaches the implementation to:

```ts
import { Flow } from "@smthrs/core"
import { Effect, Schema } from "effect"

const read = Flow.make({
  name: "std/read",
  input: Schema.Struct({ path: Schema.String }),
  output: Schema.String,
  capabilities: ["fs"]
})

const layer = read.action!.toLayer(({ path }) => Effect.succeed(path))
```

An input schema that is not a struct travels as the one field `input`, because `@smthrs/flow` requires a struct payload. `Flow.Payload<I>` names the wrapped schema, and `signature.call(value)` takes the declared shape and wraps it, so an author never writes the wrapper.

A signature that declares no effect envelope dispatches as `irreversible`. `Flow.sealed` changes its tier to `sealed`, but its generated action remains keyless and uses invocation identity; the tier alone does not enable content sharing across runs. Use the native `Action.make` contract for explicit idempotency keys and implementation versions.

Struct schemas, including `Schema.Class`, pass through as the native payload schema. Calls accept the schema's constructor input, so class schemas accept inert field data without requiring a class instance in a planned payload.

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
| `Flow.make` with no `name`                                                        | throws `TypeError`: the tag is what a host binds an implementation to and what a plan records                                                                                                                                                                                                                                     |
| `Node.capture` on a non-function operation or non-inert capture data              | throws `TypeError`; a capture-data failure names the offending path in its `Node.capture:`-prefixed message                                                                                                                                                                                                                       |
| `Markdown.parseSkill`, `Markdown.lowerSkill`, `Markdown.validateSkillFrontmatter` | returns `Result.fail(MarkdownError)` with code `skill_missing_frontmatter`, `skill_invalid_frontmatter`, `skill_missing_name`, `skill_invalid_name`, `skill_missing_description`, `skill_invalid_description`, `skill_invalid_allowed_tools`, `skill_invalid_compatibility`, `skill_invalid_metadata`, or `skill_invalid_license` |
| `Graph.build` on an invalid declaration                                           | records a `GraphBuildError` in `Graph.diagnostics`; `@smthrs/flow` documents the codes and which of them are fatal                                                                                                                                                                                                                |

`Markdown.parseSkill` enforces the intrinsic rules of the Agent Skills specification: a `name` of 1 to 64 lowercase ASCII letters, digits, or single hyphens that does not start or end with a hyphen, a `description` of 1 to 1024 characters counted in code points, a scalar `allowed-tools`, a scalar `license`, a `compatibility` of 1 to 500 characters, and `metadata` mapping string keys to scalar values. `Markdown.validateSkillFrontmatter` applies the same rules to already-parsed frontmatter. The rule that `name` equals the skill directory name needs the file system and stays with `@smthrs/registry`.

## Mutability

A signature is immutable: every combinator returns a fresh one built from the same declaration, and the original keeps the capabilities, annotations, and collaborators it was made with. A collaborator array handed to `Flow.make` or `Flow.withFlows` is copied, so mutating it afterwards changes nothing.

Plan values are not copied. `Node.succeed`, `Node.fail`, and a call retain the caller's value by reference and read it when the graph is built, so mutating one between construction and `Graph.build` changes the recorded identity.
