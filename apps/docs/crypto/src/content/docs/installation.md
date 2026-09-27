---
title: "Installation"
description: "Install @smthrs/crypto, its runtime requirements, its import forms, and the Crypto services that satisfy the digest entry point."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/crypto/docs/installation.md"
---

## Install the package

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

The package ships as both ESM and CommonJS with TypeScript declarations. Its
only runtime dependency is [`effect`](https://effect.website).

## Runtime requirements

- Node.js 26.4.0 or later, as declared in `engines`.
- A global `TextEncoder`. Text hashing calls it directly, so it is a host
  prerequisite rather than an injected service. Supported Node, Bun, and
  modern browser targets provide it, and compatible worker and edge runtimes
  generally do too.
- An Effect `Crypto` service, for `digest` only. The next section lists the
  implementations you can provide.

The package imports no `node:` built-in, so it bundles for a browser
unchanged.

## Import forms

The root entry point re-exports every public name:

```ts
import { Digest, digest, digestSync, Sha256, Sha256Error, syncCrypto } from "@smthrs/crypto"
```

The single module is also importable from its own subpath, which keeps the
namespace explicit at every call site:

```ts
import * as Sha256 from "@smthrs/crypto/Sha256"
```

Two subpath forms are not public and are blocked in the export map:
`@smthrs/crypto/internal/*` and `@smthrs/crypto/*/index`. The handwritten
implementation lives behind the first of those on purpose.
`@smthrs/crypto/package.json` is exported.

A program that already depends on [`@smthrs/flows`](https://flows.smithers.sh/reference/api/) reaches the
same module as a namespace, with no second dependency:

```ts
import { Crypto } from "@smthrs/flows"

const address = Crypto.digestSync("hello")
```

## Provide a Crypto service

`digest` returns an Effect that requires `Crypto.Crypto`. Choose the
implementation that matches where the code runs:

| Implementation                           | Provide it with                                    | Use it for                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@effect/platform-node/NodeCrypto`       | `NodeCrypto.layer`                                 | A Node process. [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) re-exports it as `NodeHost.NodeCrypto`.                                               |
| `@effect/platform-bun/BunCrypto`         | `BunCrypto.layer`                                  | A Bun process.                                                                                                                                      |
| `@effect/platform-browser/BrowserCrypto` | The layer that module exports                      | A browser tab. Add `@effect/platform-browser` yourself: [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) leaves `Crypto` out of its host bundle. |
| `syncCrypto` from this package           | `Effect.provideService(Crypto.Crypto, syncCrypto)` | Synchronous code and tests. It answers SHA-256 only and refuses randomness.                                                                         |
| Your own                                 | `Crypto.make({ randomBytes, digest })`             | A custom host, a hardware module, or a fault-injecting test.                                                                                        |

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { digest } from "@smthrs/crypto"
import { Effect } from "effect"

const program = digest("hello").pipe(Effect.provide(NodeCrypto.layer))
```

`digestSync`, `Digest`, and `Sha256Error` need no service at all. `digestSync`
uses the package's own implementation, and `Digest` validates a value without
hashing anything.

Provide a real platform service in production. `syncCrypto` exists for
synchronous callers that already speak the `Crypto` interface, and it refuses
randomness rather than returning weak bytes, so it is not a general
replacement for a platform layer.

## Next step

Hash a value and validate it on the way back in the
[Quickstart](/quickstart/).
