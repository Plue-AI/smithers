# Smithers application

The application has a React renderer and an Electrobun desktop host. Its browser build is served by `apps/server`.

## Code ownership

`apps/app/src/mainview` owns chat, embedded surfaces, the flow registry, controller and store. `apps/app/src/mainview/chain` owns browser persistence and replay recovery. `apps/app/src/bun` owns the native shell and authenticated local origin. Repository work, terminals and language servers run in the workspace backend.

## Coding evidence

`apps/app/src/mainview/cards/CodingPlan.ts` derives the coding plan and outcome from recorded run evidence. The journal and persisted cursor remain authoritative.

## Verification

The app README distinguishes unit tests, browser tests, opt-in real chat, and packaged native tests. The default browser tests use isolated state and a chat stub. Real chat and packaged native testing require their separate lanes.
