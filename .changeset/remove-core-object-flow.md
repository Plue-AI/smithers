---
"@smthrs/core": major
"@smthrs/agent": major
"@smthrs/std": major
"@smthrs/memory": major
"@smthrs/scorers": major
"@smthrs/fs": major
"@smthrs/evals": major
"@smthrs/registry": major
"@smthrs/harness": patch
---

Remove `Flow.make(options)` and `Flow.MakeOptions`. Define executable flows with
`Flow.make(tag, { payload, success, error, body })` from `@smthrs/flow`, or use a
plain schema/metadata record for `FlowBinding`. Markdown lowering and metadata
projections remain available. The registry reports a typed `invalid_module`
refusal for retained modules that require the removed constructor.

Bound declarations now expose schema/metadata records rather than implicit
Core actions and executable wrappers. Filesystem invokers and evaluation
targets consume those records; memory policy inheritance retains their schemas.

This public removal follows RELEASE_SUPPORT.md (§21.1 item 8). The metadata
`Flow.isFlow` and `Flow.TypeId` exports remain for Markdown lowering.

```ts
// Before
import { Flow } from "@smthrs/core"
export default Flow.make({ name: "hello", input, output, capabilities: [], effects })
// After
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
export default { name: "hello", input, output, capabilities: [], effects } satisfies FlowBinding.Declared
```

RC releases carry no stability commitment ([RELEASE_SUPPORT.md (MVP compatibility changes)](../RELEASE_SUPPORT.md#mvp-compatibility-changes)).
