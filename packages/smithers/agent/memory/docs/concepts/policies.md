---
title: "Memory policies"
description: "The memory policy a flow tree inherits: four fields, attached as an annotation, enforced as a namespace allowlist, budget default, and two refusals."
sidebar:
  order: 3
---

A delegated plan generates work its author never named, so the memory settings that work runs under cannot be arguments threaded through every call. They are attached to the flow instead, as one annotation every flow in the tree inherits.

## The four fields

`WithMemory.Policy` has four fields:

| Field       | Values                     | Meaning                                       |
| ----------- | -------------------------- | --------------------------------------------- |
| `banks`     | nonempty `BankName[]`      | where memory this tree reads and writes lives |
| `recall`    | `"none"`, or absent        | `"none"` refuses recall                       |
| `maxTokens` | integer                    | the byte budget recall answers within         |
| `retain`    | `"on-complete"`, `"never"` | whether writes are kept                       |

## Attachment and inheritance

`WithMemory.withMemory(flow, policy)` returns a copy of `flow` carrying the policy, and gives the same policy to every flow that flow declares. The original is untouched, and every annotation the tree already carried comes across. A nested flow that already carries a policy is replaced by this one, so the tree runs under exactly one policy and the inherited answer is predictable. The policy is decoded and deeply frozen at that call, so an invalid policy throws a typed `MemoryError` at graph-build time rather than failing at a SQL constraint, and mutating the object afterwards changes nothing.

The annotation takes no part in flow identity. Applying a policy never changes the graph a flow plans, node for node, which is what makes it safe to attach after a flow is declared.

Only a flow whose collaborators are data, one declared with `flows: [...]` and no body, carries children a decorator can rewrite. A flow with a body reaches its collaborators by calling them, and those calls are graph nodes rather than a list, so `WithMemory.children` returns nothing for one. `WithMemory.references` is the wider view: it includes registry names the runtime has not resolved to a flow yet, which a policy carries through untouched.

## Namespace boundary, defaults, and refusals

The runtime bindings `Flows.runRecallFor` and `Flows.runRememberFor` read the policy back, and `Flows.handlersFor(flow)` is the pair a host binds. The policy banks are the only namespaces these scoped handlers may read or write:

- `runRecallFor` fills an empty `banks` list with all policy banks. Every explicit bank must resolve to a policy bank, matching both `kind` and `id`. A foreign bank fails the whole request with `invalid_namespace` before the recall service runs, including requests that mix allowed and foreign banks.
- `runRememberFor` resolves an empty bank to the first policy bank. An explicit foreign bank fails with `invalid_namespace` before the store runs.
- Equivalent spellings are allowed: `release-notes` and `flow-release-notes` both resolve to `{ kind: "flow", id: "release-notes" }`. Every bank in the policy is readable and writable; use a narrower policy for delegated work.
- `maxTokens` remains a default: the policy budget applies only when the caller omits it.

Two policy values short-circuit before bank validation or I/O:

- `recall: "none"` returns no rows and never reaches the recall service.
- `retain: "never"` drops the write. The caller still receives the key it asked for, and nothing reaches the store.

The boundary applies through `Flows.handlersFor` on a policy-carrying declaration, or through `runRecallFor` and `runRememberFor`. Given a declaration that carries no policy, these fail closed with `invalid_namespace` before any I/O. Bare handlers, direct `runRecall` / `runRemember` calls, recall services, and store methods do not enforce flow policies. Hosts must bind the scoped declarations for model-facing access.

For the binding mechanics, provenance, and the delegation case, see [Scope a flow tree to a namespace](../guides/scope-a-flow-tree.md).
