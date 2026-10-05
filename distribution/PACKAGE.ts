/** Preview-only OCI image and retained lifecycle contracts. */
import { Smithers as S } from "@smthrs/targets"

// The root Docker context spans package boundaries, and BUILD_SHA is resolved
// after keying. Until that complete context has content identities, rebuild.
const image = S.Docker.Build({
  dockerfile: S.file("Dockerfile"),
  context: "..",
  platforms: ["linux/amd64"],
  buildArgs: { BUILD_SHA: S.Stamp.commit },
  cache: false,
  data: [S.glob("**/*"), S.file("//.dockerignore")]
})

const go = S.Shell.Test({
  shell:
    "test -z \"$(gofmt -l distribution)\" && go build ./distribution/... && go vet ./distribution/... && go test -count=1 ./distribution/...",
  data: [
    S.glob("**/*"),
    S.file("//go.mod"),
    S.file("//go.sum"),
    S.file("//scripts/build-backend.sh"),
    S.file("//packages/backend/postgres/lock_other.go"),
    S.file("//packages/backend/postgres/lock_unix.go"),
    S.file("//packages/backend/postgres/postgres.go"),
    S.file("//packages/backend/postgres/postgres_test.go"),
    S.file("//packages/backend/postgres/process_darwin.go"),
    S.file("//packages/backend/postgres/process_linux.go"),
    S.file("//packages/backend/postgres/process_other.go"),
    S.file("//packages/backend/postgres/process_unix.go"),
    S.file("//packages/backend/testkit/testdb/testdb.go"),
    S.file("//packages/backend/testkit/testdb/testdb_test.go"),
    S.file("//packages/backend/testkit/testdb/tools.go"),
    S.file("//packages/backend/testkit/testdb/tools_test.go")
  ],
  sandbox: { network: "loopback" },
  timeout: "15m"
})

const fakeProvider = S.NodeTest({
  cwd: "distribution",
  runner: S.testRunner([S.file("fake-coding-provider.test.mjs")]),
  srcs: [S.file("fake-coding-provider.mjs"), S.file("fake-coding-provider.test.mjs")],
  deps: []
})
export const Package = S.Package({ targets: { image, go, fakeProvider } })
