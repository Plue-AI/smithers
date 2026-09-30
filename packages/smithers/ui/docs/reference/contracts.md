---
title: "Failure codes and limits"
description: "Every stable failure code a component reports, every resource limit it enforces at a boundary, and the object-URL ownership rule for PromptInput attachments."
sidebar:
  order: 2
---

Three contracts a consumer has to know about, and none of them is visible from a
component's props table alone. Every value below is the value in the source, and
the file is named beside each one so a reader can check.

## Failure codes

Every code is a stable string a caller may branch on. None of them carries host
error text: a rejected clipboard write reports `clipboard-write-failed` and
hands back the original rejection as `cause`, rather than pasting a browser's
message into the UI.

### Copy affordances

`src/internal/copyToClipboard.ts` is the one copy path behind `CodeBlock`,
`Snippet`, and `SecretField`. It awaits either the caller's `onCopy` or
`navigator.clipboard.writeText`, and returns `{ ok: true }` or
`{ ok: false, code, cause }`.

| Code                     | Emitted when                                                                                                                       | After                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `clipboard-unavailable`  | No `onCopy` was supplied and the host has no `navigator.clipboard.writeText`. `cause` is `undefined`, because nothing threw.        | Nothing was copied. The control does not enter its copied state.          |
| `clipboard-write-failed` | `onCopy` or `writeText` rejected or threw. `cause` is the original rejection.                                                       | Same.                                                                     |

The copied state is set only after the write fulfills, so a control that says
"Copied" copied something.

### `MarkdownEditor`

`src/adapters/markdown-editor/MarkdownEditor.tsx` reports through `onError` with
`MarkdownEditorError = { code, cause }`, where `cause` is the original
rejection.

| Code                   | Emitted when                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `editor-load-failed`   | The `@milkdown/*` modules could not be loaded. With the default `loadEditor` seam that is the dynamic import rejecting. |
| `editor-create-failed` | The modules loaded, but constructing the Crepe editor or awaiting its `create()` threw or rejected.              |

The component tracks an `EditorState` of `"loading"`, `"ready"`, or `"failed"`.
Either code moves it to `"failed"`, and a failed editor renders the seeded
textarea with `data-mode="failed"` rather than the empty host div it used to
leave behind. The textarea carries the current markdown, so a load failure
degrades to a plain editing surface instead of losing the document. A consumer
that renders its own fallback can key on `onError`; one that does not still gets
a working textarea.

`setMarkdown` received while modules load or `create()` is pending replaces the
seed before the editor becomes ready. Only the latest value is applied, without
an `onChange` echo. Failed attempts release their editor and ignore stale
callbacks. Retries wait for pending creation and teardown before reusing the
host; teardown rejection does not prevent recovery.

`data-mode` has three values: `"wysiwyg"` for the real editor, `"fallback"` when
the caller passed `fallback` or the host failed the rich-text capability probe,
and `"failed"` after one of the codes above.

### `PromptInput`

`src/prompt/PromptInput.tsx` reports through `onError` with
`PromptInputError = { code, message, file?, cause? }`. `message` is
user-presentable prose; `code` is what to branch on.

| Code            | Emitted when                                                          |
| --------------- | --------------------------------------------------------------------- |
| `disabled`      | A file arrived while the prompt was disabled.                         |
| `multiple`      | `multiple` is false and a file arrived while one is already attached. |
| `max-files`     | The attachment count is already at `maxFiles`.                        |
| `max-file-size` | `file.size` exceeds `maxFileSizeBytes`.                               |
| `accept`        | The file does not match the `accept` pattern.                         |
| `submit-failed` | An async `onSubmit` rejected. This is the only code that carries a `cause`. |

The first five all come from `addFiles`, which is the single admission point.
The hidden `<input>` is not the enforcer: the `usePromptInputAttachments().add`
hook, a paste, a drop on the form, and the document-level drop registry all pass
through `addFiles`, so every flag applies to every intake path and every refusal
reports the same code.

`submit-failed` deliberately keeps the draft. A failed submit that also erased
what the user typed is the worst outcome available, so the text and its
attachments stay until a submit succeeds.

