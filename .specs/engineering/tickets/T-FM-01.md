# T-FM-01 Install: fast model through the Smithers sign-in, key fallback and quota display

Stage S2 · Size M · Depends on T-INS-06, T-FLW-08 · Unblocks —
Spec: spec.md §11.5a, §11.5b.1, §11.5b.3, §11.5b.4, §16.2 step 5, §17.4, §17.4a · Product: mvp.md §12 item 5, Models row (Will 2026-10-03, cdbc5a646f)

Added 2026-10-06 by smithers-8a. Stage S2: the team-key path alone passes J1 in stage 1 (8a staging ruling).

## Goal
The owner signs the install in to Smithers for the fast model during setup or in Settings. The host model proxy routes fast-model calls through the gateway with that credential and falls back to the team key or the coding model on quota, refusal or outage, without blocking a turn.

## Scope
In: the setup `models` step choice (sign-in default, key optional) and Settings source and quota line; the browser sign-in returning a per-install credential; sealed storage beside provider keys; routing in the host model proxy; the fallback order (gateway, team key, coding model) with a typed cause; sign-out deleting the credential; the §17.4a disclosure copy beside the sign-in.
Out: the gateway itself (T-FM-02); any card or billing step; coding-model or Decisions routing changes; machines or flows holding the credential.

## Changes
- Reshape the existing host model proxy (`packages/backend/modelproxy` client side, §8.8.3) to add the gateway as a fast-model source; no second proxy.
- Reshape the setup `models` step and Settings models rows (T-INS-06 / T-FLW-08 surfaces); design (smithers-06) supplies the sign-in row and the disclosure line.
- Store the credential as a sealed `install_settings` value like provider keys (§17.4).

## Decisions and pre-review
- smithers-3f approves credential storage and the proxy change; smithers-06 supplies the rows and disclosure copy; smithers-b8 owns the app binding.

## Tests

C-FM-01:
1. Setup with sign-in against a fake gateway: credential sealed; `GET /api/install` and logs never return it; a fast-model call carries it from the host only.
2. Fake gateway returns `capacity`: the next call uses the team key if set, else the coding model; Settings shows the quota line and reset time.
3. Gateway unreachable, and credential refused: same fallback, with the cause shown; the turn completes.
4. Sign out: credential deleted; the next fast-model call uses the fallback.
5. A machine, a flow and the browser each try to read the credential.

Pass when:
- Steps 1-4 behave as stated with literal fixtures. Step 5 finds no path to the credential.
- No setup screen asks for a card or shows billing.

## Acceptance
- [C-FM-01](../checks/C-FM-01.md)

## Risks and notes
- The key path alone passes J1 in stage 1; this ticket must not regress it (C-J1-04 stays green).
