# T-APP-18 Browser notifications on secure origins

Stage S2 · Size S · Depends on T-APP-07, T-UI-08, T-CAT-01 · Unblocks T-REL-02 · Issue: [#3558](https://github.com/smithersai/smithers/issues/3558)
Spec: spec.md §14.6, §14.4.1, §16.3.2 · Delta: delta.md §9 · Product: mvp.md §6.4 Browser notifications (v2.5), Appendix B.1 `notifications.allow`
Ready: 2026-10-03 smithers-8a sha256:d93ce26dfe3d

## Goal
A member with Smithers in a background tab is notified by the browser when a TODO of theirs needs them, is ready for review or fails.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the Allow notifications toast variant, with the CSS, in T-UI-08. This ticket builds no View, CSS or editor presentation. It enables Notification API delivery from the existing toast controller, secure-context detection and the Allow action on the first Needs you toast. smithers-b8 decides the controller and person-only dispatcher integration; smithers-06 decides the supplied Allow variant and gesture seam. Any public TypeScript API change requires smithers-38 approval; this ticket adds none.

## Scope
In:
- `notifications.allow`: a person-only in-card gesture on the first Needs you toast, calling `Notification.requestPermission()`.
- A notification for each toast of kind Needs you, In review or Failed that targets this member (§14.4.1) while `document.hidden`.
- Click focuses the tab and opens the card.
- Detecting secure contexts: on a plain-HTTP origin, no Allow toast and no notifications.
- Land dark against the specified contracts of T-APP-07, T-UI-08 and T-CAT-01. Until their routed member toasts, Allow variant and person-only catalog enforcement are available and the tests below pass together, hide Allow and disable browser delivery; refuse unavailable action dispatch without requesting permission. Missing dependencies do not block the dark merge.

Out:
- Email and phone ([D], #3423).
- Service workers and Web Push.
- Notification center, inbox read/tag controls and a second notice collection.
- Settings HTTPS hint and docs link (T-APP-24), HTTPS configuration, backend event routing and toast presentation (T-APP-07, T-UI-08).
- Repository flow execution, machine provisioning, root steps and new public TypeScript APIs.

## Changes
- Enable delivery in `apps/app/src/mainview/state/controller/failures.ts`, reusing T-APP-07's member-routed entry toasts and existing controller lifecycle. Keep the shared collection and 300 ms debounce. Reuse `state/RepositoryNotifications.ts` where its existing notice processing applies; its issue/PR inbox rows are not the TODO audience authority. No new notifications controller or collection.
- Extend the existing `apps/app/src/mainview/flows/entries/toast.ts` block, registered by `flows/Flows.ts`, with the `notifications.allow` descriptor through T-CAT-01's catalog (`agent: never`, person-only, in-card). `flows/entries/notifications.ts` no longer exists; do not recreate the retired center. Request permission in the actual gesture's synchronous dispatch path, before any await, with no automatic, preload or agent request.
- Bind the existing Allow variant through `apps/app/src/mainview/ToastStack.tsx`; T-UI-08 supplies presentation and T-APP-07 folds its View into this file. Add no View or CSS.
- For hidden, permitted tabs with the Notification API available, deliver Needs you, In review and Failed entries for the current member. Use the existing actor label and entry title as plain text. Track delivered entry ids for the active member/controller so repeated updates cannot construct a second notification; `tag` alone is not deduplication. Click uses the existing card-opening action and focuses the tab. Close notifications and release subscriptions on disposal or member change. Unavailable APIs and denied permission leave ordinary toasts usable.
## Tests
- Unit (`notifications.test.ts`): a hidden tab with permission granted gets one notification per entry. A visible tab gets none, and a plain-HTTP context (`isSecureContext = false`) offers no Allow and raises nothing.
- Unit (`ToastStack.test.tsx`): the Allow action appears on the first Needs you toast only on a secure context with permission `default`.
- Dispatcher integration (`apps/app/src/mainview/flows/Commands.test.ts`): build the production app controller and command registry, invoke the rendered Allow button through its real action binding, and assert one permission request before the first async boundary. `commands.toolSpecs()` excludes the literal `notifications.allow`; explicit `commands.runAsAgent("notifications.allow")`, automatic dispatch and preload request no permission. Denied, unsupported and dark dependency cases leave toasts usable and make zero browser API calls.
- Controller integration (`apps/app/src/mainview/state/controller/failures.test.ts`): feed literal member-routed entries through the production store/controller subscription, not a notification helper. Repeated updates construct one notification per entry; another member's entry constructs none. Member switch and disposal stop delivery and close existing notifications.
- All expectations are committed literal fixtures and counts; tests read no spec Markdown and derive no expected policy from runtime production code.
- Playwright (`apps/app/e2e/playwright/notifications.spec.ts`, new; Chromium and WebKit; Ben owns TODO T3 on `http://localhost:4000` and on a plain-HTTP LAN origin):
  - On localhost, T3's first Needs you shows the Allow action once, and the permission prompt appears from that click and never without one.
  - With the tab hidden, a second question on T3, T3 reaching In review and a failed retry of another TODO Ben owns raise exactly three notifications (Needs you, In review, Failed), one per entry; none repeats.
  - Clicking the In review notification focuses the tab and opens T3's card.
  - No notification fires while the tab is visible.
  - On the plain-HTTP origin the toasts appear, no Allow action shows, no notification is raised or attempted, and the console has no error.

## Acceptance
- [C-UI-03](../checks/C-UI-03.md): folded into this ticket’s unit, dispatcher/controller integration and Playwright cases above; those tests supply the passing evidence.
- [C-UI-13](../checks/C-UI-13.md): passes for this ticket’s phase at its stated layer.
- The notifications spec passes in Chromium and WebKit on both origins.

## Risks and notes
- Risk: Safari requires the permission request inside the click handler itself. Confirm in the Playwright WebKit project through the rendered button and production dispatcher. smithers-b8 approves the synchronous gesture seam; smithers-06 approves the existing variant binding. A test adapter may record Notification calls where browser automation cannot expose OS notifications, but must wrap only the browser API, never bypass the dispatcher or live event path; smithers-b8 approves that seam.
- Security: shipped browser code consumes member-routed entry data as plain text and navigates existing cards. It executes no repository code and has no root step or root inputs. Repository checks used to generate e2e events run only in machines under spec.md §1.3 (M-29); smithers-b8 reviews the person-only boundary and confirms this ticket introduces no host execution path. The dispatcher tests above prove agents and automatic triggers cannot request permission.

## Ready checklist
1. Dependencies: T-APP-07 supplies routed member entries and card actions, T-UI-08 supplies Allow presentation, and T-CAT-01 supplies person-only catalog enforcement; Scope keeps all unavailable integrations dark until joint tests pass.
2. Exclusions: no email/phone, push, service worker, notification center, second collection, Settings/docs work, presentation, provisioning, repository execution or public API expansion.
3. Boundaries: rendered Allow → production dispatcher, live entries → production store/controller, and Playwright tab/card interactions; literal fixtures supply expectations independently of spec and implementation.
4. Decisions: smithers-b8 accepts controller, dispatcher and browser-test seams; smithers-06 accepts the Allow presentation binding; smithers-38 approves any public TypeScript API diff before it enters scope.
5. Owner pre-review (post hoc under Will’s parallel-build directive): smithers-b8: Does the real click dispatch request permission before any await? Do audience filtering, deduplication and disposal use the shared controller? Does the browser adapter preserve the production event and action paths? smithers-06: Does the binding reuse the supplied Allow variant without new markup or CSS? Does the first Needs you show only one permission action?
6. Security: smithers-b8 reviews person-only dispatch and plain-text notice data; no repository execution or root step is added, so root-input inventory is empty; e2e repository checks stay in machines (M-29), and dispatcher tests reject non-person permission requests.
