# Reference page style

This rubric is shared by every reference writer prompt (`reference-package.md`,
`reference-target-rule.md`). Those prompts say what a
page contains; this file says how every reference page reads and what must be
true before one ships. A page that breaks a rule here fails its gate.

## What a reference page is

A reference page describes one unit of the product as it ships in this
checkout: what it is, what it accepts, what it returns, and how it fails. It
is consulted, not read. The reader is at work and wants one fact in under 30
seconds, so the page is a list of named entries in a fixed order, each entry a
heading with its facts directly under it.

A reference page does not instruct, explain, persuade, or opine. When a fact
needs a procedure or a rationale, link to the guide or concept page that owns
it and move on. When code and a comment disagree, the code is the truth; write
what the code does and leave a `<!-- verify: ... -->` comment naming the
disagreement.

## Truthfulness

Every claim on the page is checkable, and you check it before you write it:

- A symbol (function, namespace, type, constant, class, field) exists in the
  source you were given. Find its definition, not a usage or a README mention.
- A flag or argument exists in the command's parser. A flag that appears only
  in prose or `--help` prose is not a flag.
- A default comes from the definition, never from a doc comment about it.
- An error is documented at the site that raises it, with the condition.
- A type expression is copied from the definition, not reconstructed.
- A version claim comes from `package.json` or a changelog entry.

If you cannot verify a fact from the inputs you were given, leave it out. If
it matters and you cannot verify it, keep writing and leave
`<!-- verify: <question> -->` where the fact would go. Never invent a flag, a
default, an output line, an exit code, an error string, or an import path.

Every page ends with a `## Sources` section: a bulleted list of the
workspace-relative paths the page was written from. That list is the drift
anchor and the reviewer's starting point.

## Entry format

One entry per public thing, one heading per entry, the same shape for every
entry of a kind. The metadata block sits directly under the heading, before
any prose, and its rows come in this fixed order, each row omitted rather than
filled with "n/a":

```md
### `RetryPolicy.make`

- **Signature:** `make(options: RetryPolicyOptions): RetryPolicy`
- **Since:** `0.1.0`
- **Deprecated:** Use `RetryPolicy.of` instead; removed in 2.0.0.

Creates a retry policy from explicit options. ...
```

Rows a kind uses: `Signature` (or `Type` for a value, `Usage` for a command),
`Default`, `Required`, `Since`, `Deprecated`, `Related`. A table replaces
headings only for a closed set whose members each carry three or more compared
facts (attributes, flags, exit codes); never a one-column table, never a table
of prose.

The first sentence under the metadata is the standalone summary a list view
would show. Its opener is fixed by kind: a function starts with the verb
("Creates", "Returns", "Checks whether"); a value or property is a noun phrase
("The retry policy the engine uses when ..."); a boolean starts "Whether". It
never restates the name or the signature. Everything after the first sentence
adds what the types cannot say: units, ranges, empty and null semantics, side
effects, ordering, idempotency, what happens on failure, and known limits.

## Prose

- Present tense, active voice, one idea per sentence, under 26 words. The
  software is third person ("the engine records"); the reader is "you" only
  where the page tells you what to do. Never "we", "our", "let's", "the user".
- Condition before instruction: "To keep the run, pass `--keep`."
- Code font for every identifier, type, path, flag, value, placeholder, and
  file name. Bold for UI labels only. Never inflect an identifier: write "the
  `Flow.make` constructor", not "`Flow.make`s".
- Every type expression is in code font, including in tables. Bare `<`, `>`,
  `{`, and `}` in prose break MDX.
- One name per thing, the name the code uses. No synonyms, no metaphors.
- No em dash and no en dash anywhere, including tables and frontmatter. Use a
  period, comma, colon, or parentheses.
- No "easy", "simple", "simply", "just", "please", "note that", "currently",
  "new", "soon", "powerful", "seamless", "robust". No Latin abbreviations:
  "for example", "that is". No "will" for behavior; the software does it now.
- Sentence-case headings, no H1 in the body (the frontmatter title renders
  it), no skipped levels, no trailing period, no link in a heading.
- Introduce every table and code block with a sentence that ends in a colon,
  unless the block sits directly under an entry heading.
- Realistic example values from the product's domain (`deploy/status`,
  `greeting-ada-1`), never `foo`, `bar`, `x`, `data`.

## Code samples

- Every fence has a language: `ts`, `bash`, `json`, `md`, or `text` for
  verbatim output.
- A `ts` block is a complete program fragment that compiles under strict
  `tsc`: every symbol imported, no `...` for omitted code (use a `//`
  comment), values typed as the API types them. The gate compiles every `ts`
  block on the page.
- A `ts` block that is or extends a file the prose names carries the file
  name as its title: ```` ```ts title="greeting.ts" ````. The gate concatenates
  every block with the same title, in page order, into one file, so a later
  block may use what an earlier block of the same file imported or declared,
  and a block titled `run.ts` may `import "./greeting.ts"`. A tutorial that
  continues an earlier tutorial's project resolves that project's files
  through the target's `context` pages. Never put the file name in a `//`
  comment on the first line; the title is the name.
- A block that edits an earlier declaration, or shows the middle of a
  function, is not a compilable unit. Mark it ```` ```ts fragment ```` so the
  gate skips it, and keep such blocks rare: a skipped block is the one that
  can teach an API that does not ship. Prefer restructuring the page so the
  block is an append to its file.
- Imports resolve only to the published packages (`@smthrs/flow`,
  `@smthrs/engine`, `@smthrs/targets`, the rest of the `@smthrs/*` list in
  the brief), `effect/*`, and `@effect/platform-node*`. Import `effect`
  modules by path: `import * as Effect from "effect/Effect"`.
- Command synopses use four notations and nothing else: `[optional]`,
  `{a|b}` for exactly one of, `...` for repetition, `UPPER_SNAKE` for a value
  the reader supplies. After a sample with placeholders, write "Replace the
  following:" and list each placeholder in order of appearance.
- Input and output go in separate blocks. Output is `text`, and only output a
  named source pins down is quoted verbatim; otherwise describe it
  structurally ("prints one row per run with id, flow, and status").

## Cross-links

- Links are absolute site paths with a trailing slash:
  `/docs/reference/api/engine/`. Link text is the target's name or a
  descriptive phrase, never "here".
- Link only to routes that exist: the route map in the brief, plus
  `/docs/reference/api/<package>/` for every documented package and
  `/docs/reference/targets/<rule-slug>/` for every documented rule.
- A `Related` metadata row carries the see-also for an entry; a `## See also`
  list at the end carries the page-level ones. Prose does not digress into
  links.

## Frontmatter

A colocated page starts with exactly this frontmatter, values quoted:

```md
---
title: "@smthrs/flow"
description: "One sentence, under 160 characters, saying what the page lists."
area: api
order: 10
---
```

`area` is `api`, `cli`, or `targets`. `order` places the page in its area's
sidebar (lower first). The file name is the slug. No `slug` field, no H1.

## Before you finish

1. Grep every symbol, flag, path, and default you wrote against the inputs.
   Count them: "N claims, N verified, 0 unverifiable" belongs in your final
   note, not on the page.
2. Every `ts` block compiles against the packages named in its imports.
3. Every link targets a route in the allowed set and ends with `/`.
4. Search the page for `—`, `–`, `e.g.`, `i.e.`, `will `, `simply`, `just `,
   `currently`, `<!-- verify` and resolve each hit.
5. The page has the section skeleton its prompt requires, in order, with no
   extra sections and no empty ones.
