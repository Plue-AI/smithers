---
title: "Installation"
description: "Install @smthrs/sync, choose an import form, and add the journal, run catalog, and transport that a serving composition needs."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/installation.md"
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Requirements

- Node.js 26.4.0 or later, or a browser with Web Crypto. The signing paths
  call `crypto.subtle` directly so one module serves both.
- `effect` exactly at the version the package declares. It is a peer dependency
  so the follower and Smithers use one runtime.
- [`@smthrs/journal`](https://journal.smithers.sh/reference/api/), also a direct dependency. The entry
  envelope every frame carries is the journal's `JournalEvent.Entry`.

## Import forms

The root is browser safe and re-exports every namespace:

```ts
import { RunCatalog, SyncClient, SyncServer } from "@smthrs/sync"
```

Every module is also importable on its own path, which is what a bundler
targeting a browser wants because it leaves the server modules out:

```ts
import * as SyncClient from "@smthrs/sync/SyncClient"
import * as SyncProtocol from "@smthrs/sync/SyncProtocol"
```

The two test doubles live under `test/` subpaths and are documented in
[Test a follower](/guides/test-a-follower/):

```ts
import * as TestSocket from "@smthrs/sync/test/TestSocket"
import * as TestSync from "@smthrs/sync/test/TestSync"
```

`@smthrs/sync/test/TestSync` binds the Node SQLite test journal, so it is a
Node-only import. `@smthrs/sync/test/TestSocket` is an in-memory socket pair
and runs anywhere. Install the optional SQLite driver when using `TestSync`:

```bash
pnpm add @effect/sql-sqlite-node@4.0.0-rc.115
```

`@smthrs/sync/internal/*` is not exported. A path under it fails to resolve.

## What a follower adds

A follower needs a transport. `SyncClient.layer` derives its RPC client from
`RpcClient.Protocol`, so the composition supplies the protocol and the
serialization:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

A browser follower needs no extra package: the WebSocket protocol and the JSON
serialization both come from `effect/unstable/rpc`.

## What a server adds

Serving the read path requires a real journal and a run catalog:

- [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) supplies `Journal`. Its production layer,
  `SqlJournal`, sits above [`@smthrs/database`](https://database.smithers.sh/reference/api/), so a serving
  host installs a database driver and the journal migrations too.
- `RunCatalog` is supplied by the host. `RunCatalog.layerStatic` covers a fixed
  set. [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) supplies `RunCatalogRead`,
  the durable read a polling catalog uses so a follower learns of runs another
  engine created. See [List a workspace's runs](/guides/list-workspace-runs/).
- A transport mounts the RPC group. [`@smthrs/gateway`](https://gateway.smithers.sh/reference/api/) already
  does it, on `POST /sync` and `/sync/ws`.

Authorization is a separate decision with its own dependency: `SyncAuth.layer`
requires a `WorkspaceShare` authority, and `WorkspaceShare.layerConfig` reads
its secret from the environment. See
[Authorize a connection](/guides/authorize-a-connection/).

## Next steps

- [Quickstart](/quickstart/) runs a follower end to end with no transport
  and no database of your own.
- [Serve the read path](/guides/serve-the-read-path/) composes the server
  side against a real journal.