### `ChatComposer`

`src/chat/ChatComposer.tsx` reports through `onError` with
`ChatComposerError = { code: "submit-failed", cause }`. It fires once when
`onSubmit` throws synchronously or its returned promise rejects. Without
`onError`, the cause goes to `globalThis.reportError`, so the failure is never
an unhandled rejection. The composer is controlled and never changes `value`;
the host decides whether to keep or clear the draft.

### The vault autosave machine

`src/vault/autosaveMachine.ts` carries the failure on the snapshot beside the
state (`AutosaveSnapshot.failure`), as `AutosaveFailure = { code, cause }`.

| Code           | State      | Meaning                                                                                                       |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `conflict` | `conflict` | The backend refused the conditional write because the checked revision changed. |
| `read-failed`  | `conflict` | `readExternal` threw. The machine fails closed, because a file it cannot read is a file it cannot safely overwrite. |
| `write-failed` | `dirty`    | `save` rejected. The debounce retries, so the document is not lost, but nothing was persisted.                 |

The codes exist to make three outcomes distinguishable that used to look
identical. A `conflict` with no failure is a real concurrent edit: someone else
changed the file. A `conflict` carrying `read-failed` is an inspection error. A
`dirty` carrying `write-failed` is a document whose write was attempted and
rejected, not one the user has simply not finished editing.

The hook exposes the same readonly `failure` and original `cause`. A successful
retry clears it. Both ordinary saves and `discardExternal()` pass the captured
`AutosaveRevision` to `save(value, expected)`. The host must atomically compare
content and revision and write, returning `{ status: "conflict", cause? }`
without writing on mismatch. `discardExternal()` authorizes replacing the
version just read, and still refuses an unreadable or subsequently changed
version. The UI library cannot enforce atomicity inside a host callback.

Hook retirement retains the document's text, failure, writer and scheduled
retry until its snapshot is clean or saved. Reopening the same `resetKey` in
the same `owner` recovers that machine. A stable owner object isolates keys
between vaults; the default owner is module-wide in the browser. Server
renders use private owners. Unkeyed hooks still flush and retry after unmount,
but require a stable key to reopen unresolved conflicts.
Retained drafts are memory-only and do not survive a process or page restart.

## Resource limits

Each limit is a named export or a documented constant, and each one has a
deterministic result at the boundary rather than a crash. The values are chosen
so that no shape a provider or a host realistically sends is truncated.

### Parsing agent output

`src/agentic/parseAgentOutput.ts`

- `MAX_SUMMARY_DEPTH = 16` bounds the descent through a reasoning part's nested
  `summary` arrays.
- `MAX_NEST_DEPTH = 16` bounds the descent through the
  `output`/`result`/`data`/`response`/`message` spine.

Both traversals carry a `WeakSet`, so a cyclic payload is caught before the
depth cap is reached. Over-depth and cyclic branches are discarded. The result
is `null` when no recognized fields remain; otherwise it is a partial model
containing only readable response text, disclosed summaries, and tool calls.
Partial models do not retain discarded raw branches. `AgentOutput` renders
only model fields and provides no automatic JSON fallback.

Raw reasoning, thinking, and thought records are excluded from response text
and envelope traversal at every level, including nested message objects.
Explicitly labeled summaries are retained separately as `reasoningSummary`.
Records with `type` or `kind` set to `redacted_thinking`, or with defined
`signature`, `redactedData`, or `redacted_data` metadata, are discarded entirely,
including summaries.

