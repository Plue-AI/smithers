---
title: "Reach the network"
description: "Get a URL with fetch, post a body with http-post, render a page with webfetch, and search the web through a provider bound to the WebSearch service."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/guides/reach-the-network.md"
---

Four flows leave the machine, and they differ in what they promise. All of them
go through [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s `HttpClient`, so the permission
kernel sees the request.

| Flow        | Tier           | Capability   | Use it for                                            |
| ----------- | -------------- | ------------ | ----------------------------------------------------- |
| `fetch`     | `sealed`       | `net:get:*`  | A raw GET whose body you want as text.                |
| `webfetch`  | `sealed`       | `net:get:*`  | A page you want rendered as Markdown or plain text.   |
| `http-post` | `irreversible` | `net:post:*` | Sending data. The remote side may already have acted. |
| `websearch` | `sealed`       | `net:post:*` | A search through a configured provider.               |

## Get a URL

```ts
import * as Fetch from "@smthrs/std/Fetch"

const response = Fetch.run({
  url: "https://example.com/data.json",
  headers: { accept: "application/json" }
})
// response.status, response.body, response.truncated, response.notice
```

An error status is an ordinary value: a 500 comes back as `status: 500` with its
body. Only a transport failure, a permission refusal, or a body that exceeds the
cap uses the error channel.

The URL must be absolute `http` or `https` with no user information, or the call
fails with `invalid_input`. A response larger than 5 MiB fails with
`response_too_large` before decoding. The returned body is capped at 60,000
bytes, head first, and says so through `truncated` and `notice`.

## Post a body

```ts
import * as HttpPost from "@smthrs/std/HttpPost"

const response = HttpPost.run({
  url: "https://example.com/hooks/build",
  body: JSON.stringify({ ref: "main" }),
  contentType: "application/json"
})
```

`contentType` defaults to `application/json`. The body is sent verbatim. The
output shape and the limits match `fetch`.

This is the one network flow declared `irreversible`, which is what makes a
scheduler treat it as a real side effect rather than a retrievable read.

## Render a page

`webfetch` is for reading documentation rather than consuming an API:

```ts
import * as WebFetch from "@smthrs/std/WebFetch"

const page = WebFetch.run({
  url: "https://effect.website/docs",
  format: "markdown",
  timeout: 30
})
// page.url is the final URL after redirects
// page.status, page.contentType, page.content, page.truncated, page.notice
```

`format` is `markdown` (the default), `text`, or `html`. HTML is converted only
when the response is actually HTML; anything else is passed through as it
arrived.

Five behaviors are worth knowing:

- Up to 10 redirects are followed, and `page.url` is where it ended. Crossing an
  origin drops the `authorization` and `cookie` headers.
- A content type that is not `text/*` and carries neither `json` nor `xml` fails
  with `unsupported_content_type`. This flow renders text, not binaries.
- `timeout` is in seconds, defaults to 30, and is capped at 120. It bounds the
  request and the body read, and expiry is a `timeout` failure.
- A response past 5 MiB is `response_too_large`, checked against
  `content-length` first and then while reading.
- The rendered `content` keeps its first 60,000 bytes. A longer page sets
  `truncated: true` and a `notice` with the kept and total bytes.

## Search the web

`websearch` has no built-in provider. It calls the `WebSearch` service, so the
host decides who answers:

```ts
import * as WebSearch from "@smthrs/std/WebSearch"

const results = WebSearch.run({
  query: "effect schema optional fields",
  numResults: 5,
  freshness: "month"
})
// results.results: [{ title, url, snippet, publishedAt? }]
```

`numResults` is 1 through 20 and defaults to 8. `freshness` is `day`, `week`,
`month`, or `year`.

The package ships one provider. `ExaWebSearch.layer` reads its API key from a
named credential rather than from the environment:

```ts
import * as ExaWebSearch from "@smthrs/std/ExaWebSearch"

const provider = ExaWebSearch.layer("exa-api-key")
```

It needs [`@smthrs/control`](https://control.smithers.sh/reference/api/)'s `Credential` service and
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s `HttpClient`. It maps provider outcomes onto
the standard codes: a 429 or a refusal carrying `Retry-After` becomes `timeout`
with the advice in the message, a 401 or 403 becomes `provider_unavailable`, a
5xx becomes `provider_unavailable` naming the status, and any other non-2xx
becomes `request_failed`. Snippets are clipped at 2,000 characters, the
request is bounded at 30 seconds, and a response body over 5 MiB fails with
`response_too_large` before it is decoded.

A host with no provider binds `WebSearch.layerNoop`, and the call fails with
`provider_unavailable`.

`websearch` is not in `Manifest.readOnly`, because its provider contract
requires `net:post` authority, which is mutating under the kernel capability
taxonomy. A read-only tool surface gets `fetch` and `webfetch` instead.
