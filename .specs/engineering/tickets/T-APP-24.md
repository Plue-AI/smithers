# T-APP-24 Settings HTTPS hint opens the quickstart page

Stage S2 · Size S · Depends on T-APP-20, T-APP-03 · Unblocks — · Issue: [#3642](https://github.com/smithersai/smithers/issues/3642)
Spec: spec.md §14.3 (Settings), §16.3.4 · Delta: delta.md §1 (HTTPS) · Product: mvp.md §6.1

## Goal

The Settings HTTPS hint opens the quickstart instructions through the existing docs dispatcher.

## Scope

In:
- Bind `notifications_need_https`, shown on plain HTTP at a non-localhost origin, through the existing SettingsContainer.

Out:
- Changes to the frozen T-APP-20 ticket, notification permission policy and new Views.

## Changes

- Dispatch `/docs` with `{page: "quickstart#put-https-in-front"}` when the member presses the Settings hint.

## Tests

- e2e (`apps/app/e2e/playwright/docs.spec.ts`, T-APP-20's): on a plain-HTTP, non-localhost origin, pressing "Notifications need HTTPS ↗" in Settings dispatches `/docs` with exactly `{page: "quickstart#put-https-in-front"}` and lands on the "Put HTTPS in front" heading.

## Acceptance
- [C-UI-09](../checks/C-UI-09.md): passes for this ticket’s phase at its stated layer.

- The Settings hint opens the quickstart's "Put HTTPS in front" heading.

## Risks and notes

- Owner: smithers-b8. Follow-up of frozen T-APP-20.

## Ready checklist

1. T-APP-20 supplies SettingsContainer and the hint; T-APP-03 supplies the docs dispatcher.
2. Out excludes notification policy and new Views.
3. The test uses the production SettingsContainer and docs dispatcher with the literal page `quickstart#put-https-in-front`.
4. smithers-b8 accepts the dispatcher binding.
5. Record smithers-b8 pre-review before start.
6. The binding dispatches a packaged docs action and executes no repository code.
