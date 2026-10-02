# Smithers product overview

Status: signed off by Will, 2026-10-02. High level only. The details are in [mvp.md](mvp.md), the design in [`.specs/design/`](../design/) and the engineering in [`.specs/engineering/`](../engineering/).

## In one sentence

Smithers is a self-hosted, multiplayer coding factory. It wraps your GitHub repository, gives each branch its own machine, lets people and agents work on that branch together, and is built entirely from flows you can change.

## Why it is different: everything is a flow

A flow is a durable workflow. Every action in Smithers is a flow, from a button or a slash command to an agent step or the whole factory. Flows live in the repository. This has four consequences:

- **Customizable.** Users, and the agent on their behalf, reshape the factory by editing its flows.
- **Self-improving.** The factory learns from its own runs and gets better over time.
- **Durable.** Every run is recorded, survives a restart without redoing finished work, and can be watched, steered, or resumed.
- **Agent parity.** The agent can do anything a person can, because both call the same flows.

## How it is built

```
1. Durable flows    The engine. Anything built on it is durable and can run distributed.
        │
2. The agent        Built on durable flows, so it inherits those properties.
        │           Strong at answering questions about the repository (with Jev).
        │
3. The product      A simple multiplayer coding factory.
```

## What a user gets

### A forge on your own machine

Run Smithers on one machine you own, such as a Mac mini. It wraps an existing GitHub repository. Open the forge in a browser to reach the Smithers app.

### Branches

```
same branch        one live working copy on one machine; people and agents edit it together;
                   it feels like a CRDT
different branches jj: fork a branch into a new one, stack changes, rebase; the history is
                   the mythical stack
```

A branch is a singleton: exactly one live copy, on one machine (VM). To work separately, fork it.

### Issues and TODOs

- **Issue:** where discussion happens.
- **TODO:** work the team has committed to, scheduled or in progress. A TODO is the first prompt given to the agent that implements it.

### Agents

- **App agent:** runs in the UI. It is fast, answers questions about the repository, and drives the app on the user's behalf.
- **Coding agent:** runs on a branch's machine. It is the factory that makes changes to that branch.

### Wiki

One source of truth for the factory's memory, stored as an Obsidian-compatible vault.

## The app

```
┌─────────────────────────────────────────────────────────┐
│ the branch's conversation (people prompt the agents)    │
│   ┌ card: diff ┐ ┌ card: run ┐ ┌ card: terminal ┐       │
│   └────────────┘ └───────────┘ └────────────────┘       │
│ background work: every running job, live, steerable     │
└─────────────────────────────────────────────────────────┘
```

- **Chat plus cards.** The agent shows its work as embedded cards: files, diffs, runs, terminals, wiki pages, and web pages.
- **Async work.** Start work, keep chatting, watch every running job, and step in when needed.
- **Terminal.** A terminal session on the branch's machine is another card. Run Claude Code, Codex, or any other tool there.

## Everything a user can do

1. **Branches:** create, fork, stack, and rebase (jj and the mythical stack).
2. **A checkout:** work with the coding agent on a branch's machine, open a terminal, and watch runs.
3. **The wiki:** read and edit the factory's memory.

Issues and TODOs connect these: discussion becomes a TODO, and a TODO becomes work on a branch.

## Scope rule

This overview defines the product. A feature it doesn't name is a candidate to delete or defer, decided one at a time.

## Details

Every detail this overview left open is decided in [mvp.md](mvp.md):

| Question | Where it is decided |
| --- | --- |
| When a TODO is done | M-01: its pull request merges into `main` on GitHub |
| Two writers editing one file | M-02: live co-editing; edits made outside the app are visible and recoverable (M-27) |
| What syncs with GitHub | §6.3 and M-22 |
| Self-improvement | M-04 and §6.12 |
| Permissions and approvals | M-05 and §6.15: Owner, Maintainer, Member; people merge |
| Machine sizing | M-06: derived from the detected host |
| Benchmark claims | M-19: none without a sealed, paired run |
| Smithers Cloud | M-09: after the MVP |
| Conversations | M-08: one per branch, shared |
| The old product spec | M-12: `docs/mvp/PRODUCT.md` is now a pointer |
