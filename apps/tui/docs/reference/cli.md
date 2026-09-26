---
title: CLI reference
description: Start interactive, resumed, or one-shot terminal sessions.
order: 22
section: Reference
---

```text
bun run tui [directory] [--model provider:modelId] [-c | -r] [-p "prompt"] [--approve all|ask|deny]
```

`smthrs tui` accepts the same arguments when the TUI binary or runtime bundle is installed. In the source checkout, run the command from the repository root.

Interactive mode requires terminal input and output. Use `--print` in scripts or pipelines.

| Option                     | Short | Effect                                                   |
| -------------------------- | ----- | -------------------------------------------------------- |
| `--help`                   | `-h`  | Show command-line options without opening a session.     |
| `directory`                |       | Working directory; defaults to the current directory.    |
| `--model provider:modelId` | `-m`  | Chat or print-mode model; overrides `SMITHERS_TUI_SEAT`. |
| `--continue`               | `-c`  | Continue the latest saved session for this directory.    |
| `--resume`                 | `-r`  | Open the session picker.                                 |
| `--print "prompt"`         | `-p`  | Execute one task, print its answer, and exit.            |
| `--approve all`            |       | Run consequential calls; the default.                    |
| `--approve ask`            |       | Ask before consequential calls; interactive mode only.   |
| `--approve deny`           |       | Refuse consequential calls.                              |

## Print one answer

```tui-script print-mode
Use "print"
Wait for "Ready."
Capture "Run a one-shot task and print its result before exiting."
```

```bash
bun run tui /path/to/project -p "Explain how the search index is built."
```

Print mode runs the task directly, without the interactive chat coordinator. It exits 0 on a completed answer and 1 on failure or cancellation. `--approve ask` is refused instead of waiting for an unavailable approval key.

## Runtime selection

`smthrs tui` tries `SMITHERS_TUI_BIN`, an installed compiled binary, Bun (`SMITHERS_BUN` or an already-running Bun CLI), then Node with experimental FFI. The TUI runtime supports Bun and Node 26.4 or later; this repository uses the Node pin in `.node-version`.

```bash
cargo +1.98.0 build --locked --release -p smithers-ffi --bin smithers-jj-export
node packages/smithers/scripts/build-tui.mjs
SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="$PWD/target/release/smithers-jj-export" \
  node --experimental-ffi --disable-warning=ExperimentalWarning packages/smithers/dist/tui/main.js /path/to/project
bun packages/smithers/scripts/build-tui-binaries.mjs --single
```

Compiled binaries use installed project dependencies for local flows. They share
their embedded Effect runtime with those flows and require its exact version;
incompatible project versions are refused before loading.

Interactive compiled builds need an executable, writable `TMPDIR` for their
native terminal library. Help and print mode do not load that library.

## Exit

`/quit` and `/exit` close the TUI. **Ctrl+D** exits with an empty editor. **Ctrl+C** clears text; pressing it twice within 500 ms exits. Use worker stop controls when you intend to cancel background work, rather than relying on a terminal disappearing.
