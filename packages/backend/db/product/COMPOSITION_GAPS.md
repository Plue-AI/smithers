# Product database composition boundary

`migrate` installs the product schema only. Tables classified as private or
retired in `../ownership.csv` are absent from a fresh self-host database.
The public module contains no private schema, private generated queries, or
cloud SDK implementation.

Plue supplies the fleet and storage collaborators through `app.Config` and the
exported ports. Its private migration lineage and `plue_private_revisions`
ledger are independent of the product migration ledger.

Repository provisioning follows the same boundary: the exported `provisioning`
contract describes the operation, Plue owns the placement journal and mutation
fence, and the shared product helper publishes canonical repository state
inside the adapter's transaction. Self-hosting uses the product journal.
Missing required collaborators fail at the composition or operation seam.

Product queries and models generate into `internal/db` from this directory's
`sqlc.yaml`. Private adapters call exported product stores instead of copying
product SQL. `productstore.ConfigureTypes` registers canonical product codecs
on deployment-owned PostgreSQL pools.

A store a deployment supplies in `ports.RuntimeStores` embeds
`productstore.Product`. Services skip a feature when that store lacks a
capability they type-assert, so `Product` carries every product capability
asserted on those stores. `TestRuntimeStoreAssertionsAreClassified` in
`internal/services` fails on an assertion that is neither on `Product` nor
listed as deployment-owned with a reason.

`CountPrivateReposByOwner` and storage-byte queries measure product allocations.
Private admission usage (`admission.Usage`) adds its pending infrastructure
allocations, including reserved but unpublished private repositories. Product code must not query those private tables directly.

`scripts/check-go-boundaries.py` enforces the SQL and import boundary; its
negative tests deliberately insert private-table queries and dependencies.
