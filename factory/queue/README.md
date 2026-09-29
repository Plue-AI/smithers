# factory/queue/

Queued work lives in GitHub issues, not this legacy prompt inventory. Journal
consensus and store-fold specs are tracked in
[#2055](https://github.com/smithersai/smithers/issues/2055), with each retained
prompt linked to its child issue. A retained queue file must have an `issue:`
URL and `status: queued`; its presence does not register a Cloud job.

Start new work in GitHub and run it through the Smithers Cloud factory. Audit
old items against current code before scheduling. Reconcile this inventory in
[#1708](https://github.com/smithersai/smithers/issues/1708); Cloud intake and
execution belong to [#1695](https://github.com/smithersai/smithers/issues/1695).

