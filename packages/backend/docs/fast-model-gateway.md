# Fast-model gateway

The gateway lives in the public `modelproxy` and `credits` packages. The
shared backend mounts it when `app.Config.FastGateway` is supplied. Plue's
private hosting composition supplies the Cerebras key and quota; the shared
composition supplies PostgreSQL and migrations. An ordinary install leaves
this option nil and calls the hosted service through its fast-model source.

```go
app.Config{
    FastGateway: &modelproxy.FastGateway{
        Keys: modelproxy.NewStaticKeys(map[string]string{
            modelproxy.ProviderCerebras: platformCerebrasKey,
        }),
        Quota: credits.FastQuota{DailyTokens: 100_000},
        Models: []string{"gpt-oss-120b"},
    },
}
```

`100_000` tokens per install per UTC day is the conservative default, not a
measured cost claim. Replace it with twice the p90 daily tokens over seven
UTC days of dogfood once T-FM-01 runs on the owner's install. No payment,
plan, card or monetary credit is required.

After Smithers sign-in, `POST /api/fast-model/installs` with
`{"install_id":"<UUID>"}` returns `install_id`, `credential`, `daily_tokens`
and `reset_at`. Issuance requires a host-side user bearer credential with `write:user` after
sign-in. Browser cookie auth, requests carrying an Origin, and system-issued
or delegated agent credentials cannot issue an install credential.
The install seals the returned credential server-side; browser sign-in must
hand it to the host, never expose it to machines or flows. Reissuing rotates
the credential. Only its issuing owner may rotate or revoke it, using
`DELETE /api/fast-model/installs/<UUID>`. Signing out deletes the local sealed value; the owner may revoke a gateway
credential independently. The gateway stores only the SHA-256 credential digest.

The install's existing PKCE sign-in now reaches the composed gateway:
`GET /api/fast-model/sign-in` requires the install ID, S256 challenge,
callback and state. It uses the existing Smithers browser login and an explicit
CSRF-bound **Sign in** confirmation. Only an authorization code returns through
the browser. The host posts `code`, `code_verifier` and `redirect_uri` to
`/api/fast-model/exchange` and seals the returned credential. Exchanges carrying
an Origin are refused. Grants reuse the existing OAuth code table, PKCE
verifier and atomic consume query, under a fixed internal fast-model client
which the ordinary OAuth token endpoint refuses. No user access token is issued.

The install retains `models.smithers.install_id` across sign-out so signing
back in rotates its credential without resetting spent daily tokens. The
install's browser callback stays `/api/model/fast/return`.

The host sends `Authorization: Bearer <credential>` to the following routes.
`X-Smithers-Install-ID` is optional; when supplied it must match the credential's
install. The gateway otherwise resolves the install from the stored digest:

- `POST /api/fast-model/v1/chat/completions`, the Cerebras chat-completions protocol.
- `GET /api/fast-model/quota`, returning `remaining_tokens`, `daily_tokens`, `reset_at`.

The gateway serves only configured fast model IDs, defaulting to
`gpt-oss-120b`. Coding and Decisions provider routes are absent. It reuses
modelproxy's request bounding, output ceiling, stream usage extraction and
upstream forwarding. Redirects cannot forward the platform key. A streaming
redactor also removes a key echoed by the upstream across write boundaries.
Neither the install credential nor the install ID is forwarded to Cerebras.

Admission locks the install row and reserves the request's token bound in
`fast_model_counts` before calling upstream. Concurrent calls count pending
reservations. Successful calls settle to reported token counts; a definite
failure settles to zero; ambiguous or interrupted calls retain their bound.
A pending reservation survives process loss and counts until its UTC day
ends. Credential revocation is rechecked under the admission lock.

A bound that does not fit returns HTTP 429 with `Retry-After` and:

```json
{"error":{"type":"capacity","code":"capacity","message":"Daily Smithers quota used.","reset_at":"2026-10-08T00:00:00Z"}}
```

`GET /api/admin/fast-model/daily-totals?from=2026-10-01&until=2026-10-08`
requires a signed-in administrator and exports JSON rows with only
`install`, `day` (UTC) and `tokens`. `until` is exclusive; ranges are limited
to 366 days. Pending or ambiguous usage remains a conservative token count.
The counts table contains only call ID, install ID, tokens, timestamp and a
settlement flag. It has no prompt, completion, model payload or key columns.

Validation uses a local fake upstream and real PostgreSQL:

```sh
cd packages/backend
go test ./credits ./app ./modelproxy ./internal/compose -run '^TestFastQuota|^TestFastGateway|^TestInstallFastModelSignIn' -count=1
```

This public composition contract does not prove deployment of Plue's private
hosting adapter, real Cerebras usage or routing every fast-model caller through the install
source. The composed PKCE test does prove that the host receives and seals
a credential and gets a metered completion from a fake upstream. The install sign-in and fallback UI belong to T-FM-01.
