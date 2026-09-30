---
title: "Self-host image releases"
description: "Build, publish, and verify the public Smithers container image."
---

## Install a published release

Use the digest-pinned `ghcr.io/smithersai/smithers@sha256:...` reference in the
[release notes](https://github.com/smithersai/smithers/releases). Follow the
[installation and backup guide](../../../distribution/README.md) with that
reference in `SMITHERS_IMAGE`. A release without an image receipt is not an
available container release.

## Build from source

From the repository root at the desired revision:

```bash
export SMITHERS_IMAGE=smithers:local
BUILD_SHA=$(jj log -r @ --no-graph -T commit_id)
docker build --build-arg "BUILD_SHA=$BUILD_SHA" \
  -f distribution/Dockerfile -t "$SMITHERS_IMAGE" .
SMITHERS_BUILD_SHA="$BUILD_SHA" SMITHERS_DOCKER_SKIP_BUILD=1 \
  bash distribution/test-image.sh "$SMITHERS_IMAGE"
```

Use that local image with the installation guide. Source acceptance uses local
scripted model and evaluator responses, an actual PostgreSQL service, and the
packaged coding runtime. It checks file creation, judged completion, restart,
backup, restore, and version mismatch refusal; it does not measure model quality.

Standard file writes hold an exclusive sibling lock until the write settles.
The coding host releases only lock directories it created successfully and
refuses cleanup if a lock contains files. A pre-existing lock remains in place;
confirm its writer has stopped before recovering it manually.

## Verify a parked review across process replacement

The backend integration test uses a disposable PostgreSQL database and a real
Node Flow host with durable SQLite state. It parks a repository registration
review, replaces the host process, reopens the backend database connection, and
answers through the backend’s browser Flow HTTP handler. It covers approval, decline with a
follow-up answer, duplicate starts before and after replacement, and cancellation
followed by another replacement, a repeated cancellation request, and refusal of
a late answer to the cancelled question. Repeated starts must return the original run
and must not add another run to the workspace.

```bash
SMITHERS_REQUIRE_DATABASE_TESTS=1 \
SMITHERS_TEST_DATABASE_URL=postgres://USER@localhost:5432/postgres \
GOWORK=off go test ./packages/backend/internal/compose \
  -run '^TestAdminRegistrationReviewPostgresRestart$' -count=1 -v
```

Install the workspace dependencies and use the repository's supported Node
version first. The database user needs permission to create databases. The test
creates and drops its own database; it does not reuse product state. Its scripted
evaluator avoids provider traffic and does not qualify a live coding seat.

This test replaces the Flow process and backend handler objects, not an entire
backend service or VM. PostgreSQL itself stays running; only its connection pool
is reopened. Each replacement host reuses the same filesystem root, so this test
does not cover disk loss, backup or restore. Replacement happens while parked or
after the cancellation RPC returns, not while an answer or cancel is in flight.
The container acceptance above currently checks a completed
coding run before restarting the application; it does not prove recovery of a
parked run. Qualifying an installation still requires parking an actual run,
restarting its backend and VM, answering the same persisted question, and checking
one completed run. Also repeat cancellation and confirm that the cancelled run
stays cancelled after replacement, then test host reboot and unavailable capacity.
Keep run ids, revisions, supervisor configuration and timestamped results with the
installation's private receipts.

## Verify the admin Inbox after an upgrade

Deploy the backend and app revisions together. A working edge alone does not
prove that its upstream backend serves the app's registration review procedure.
Record `/api/bootstrap`'s `buildSha`, the app revision, and backend readiness with
the installation's release receipts.

Sign in as an admin person, select a repository and box, and open Inbox. Capture
`POST /api/workflow/rpc` with `procedure: "Registration.Reviews"`,
`payload: { "after": "" }`, and the selected `repo` and `workspaceId`. Expect
HTTP 200 with `ok: true`, `payload.inboxes`, and `payload.next`; follow nonempty
cursors until the last page. Verify `GET /api/user` reports `is_admin: true` for
the signed-in person. An anonymous 401 or a non-admin 403 does not prove that the
admin route works; a run credential cannot substitute for an admin person.

HTTP 400 with "The workflow seam does not relay this procedure." means the
backend does not serve the app's procedure. Update the backend dependency and
redeploy the API. HTTP 503 with "Registration reviews unavailable." reaches the
registration route but fails to read its directory; it is not a successful Inbox.

Include a running box with a parked registration review and a sleeping box.
Verify that the running box's review appears, the sleeping box stays asleep,
and Inbox reports the unchecked box without discarding readable reviews or
claiming that no approvals are pending. Answer the parked review and verify its
persisted completion after replacing the host and backend. Retain request
status, run id, box status before and after listing, and completion receipts.
A route test or successful deployment does not replace this authenticated check.

Run the focused HTTP regression before release:

```bash
GOWORK=off go test ./packages/backend/internal/compose \
  -run '^TestRegistrationReviewsInboxBodyReachesTheRegistrationRoute$' -count=1 -v
```

Use the PostgreSQL replacement test above for durable review behavior. The
sleeping box is deliberately unread: listing never wakes it, and a review on
that box becomes readable when it runs again.

## Publish

The existing Release workflow validates the image before publication. Its image
step builds `linux/amd64` and `linux/arm64` with the release version embedded in
the container, pushes the version tag, logs out of GHCR, and pulls both platforms
using an empty Docker credential directory. It also verifies anonymous pulls of
the manifest digest before adding that reference to the release notes. Dry runs
build both architectures into a local OCI archive and skip publication. Reruns
replace the existing image receipt while retaining the rest of the release notes. The Distribution image workflow runs the same acceptance
script on main.

The repository token requires `packages: write` and `contents: write`. GHCR's
package visibility must be public: the first package publication may require an
organization owner to change it in package settings. A private package fails the
anonymous-pull gate and receives no release-note receipt. After fixing visibility,
resume the release using its existing candidate procedure; never treat a pushed
private image as a completed public release.

`node scripts/set-release-version.mjs <version>` updates the image reference,
Dockerfile default, and persisted distribution version together with package
versions. The release contract test refuses drift. Record the release run, both
platform pulls, the digest, and container acceptance before marking publication
complete. A successful build alone proves none of those external receipts.
