# Smithers UI

The React renderer and Electrobun desktop host for Smithers. The native window
loads the app from its authenticated loopback server, not `views://` or a Vite
development origin. The browser build is also served by `apps/server`.

## Development

From the monorepo root, with the repository's Bun/pnpm toolchain installed:

```sh
pnpm install
pnpm --filter smithers-app start
```

`start` prepares the Electrobun devkit, builds the SPA, then launches the desktop
app. `pnpm --filter smithers-app dev` runs the native watch loop. For build-only
work, use `build:web` for the SPA or `build:native` for the native package.
The old template's `dev:hmr` and `build:prod` scripts do not exist.

## Background work and queued prompts

Worker toasts offer the controls supported by their host and current state:
open, stop, steer, model, thinking, approval, resume, retry or reconnect.
They appear after 300 ms and stay running through launch and execution.
The embedded run card retains the output.

Enter submits or steers; Alt+Enter (or Queue) adds a FIFO follow-up.
Alt+Up restores queued prompts to the editor. Items can also be edited or removed.
The queue persists within its repository, workspace and conversation branch;
Stop, failure or an interrupted reload pauses it until Resume.
The GUI and TUI share queue operations and worker action eligibility through
`@smthrs/rpc/PromptQueue` and `@smthrs/rpc/WorkerControls`.

## Verification

```sh
pnpm --filter smithers-app typecheck
pnpm --filter smithers-app test
pnpm --filter smithers-app test:e2e
```

The unit/source suite does not automatically adopt personal host checkouts.
Host-workspace integration cases require explicit opt-in and retain their run
histories; see [build and verification](docs/LOCAL-APP.md#build-and-verification).
The default Playwright host uses a temporary home/state directory, a chat stub,
and no real harness discovery or credential-bearing shell environment.
Real chat is a separate opt-in, `SMITHERS_CHAT_STUB=0`.
Packaged native testing is a separate lane (`test:e2e:packaged`) with its own
platform/network requirements.

## Code ownership

- `src/mainview/`: chat, embedded surfaces, Flow registry, controller and store.
- `src/mainview/chain/`: browser persistence and recovery.
- `src/bun/`: native shell and authenticated local origin. Repository work,
  terminals and language servers run in the workspace backend.
- `packages/rpc/src/`: shared `@smthrs/rpc` wire contracts.
- `packages/smithers/`: the new Flow, Harness, Journal and related runtime packages.
- `apps/server/`: Cloudflare Worker and web host.

Read [AGENTS.md](AGENTS.md) before changing interactions. The
[local-app architecture](docs/LOCAL-APP.md) describes transports and native
boundaries; [persistence](docs/persistence.md) describes storage, migration,
archiving and private recovery files.
