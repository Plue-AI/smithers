---
title: "Diagnose a flow that did not appear"
description: "Read registry.warnings() to find out why a flow file produced no entry, or produced one with the wrong name, authority, or visibility. Every discovery warning code, grouped by what it says."
sidebar:
  order: 2
---

A scan never fails because one entry is wrong. `flows/` is a directory a person
edits, so at any moment one file in it is mid-edit or malformed, and refusing
the whole catalog for it would take every unrelated command down too. Anything
a scan can survive becomes a `DiscoveryWarning` instead, and the warnings are
the answer to "why is my flow not there".

## Read the warnings

```ts
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"

const diagnose = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  for (const warning of yield* catalog.warnings()) {
    console.log(`${warning.code} ${warning.path}${warning.name ? ` (${warning.name})` : ""}`)
    console.log(`  ${warning.message}`)
  }
})
```

Each warning carries a stable `code`, the `path` of the file it is about, the
flow `name` when one was derived, a human `message`, and a `cause` when a host
error produced it. Warnings are sorted by path, then code, then message, so two
scans of the same tree report them in the same order.

[`smthrs doctor`](/cli/doctor) prints the same list.

## The flow produced no entry at all

These codes mean a file or directory contributed nothing:

| Code                  | What happened                                                                                                                                                                                                              | What to change                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `missing_description` | A markdown flow has no non-empty frontmatter `description`, or a module flow's default `Flow.make` value has no literal `description`. Discovery needs one, because it is what a model and an autocomplete list are shown. | Add a one-line description. In a module, write it as a string literal; discovery reads it without evaluating the file. |
| `root_level_entry`    | An entry file sits directly in the root of a path-named source, so there are no directory segments to name it.                                                                                                             | Move it into a subdirectory: `flows/review/flow.mdx`, not `flows/flow.mdx`.                                            |
| `entry_too_large`     | The file is past `Discovery.entrySizeLimit`, 4 MiB. The message reports the byte count.                                                                                                                                    | Check for a build artifact or generated file under the source root.                                                    |
| `unreadable`          | A directory or file could not be read or inspected. `cause` carries the host error.                                                                                                                                        | Fix the permission or the broken link.                                                                                 |
| `outside_root`        | A directory or selected entry file resolves outside `Source.confinementRoot`, which packs set to their root, or its real path cannot be resolved. The target is skipped before reading its contents.                       | Move the target inside the pack and update the symlink.                                                                |

Two more stop the walk rather than one entry:

| Code                 | What happened                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `symlink_cycle`      | A directory resolves to one already visited. The message names both. Everything below it is skipped. |
| `max_depth_exceeded` | The walk passed `Discovery.maximumTraversalDepth`, 32 entry-name segments.                           |

## The flow appeared under the wrong name

| Code                      | What happened                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name_field_ignored`      | The source is path-named, so a `name` key in the file has no effect. The directory path below the root is the name.                                              |
| `missing_name`            | A frontmatter-named source has no `name` key. The directory name was used.                                                                                       |
| `invalid_name`            | A blank or non-string `name` uses the directory name. A nonempty string is trimmed and retained, even when it violates the naming grammar or 64-character limit. |
| `directory_name_mismatch` | The retained `name` differs from the directory's name, whether valid or invalid. The retained name was used.                                                     |
| `duplicate_name`          | Two sources, or two directories, produced the same name. The message names the file that kept it. Order your sources so the winner is the one you meant.         |
| `shadowed`                | Two packs define the same name. The `local` pack wins whatever order the host listed them in. See [Load workflow packs](./load-packs.md).                        |
| `multiple_entry_files`    | One directory holds more than one of `flow.ts`, `flow.mdx`, and `SKILL.md`. The message names the one used.                                                      |

See [Sources and naming](../concepts/sources.md#two-ways-a-flow-gets-its-name)
for the grammar. Use the descriptor's `name` for lookup. For example, `name: Review--PR` in
`review/SKILL.md` is retained as `Review--PR` with `invalid_name` and
`directory_name_mismatch`; it does not register a fallback alias `review`.

## The flow has unexpected authority or is refused

These codes explain unexpected authority and refused capability declarations.
[Declared authority](../concepts/authority.md) explains the fallbacks.

| Code                          | What happened                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unprojectable_authority`     | A markdown flow declared no `capabilities`, so the wildcard was used. Declared `capabilities` narrow the grant of collaborator `flows`.                                                       |
| `invalid_capabilities`        | A space-separated `capabilities` string is accepted with this warning. A mapping or an array containing non-strings is refused; the markdown flow is not discovered.                          |
| `invalid_effect_declaration`  | `effects` is not an object, or `effects.reads`, `effects.writes`, `effects.mode`, or `effects.onConflict` is not a value the schema allows. The conservative reading was used.                |
| `invalid_effect_tier`         | A declared `effects.tier` under-classifies the authority the capabilities imply, or is not one of the three tiers. The conservative tier was used.                                            |
| `unsupported_module_metadata` | A module declaration could not be read statically: a non-literal `capabilities` or `effects`, an object spread, a computed property, or an unreadable default export. The message says which. |

