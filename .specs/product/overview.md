# Smithers product overview

Status: draft for Will's sign-off, 2026-10-02. High level only; details follow in separate specs.

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
│ chat with the app agent                                 │
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

## Details to specify next

- When a TODO is done: its GitHub pull request merges, or it lands on the forge's main.
- What happens when two writers on one branch edit the same file at once.
- GitHub wrapping: what syncs (refs, issues, pull requests) and how GitHub events reach a self-hosted machine.
- Self-improvement: what the factory learns from, and how changes to its flows are reviewed.
- Permissions and approvals on a shared branch.
- Machine sizing: how many branch VMs one host runs.
- The agent's benchmark results: which suite, which score, which artifacts.
- Smithers Cloud's role relative to self-hosting.
- Replacing `docs/mvp/PRODUCT.md` with this spec.
