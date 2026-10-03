---
"@smthrs/core": major
"@smthrs/agent": major
"@smthrs/std": major
"@smthrs/memory": major
"@smthrs/scorers": major
"@smthrs/fs": major
"@smthrs/evals": major
---

Remove `Flow.make(options)` and `Flow.MakeOptions`. Define executable flows with
`Flow.make(tag, { payload, success, error, body })` from `@smthrs/flow`, or use a
plain schema/metadata record for `FlowBinding`. Markdown lowering and metadata
projections remain available. The registry reports a typed `invalid_module`
refusal for retained modules that require the removed constructor.

Bound declarations now expose schema/metadata records rather than implicit
Core actions and executable wrappers. Filesystem invokers and evaluation
targets consume those records; memory policy inheritance retains their schemas.
