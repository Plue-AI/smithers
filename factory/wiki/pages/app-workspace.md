# Smithers application

The application has a React renderer and an Electrobun desktop host. Its browser build is served by `apps/server`.

## Code ownership

`apps/app/src/mainview` owns chat, embedded surfaces, the flow registry, controller and store. `apps/app/src/mainview/chain` owns browser persistence and replay recovery. `apps/app/src/bun` owns the native shell and authenticated local origin. Repository work, terminals and language servers run in the workspace backend.

## Coding interactions

The coding plan presentation lives in `apps/app/src/mainview/cards/CodingPlan.ts`. Read `apps/app/AGENTS.md` before changing interactions. The app README distinguishes unit tests, browser tests, and the separate opt-in real-harness tests; a test declaration alone does not prove a live run passed.