A host can explicitly render `<pre>{formatJsonSafe(displaySafePayload)}</pre>`
when parsing returns `null`. The host must approve that payload for display:
`formatJsonSafe` bounds serialization but does not remove private output, and
`null` can indicate a privacy rejection. See the
[fallback example](../guides/render-agent-output.md#format-a-value-you-did-not-produce).

### Formatting unknown JSON

`src/agentic/formatJsonSafe.ts`, used by `SchemaDisplay` and available for
host-provided JSON fallbacks.

| Constant                 | Value   | Marker at the boundary                                                                                              |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `MAX_JSON_DEPTH`         | `12`    | The value is replaced with `[truncated]`.                                                                           |
| `MAX_JSON_ENTRIES`       | `200`   | An array gains a final `[truncated: N more items]` element; an object gains a `[truncated: N more keys]` key whose value is `[truncated]`. |
| `MAX_JSON_STRING_LENGTH` | `8192`  | The string is cut and suffixed `[truncated: N more characters]`.                                                     |
| `MAX_JSON_OUTPUT_BYTES`  | `65536` | The whole result is cut and suffixed `[truncated: output exceeded 65536 bytes]`, counted in UTF-8 bytes including the marker. |

A value that cannot be serialized at all, a cycle included, returns the literal
`[unserializable]`. That string is a formatter code: it never carries the host
exception's message.

### Rendering a schema

`src/artifacts/SchemaDisplay.tsx`

- `MAX_SCHEMA_DEPTH = 12` bounds property nesting below the root.
- `MAX_SCHEMA_PROPERTIES = 200` bounds the property rows rendered across one
  display.

A schema that points back at itself renders `[circular]` for the repeated type
and a `[truncated]` marker row at the bound, both carrying
`data-schema-truncated="true"`. Two properties that share one referenced object
render twice; only an actual ancestor cycle is reported as circular.

### Untrusted values

- `src/adapters/chart.tsx` writes a chart config color into the generated
  `<style>` block only when it is hex, a named color, `var(--token)`, or a color
  function (`rgb`, `hsl`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color`) over
  plain numbers and keywords. Any other value, `url(...)` and `image-set(...)`
  included, is dropped.
- `src/internal/safeImageSrc.ts` gates the `ToolCall` image part and the
  `Source` and `InlineCitation` favicons. It admits `data:image/...`, `blob:`,
  and same-origin relative paths only, because an `<img>` fetches on render.
  A refused favicon falls back to the initial tile; a refused tool image
  renders its alt text. Proxy a remote image through your own origin.
- `EnvironmentVariable` masks a value through `SecretField` when `secret` is
  unset and the name or the value looks like a credential. The name masks when
  it contains `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`,
  `CREDENTIAL`, `PRIVATE`, `COOKIE`, `DSN`, `SALT`, `HMAC`, `BEARER`, or
  `WEBHOOK`; `KEY` not followed by a letter (`API_KEY`, not `KEYBOARD`); `AUTH`
  outside `AUTHOR` (`OAUTH`, `AUTHORIZATION`); a whole `_`-separated `PASS`,
  `PW`, `PWD`, `SK`, `PAT`, `OTP`, `TOTP`, `PIN`, `SIGN`, `SIGNING`,
  `SIGNATURE`, `CERT`, or `CERTIFICATE`; or `SESSION` as the last word or before
  `ID`. A URL name alone does not mask: `PUBLIC_URL` shows. The trimmed value
  masks when it is a URL carrying `user:password@`, or has a credential-named
  query or connection-string parameter (`?api_key=`, `;Password=`). The match
  is a heuristic. Pass `secret` to override it either way.
- `assembleLine` in `src/flow-form.ts` (and `assembleArgs`, its line alone)
  withholds a value when it contains one of the tokens the app's grammars
  share, or when the positional read places it elsewhere. It does not know
  each flow's own grammar.
  - On the default positional path it ends the line before the first value
    with a `--flag`, a `name=` binding (`sourceCard=`, `against=`, `by=`), or
    a `from:<ref>` token, a `sourceCard` or list item that is not one token,
    or any value `positionalRead` would place in another field: a multi-word
    value short of the final slot, a value behind an unset slot, or an optional
    value a required slot behind it would take. JSON gets no exemption: JSON
    with whitespace short of the final slot is withheld unless the flow's
    `partial` reads it back whole. True booleans are written as trailing
    `--name` tokens.
  - A flow's own `args` builder gets the same token refusal. A `--flag` or
    `sourceCard=` token the builder writes inside the value's JSON string
    literal is kept; a `name=` binding or `from:` token is withheld however it
    is quoted. When the flow declares `partial`, every carried value must also
    read back through it. Without `partial`, a builder that joins a multi-word
    value short of its final slot is not detected.
  - A value that ends in an `owner/repo` token is not withheld, because whether
    a grammar reads the last token as a repository depends on the flow and on
    which repositories the app knows.
  - Every value left out is returned in `withheld`. A caller that runs the
    line re-parsed as text must compare the grammar's read of that line with
    the named payload, and refuse when a field differs or appears; the app's
    confirmation button and deferred commands do (`carriesPayload`), and the
    search palette drops such an action. A caller that shows the line beside
    the named payload it submits uses `displayLine`, which names the withheld
    fields after the line.
- `Attachment` thumbnails and `MessageAvatar` images are not gated by
  `safeImageSrc`: the host supplies them. Do not pass model or tool output to
  them.

### Other bounded helpers

- `src/artifacts/SecretField.tsx` clamps `maskLength` to
  `Math.min(64, Math.max(1, Math.trunc(maskLength) || 8))`. The prop is a fixed
  display constant that never tracks the real secret's length, so an enormous or
  non-finite value cannot allocate a proportional string.
- `src/time/RelativeTime.tsx` treats `MAX_TIME_VALUE = 8.64e15` as the range
  `Date` can hold. A timestamp outside it, `NaN` included, still renders its
  label and simply omits `dateTime` and `title` rather than throwing
  `RangeError`. `TICK_MS = 1000` is the period of the single ref-counted
  interval every mounted `RelativeTime` and `useRelativeTime` re-renders off.
  One second is the period because `formatRelativeTime` has one-second
  granularity below a minute; the saving the shared store exists for is having
  one timer per page of timestamps, not a slow one.
- `src/diff-paginate.ts` calls a diff large above `LARGE_FILE_COUNT = 50` files
  or `LARGE_BYTE_LIMIT = 1000000` total bytes. A large diff opens fully
  collapsed; below it `initialExpanded` opens every file up to three and the
  first three beyond that. Within one file, `PAGINATE_THRESHOLD = 2000` rendered
  lines is the budget above which pagination engages, and
  `PAGINATE_VISIBLE = 1000` lines render before the expand affordance.
  `byteCountString` returns the literal `"unknown size"` for a negative or
  non-finite byte count, because rendering `"NaN MB"` states a fact the caller
  does not have.

## Object-URL ownership

`PromptInput` mints one blob URL per image attachment it accepts, stores it as
that attachment's `url` and `thumbnailUrl`, and owns it. The rule is short:

**The component revokes the URLs it created. A consumer must never revoke a URL
it did not create, and must not hold one past the handler it was given in.**

What that means in practice, from `src/prompt/PromptInput.tsx`:

- `url` and `thumbnailUrl` are borrowed for the lifetime of the `onSubmit`
  handler. A synchronous handler settles synchronously and the draft clears
  immediately, which is the clear-on-submit behavior the component has always
  had. An **async** handler holds the draft and its blob URLs until the returned
  promise settles, so a handler may `await` and still read the URLs it was
  handed. On acceptance, uncontrolled text clears only if it has not been edited
  since submission, even if an edit restored the submitted text. Only submitted
  attachments are removed and their URLs revoked: files added while the submit
  was in flight remain attached and keep their previews.
- A rejected `onSubmit` revokes nothing and clears nothing. The draft, its
  attachments, and their URLs survive, and the rejection is reported as
  `submit-failed`.
- Removing one attachment revokes that attachment's URL immediately, unless a
  pending `onSubmit` was handed it: the revoke then waits until that handler
  settles. `clearAttachments` follows the same rule; unmounting revokes every
  URL the component still holds.
- Anything a consumer needs after the handler settles must be copied from the
  attachment's `file`, which the component does not own, not from `url`. Uploads
  read the `File`; a preview that has to outlive the prompt calls
  `URL.createObjectURL` on that `File` and revokes its own URL.

A consumer that supplies `attachments` as a controlled prop owns the whole
collection, and the component revokes nothing on submit.

## Related

- [Collect a prompt with attachments](../guides/collect-a-prompt.md): the
  task-shaped version of the `PromptInput` rules.
- [API reference](../api.md): every public export.
- [Troubleshooting](../troubleshooting.md): the symptoms these contracts explain.
