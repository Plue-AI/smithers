---
title: "Troubleshooting"
description: "The FsError codes @smthrs/fs reports, what causes each one, and how to fix it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/fs/docs/troubleshooting.md"
---

Every surface of `@smthrs/fs` fails with an `FsError` carrying a stable
`code`, the failing surface in `method`, and an optional `path`. Errors never
retain raw arguments, input or output values, or implementation causes, so a
serialized error is safe to log or return to an agent. This page maps each
code to its cause and fix. For the normative definitions, see the
[error codes table](/contract/#error-codes).

## Scan failures

### `root_missing`

The scan root does not exist. Pass `FileRouter.scan` a `root` that names an
existing directory; the root is resolved to an absolute path once, so a
relative root is resolved against the process working directory.

### `invalid_root`

The root or the scan configuration is invalid: an empty, overlong, or
malformed `root` string, a NUL character, or a configuration object the
boundary cannot inspect, such as one carrying an accessor. It also covers a
root that exists but is not a readable directory. Pass a plain data object
with a bounded, well-formed `root` string.

### `read_failed`

Discovery or companion inspection could not read the filesystem. The scan
read the root but a later read failed, for example while checking for a
`ui.tsx` companion or resolving its real path. Check permissions on the flows
tree.

### `discovery_failed`

Registry discovery failed without a more specific category. This is the
catch-all for registry failures other than `root_missing`, `invalid_root`,
and `read_failed`, and for foreign errors, whose causes are never retained.
Inspect the flows tree for entries the registry cannot parse, and see the
[registry API](https://registry.smithers.sh/reference/api/) for the discovery contract.

### `resource_limit`

A bounded container exceeded its limit: more than 256 routes from one scan,
an oversized command string or token, or an overlong route name in a
resolution request. Exact limits succeed; one over fails. Invocation values
above the JSON bounds are admission failures instead, reported as
`decode_failed` for input and `encode_failed` for output. For the full table,
see [Resource limits](/contract/#resource-limits).

## Route identity failures

### `duplicate_route`

Two routes claimed one command identity. Three forms exist:

- Two source paths collapse to one name during a scan, such as
  `duplicate/flow.ts` beside `duplicate/other.ts`. Keep one entry per route
  directory.
- Two routes with equal segments reach `CommandTree.make` or a surface
  constructor. Remove the duplicate before building the surface.
- A child route literally named `self` sits under a route that also has
  children, colliding with the reserved segment. Rename the child; the
  reserved segment is documented in
  [the `self` segment](/concepts/command-projections/#the-self-segment-keeps-groups-discoverable).

### `invalid_route`

Route metadata violated the immutable contract: a `name` that does not equal
its slash-joined segments, an empty or `.`/`..`/slash-carrying segment, a
relative `sourcePath`, an unknown `kind` or schema locator tag, an unknown
`effects` mode, conflict policy, or tier, or a container the boundary cannot
inspect without executing user code. Construct routes through
`FileRouter.scan` or validate hand-built ones with `Route.snapshot`.

## Command resolution failures

### `unknown_command`

No visible route, or no exact route, matched. Causes, in order of
likelihood:

- The route is not executable: hidden (`modelInvocable` false) or a Markdown
  or skill body. Command surfaces never mount it; check `Route.isCommandRoute`.
- A typo in the command string. Parsing takes the longest matching prefix, so
  a misspelled first segment matches nothing.
- A `call` name that is not exact. `call` requires the complete route name;
  trailing segments fail the same way.

On the CLI and HTTP surfaces, `unknown_command` is the only code that falls
back to metadata and help output.

### `parse_failed`

The command token, option grammar, or request path was invalid: an
unterminated quote in a command string, an invalid option name (names must
match a letter-led alphanumeric dash pattern, and `__proto__`, `constructor`,
and `prototype` are refused), or a malformed percent escape in an HTTP
request path. Fix the spelling; remember that single quotes are literal and
shell syntax is never evaluated, so quote the way the
[command lexing rules](/contract/#command-lexing) describe.

## Load and schema failures

### `unsupported_body`

A non-module route was sent to `Route.load`. Markdown and skill routes are
registry inputs rather than executable commands. Filter with
`Route.isCommandRoute` before loading, or take routes from a command surface,
which applies the filter for you.

### `load_failed`

The selected module could not be imported, or its default export is not a
flow. Confirm the file parses, its dependencies resolve, and the default
export satisfies `isFlow` from [@smthrs/core](https://core.smithers.sh/reference/api/).

Incur also reports this code for a route whose metadata load or projection
exceeds five seconds. Sibling routes remain discoverable. Keep module
initialization bounded and move long-running work into the flow invocation.
Successful metadata builds retain per-route failures; create a new CLI to
rebuild that surface. A rejected shared build is retried on the next request.

Aborting an HTTP discovery request stops only that caller's wait. Call
`await cli.close()` at host shutdown to interrupt shared metadata projection.
A native `import()` itself cannot be aborted: its module evaluation may
continue after a deadline or shutdown. Use a separate worker or process if
module evaluation requires hard termination.

### `unsupported_schema`

A schema locator cannot describe command input: the route declares an output
locator as its input. The route stays advertised on the Incur surfaces
because it stays dispatchable; calling it reports this code. Point the
route's input locator at a module field or an inline document instead.

### `decode_failed`

Input failed descriptor or Effect schema decoding, or the input value
exceeded the JSON admission bounds on encoded bytes, depth, members, nodes,
string length, or key length. The advertised JSON Schema
refuses wrong shapes before the flow runs, and the authoritative Effect
decoder refuses what JSON Schema cannot express, such as refinements (a
non-empty string), non-finite numbers, and values outside inert JSON. A
`call` with input that is not inert JSON (functions, cycles, symbol keys)
fails the same way before the module loads. Send values that satisfy the
flow's advertised schema; the field-level error names the failing path
without echoing the offending value.

### `encode_failed`

Output failed Effect schema encoding, or the output value exceeded the JSON
admission bounds. The invoker returned a value the flow's output schema
rejects or cannot carry, so the run's result never crossed the boundary. Fix
the invoker (in tests, the stub) to return the declared output shape.

## Invocation failures

### `invocation_unavailable`

No execution seam is installed: the `FlowInvoker` service in context is the
noop default, which fails every invocation without retaining invocation data.
Provide a real invoker with
`Layer.succeed(FlowInvoker.FlowInvoker, invoker)`, as shown in
[Expose flows to an agent](/guides/expose-flows-to-an-agent/), or a stub
from [Test flow invocation](/guides/test-flow-invocation/).
