---
title: Run locally
description: Start the terminal agent in your repository.
order: 1
section: Start
---

The new TUI is available from this source checkout. Use the Node version in `.node-version`, pnpm 11.25.0, and Bun 1.4 or later.
Install jj 0.39.0 or later for flow execution and ripgrep (`rg`) for text search.
Source checkouts also need the native filesystem helper built with Rust 1.98.0;
compiled TUI releases embed it. On Alpine, the compiled musl executable
also needs `apk add libstdc++`.

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
cargo +1.98.0 build --locked --release -p smithers-ffi --bin smithers-jj-export
bun run tui /path/to/project
```

```tui-script first-run
Use "basic"
Capture "Start the terminal in the project directory."
Type "Explain math.js"
Press Enter
Wait for answer "Ready."
Capture "Send a first prompt and read its answer."
```

Configure a provider before starting. The terminal reads credentials such as `OPENAI_API_KEY` from your environment. Browser playground settings apply only to the playground.

```bash
bun run tui /path/to/project --model openai:gpt-6-sol
```

Ask for a small change with a check:

```text
Fix the empty search result in src/search.ts. Run the search tests.
```

## Resume

Continue the latest session in the current directory:

```bash
bun run tui -c
```

Use `-r` to pick a session. Sessions include messages, worker requests, and recorded steps. A worker that was running resumes from its recorded work.

## Review before execution

The terminal runs file edits, commands, and network calls by default. To approve consequential calls individually:

```bash
bun run tui --approve ask
```

Use `--approve deny` to refuse them. Press **Esc** to stop a turn.

## One answer

```bash
bun run tui -p "Explain how the search index is built."
```

The `smthrs tui` entry point also launches the TUI when its binary or runtime bundle is installed. This guide uses the source checkout until the release is published.
