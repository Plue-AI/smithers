# C-MCH-10 Tool logins persist per machine; tokens never copy

Proves: mvp.md §6.8 Terminals, J6.1 · spec.md §8.7.2, §8.7.3 · Layer: integration · Stage: S2 · Tickets: T-MCH-11
Automation: `packages/backend/microsandbox/real_credentials_test.go` (new) · Runs in: reference mini, two real microVMs with fixture tool logins

## Setup
Ben and Alice have private homes on machines A and B. Fixture tools write distinct login sentinels on each machine. Use no live tokens; C-REL-05 owns the live soak.

## Steps
1. As Ben, create fixture Claude Code, Codex and `gh` login files on A. Start Ben's first session on B and inspect its home.
2. Log in independently on B with different sentinels. Sleep and wake each machine; restart the host; read each machine's files as Ben.
3. Refresh a login on A, then log out on A. Read B's files after each change and after B sleeps and wakes.
4. Attempt to read Ben's files as Alice and `agent`. Inspect host database rows, daemon events and API responses for the fixture bytes.
5. Recreate A from a new recipe and inspect its new home before Ben logs in.

## Pass when
- Step 1: B has no A login files or sentinel bytes.
- Step 2: each machine retains exactly its own login files across sleep, wake and host restart.
- Step 3: B's login files remain unchanged. A's logout affects A alone.
- Step 4: other users cannot read Ben's files; host database rows, events and responses contain no tool token bytes.
- Step 5: the new home is empty; Smithers restores no login from another machine or a host store.

## Fail when
- Smithers stores or copies a tool token outside its machine, or local login files disappear after sleep and wake.

## Evidence
`.artifacts/checks/C-MCH-10/<ts>/`: redacted per-machine file digests, denied reads, event and database scan results, host profile and commit.