## The declaration had a key discovery did not use

| Code                       | What happened                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_frontmatter_key`  | A frontmatter key outside the accepted set. Check it against the [flow.mdx reference](/docs/reference/flow-mdx/); a typo is the usual cause.                                                  |
| `invalid_allowed_tools`    | `flows` or `allowed-tools` is neither a string array nor a space-separated string. It was ignored, so the flow now delegates to the agent.                                                    |
| `invalid_model_invocation` | `disable-model-invocation` is not a boolean or the strings `"true"` or `"false"`. It was ignored, so the flow stays model-invocable.                                                          |
| `invalid_placement`        | `placement` is not `client`, `local`, `sandbox`, or `remote`. It was ignored, so the flow is discovered unplaced and the host chooses where it runs.                                          |
| `invalid_sandbox`          | `sandbox` names an unknown provider or key, has a malformed `network` or limit, or sits beside a `placement` other than `sandbox`. The flow is refused.                                       |
| `invalid_model`            | `model` is an empty list (for example, `model: []`) or contains an empty or non-string seat. The markdown flow is not discovered; provide one seat or a non-empty ordered list.               |
| `invalid_budget`           | `budget` is not an object, a ceiling is not a positive safe integer, or the object holds a key that is not `tokens` or `milliseconds`. The unreadable part was dropped rather than tightened. |
| `invalid_deadline`         | `deadline` is not a duration such as `30 minutes` or a positive whole number of milliseconds. It was dropped, so the run is unbounded.                                                        |
| `invalid_license`          | `license` is not a string.                                                                                                                                                                    |
| `invalid_compatibility`    | `compatibility` is not a string of at most 500 characters.                                                                                                                                    |
| `invalid_metadata`         | `metadata` is not a string-to-string mapping.                                                                                                                                                 |
| `invalid_description`      | The description is longer than the 1024-character Agent Skills limit. The entry is still produced.                                                                                            |
| `unsupported_input_schema` | A markdown flow declared `input` or `schema`. A markdown flow's input is always `{ args: string }` and its output is always a string.                                                         |
| `unknown_pack_key`         | A `pack.json` holds a key outside `name`, `version`, `flows`, `skills`, and `requires`. A misspelled `requires` would otherwise disable the compatibility gate in silence.                    |

## The frontmatter could not be parsed

| Code                           | What happened                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `frontmatter_parse_error`      | The YAML did not parse. The message carries a bounded line-and-column summary and at most three issues. |
| `non_serializable_frontmatter` | A value could not be represented as JSON. It was replaced with `null` and reported once.                |

The offending source line is never quoted, and the raw parser error is not
attached. Unknown frontmatter is retained verbatim on the descriptor and may
hold a secret, so the diagnostic says where the problem is without repeating
what is there.

Frontmatter is parsed with YAML's failsafe schema, so every scalar is a string.
Every mapping is built with a null prototype and frozen, which is why a
`__proto__`, `constructor`, or `prototype` key is retained as an ordinary own
key and can never install inherited metadata a descriptor's digest cannot see.

## The flow exists but a model never calls it

A flow that declared `disable-model-invocation: true` is discovered, listed by
`list()`, and excluded from `visible()` and from `Disclosure.toXml`. That is
the flow behaving as declared, not a warning. See
[Show a catalog to a model](./show-flows-to-a-model.md).
