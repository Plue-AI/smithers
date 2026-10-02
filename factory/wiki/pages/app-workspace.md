# Smithers application

The application has a React browser renderer, served by `apps/server` or the retained local HTTP host. Native desktop distribution is outside the MVP.

## Code ownership

`apps/app/src/mainview` owns chat, embedded surfaces, the flow registry, controller and store. `apps/app/src/mainview/chain` owns browser persistence and replay recovery. `apps/app/src/bun` owns the authenticated local HTTP host. Repository work, terminals and language servers run in the workspace backend.

## Coding evidence

`apps/app/src/mainview/cards/CodingPlan.ts` derives the coding plan and outcome from recorded run evidence. The journal and persisted cursor remain authoritative.

## Verification

The app README distinguishes unit tests, browser tests and opt-in real chat. The default browser tests use isolated state and a chat stub. Real chat requires its separate lane; offline tests do not prove provider behavior.
