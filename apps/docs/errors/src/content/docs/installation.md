---
title: "Installation"
description: "Install @smthrs/errors and import it from the root entry point or a module subpath."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/installation.md"
---

`@smthrs/errors` is Effect-independent and adds no runtime dependencies.

## Add the dependency

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

```json
{
  "dependencies": {
    "@smthrs/errors": "1.0.0-rc.1"
  }
}
```

The package has no runtime dependencies. Its only requirement is Node.js
26.4.0 or later, declared in `engines`.

## Import it

The root entry point exports everything:

```ts
import {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  hasSmithersErrorShape,
  isSmithersError,
  isSmithersErrorCode,
  SmithersError,
  type SmithersErrorCode,
  smithersErrorCodes,
  type SmithersErrorDefinition,
  smithersErrorDefinitions,
  type SmithersErrorOptions
} from "@smthrs/errors"
```

Each of the two modules is also importable on its own, which is the form
`@smthrs/integrations` uses so a file pulls in only the module it names:

```ts
import { isSmithersErrorCode, smithersErrorDefinitions } from "@smthrs/errors/ErrorCode"
import { hasSmithersErrorShape, SmithersError } from "@smthrs/errors/SmithersError"
```

`@smthrs/errors/package.json` is exported. `@smthrs/errors/internal/*` and
`@smthrs/errors/*/index` are not: both resolve to `null` in the exports map, so
a deep import fails at resolution rather than compiling against a private path.

The published build ships ESM at `dist/esm` and CommonJS at `dist/cjs`. The
entry points expose the same API but have distinct constructor identities.
Mixed ESM/CommonJS loading is a module-copy boundary, even with one installed
package version: an error created through `require` fails the `isSmithersError`
check from `import`, and vice versa. Use `hasSmithersErrorShape` across this
boundary. See
[Detect an error across module copies](/guides/detect-an-error-across-module-copies/).

## Choose this package or a tagged error

Reach for `SmithersError` only when you are writing an integration adapter that
talks to a third-party API. Everywhere else in Smithers, state a failure as a
`Schema.TaggedError` class on the effect that can fail. There is no single
error registry, and [The closed code vocabulary](/concepts/error-codes/)
explains the reasoning.

## Verify the install

Import the code table and print it. The five codes and their order are fixed,
so this output is the same on every install:

```ts
import { smithersErrorCodes } from "@smthrs/errors"

console.log(smithersErrorCodes)
// [ "INVALID_INPUT", "INTEGRATION_ERROR", "TELEGRAM_API_ERROR", "TELEGRAM_INIT_DATA_INVALID", "UNSUPPORTED" ]
```
