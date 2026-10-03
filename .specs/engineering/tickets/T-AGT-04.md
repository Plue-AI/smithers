# T-AGT-04 Internal /ceo repository flow dogfood

Stage M · Size S · Depends on T-APP-05, T-FLW-01 · Unblocks — · Issue: [#3631](https://github.com/smithersai/smithers/issues/3631)
Spec: spec.md §11, §14.2.1 · Delta: delta.md §9 · Product: mvp.md M-38, M-34

## Goal

Build the internal /ceo brief on the install after stage 1 as dogfood of custom flow UI.

## Ownership

Internal repository-flow owner assigned when product forwards references.

## Scope

In:
- A repository flow using shared components. Input is a6's prototype README and CEO-FLOW.md when product forwards them.

Out:
- Product surfaces beyond M-38.

## Changes

- Read the forwarded documents as references; do not port prototype code or invent their contents.
- Implement an internal repository flow against installed APIs and shared components.
- Keep /ceo out of shipped catalog, default navigation and product API surfaces.

## Tests

- Repository-local dogfood smoke: load the flow, run a representative brief and inspect shared component output. Record the concrete command and evidence when references arrive.

## Acceptance

The internal brief runs on the install as a repository flow. No product route, command or component is added.

## Risks and notes

- Low priority, stage M after S1. Blocks no MVP ticket or stage gate. Reference delivery is a readiness condition. No MVP check is added.
