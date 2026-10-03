# T-APP-24 Settings HTTPS hint opens the quickstart page

Stage S2 · Size S · Depends on T-APP-20, T-APP-03 · Unblocks — · Issue: [#3642](https://github.com/smithersai/smithers/issues/3642)
Spec: spec.md §14.2.1, §14.3 (Settings), §14.6, §16.3.4 · Delta: delta.md §1 (HTTPS), §9 (card binding) · Product: mvp.md §6.1, §6.4 (browser notifications)
Ready: 2026-10-03 smithers-8a sha256:154b2ff6c2b7

## Goal

The Settings HTTPS hint opens the quickstart instructions through the existing docs dispatcher.

## Scope

In:
- Bind `notifications_need_https`, shown on plain HTTP at a non-localhost origin, through the existing SettingsContainer.
- Land dark against T-APP-03’s Settings contract and T-APP-20’s bundled docs contract. Until Settings is mounted and the docs catalog entry, quickstart page and `put-https-in-front` anchor are available, expose no clickable docs action and refuse unavailable dispatch. Keep the existing hint text. Enable the binding only after C-UI-09’s tests below pass. No dependency needs to have landed before implementation.

Out:
- Changes to the frozen T-APP-20 ticket, notification permission policy or delivery (T-APP-18), new Views or RPC schemas, docs loading or routing, quickstart content (T-DOC-01), and TLS, Tailscale or Caddy installation or configuration.

## Changes

- Reshape `apps/app/src/mainview/cards/SettingsContainer.tsx`: reuse `state/seams/InstallModel.ts`’s origin predicate and `flows/cardActions.ts` to bind catalog tag `docs` with args and command input `{page: "quickstart#put-https-in-front"}`. Reuse `cards/views/SettingsView.tsx`’s existing notifications row and T-APP-20’s dispatcher. Add no second navigation path, View or origin predicate.

## Tests

- e2e (`apps/app/e2e/playwright/docs.spec.ts`, planned by T-APP-20; C-UI-09): open `/settings` as the owner through the production dispatcher and `CardRenderers`, then activate "Notifications need HTTPS ↗" by click and keyboard on a plain-HTTP, non-localhost origin. Observe the production `docs` dispatch with exactly `{page: "quickstart#put-https-in-front"}` and the visible "Put HTTPS in front" heading in the Docs card. Keep the real dispatcher, bundled loader and renderer; do not replace them with stubs.
- e2e (same file; C-UI-09): HTTPS and HTTP loopback origins (`localhost`, `127.0.0.1`, `[::1]`) show no hint or docs action. A non-owner cannot open the owner-only Settings card. With either dependency unavailable, no clickable hint or docs dispatch succeeds; Chat remains usable. Use literal fixture expectations, never expectations read from the spec, toc or production implementation at runtime.

## Acceptance
- [C-UI-09](../checks/C-UI-09.md): passes for this ticket’s phase at its stated layer.

- The Settings hint opens the quickstart's "Put HTTPS in front" heading.

## Risks and notes

- Owner: smithers-b8 accepts the catalog binding and dark activation condition; smithers-06 accepts the existing View action contract. Record their review in #3642. Under Will’s parallel-build directive, owner review is post hoc and does not block starting against the specified contracts. Follow-up of frozen T-APP-20.
- This UI-only action reads installed, bundled docs. It executes no repository code, runs no root step and consumes no root inputs. Do not fetch or execute branch content or run the quickstart’s commands. smithers-b8 reviews this boundary; C-UI-09 exercises the packaged docs path.

## Ready checklist

1. Depends on T-APP-03 for mounted owner-only Settings and T-APP-20 for the catalog dispatcher, bundled quickstart and anchor; Scope keeps unavailable integrations dark and fail-closed. No later-stage dependency is added.
2. Out explicitly excludes notification policy and delivery, Views, schemas, docs infrastructure and content, and HTTPS or proxy setup.
3. C-UI-09 runs the Settings hint through the production dispatcher, CardRenderers and bundled Docs renderer, with literal payload, heading, origin and unavailable-provider expectations.
4. smithers-b8 decides binding and activation; smithers-06 decides View contract compatibility. No public API or ADR change is authorized.
5. Owner pre-review questions, recorded in #3642 with post hoc review permitted by Will’s directive: smithers-b8: Does the binding use the existing typed docs dispatcher? Does unavailable Settings or bundled docs fail closed? smithers-06: Does the existing notifications row provide click and keyboard activation without View changes?
6. smithers-b8 reviews the packaged, UI-only docs boundary; no repository code executes, no root step exists and there are no root inputs. C-UI-09 verifies navigation through the bundled docs path.
