package compose

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// This exercises the shipped app, install router, native repository and packaged
// flow host. The repository contains a small ordinary typed flow, not an RPC
// stand-in. Trusted-process isolation and GitHub fake make this supplemental
// Linux evidence; it cannot qualify C-J11-02 on the reference microVM host.
func TestFlowSourceRunBrowserComposedInstall(t *testing.T) {
	if os.Getenv("SMITHERS_FLOW_SOURCE_RUN_BROWSER") != "1" {
		t.Skip("enable composed Flow Source/Plan/Run browser proof")
	}
	spa, err := filepath.Abs("../../../../apps/app/dist")
	require.NoError(t, err)
	require.FileExists(t, filepath.Join(spa, "index.html"))
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_FLOW_SOURCE_RUN_BROWSER", "C-J11-02", "flow-source-run-")
	// Prepare only the fake upstream, before setup syncs it. Production mirror
	// main is never written by the browser, recording tool or fixture.
	source := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", args...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	upstream := filepath.Join(r.gitRoot, "rehearsal-owner/app.git")
	git("clone", upstream, source)
	path := filepath.Join(source, "flows/todo/flow.ts")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0700))
	require.NoError(t, os.WriteFile(path, []byte(flowSourceRunFixture), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "-c", "user.name=Canary", "-c", "user.email=canary@example.test", "commit", "-m", "Typed scratch flow")
	git("-C", source, "push", "origin", "main")
	r.mainCommit = git("-C", source, "rev-parse", "HEAD")
	require.True(t, r.install("Install through Machine ready"))
	require.NoError(t, r.waitStackActive())
	cookies, err := json.Marshal(r.jar.Cookies(mustRehearsalURL(r.origin)))
	require.NoError(t, err)
	command := exec.CommandContext(r.ctx, "bun", "e2e/real/flow-source-run.browser.ts")
	command.Dir = filepath.Join(r.root, "apps/app")
	command.Env = append(os.Environ(), "SMITHERS_FLOW_SOURCE_RUN_ORIGIN="+r.origin, "SMITHERS_FLOW_SOURCE_RUN_COOKIES="+string(cookies), "SMITHERS_FLOW_SOURCE_RUN_EVIDENCE="+r.evidence)
	output, err := command.CombinedOutput()
	t.Log(string(output))
	require.NoError(t, err)
	var items, operations int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items`).Scan(&items))
	require.Zero(t, items, "a draft Run never files a TODO")
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE pending_op IS NOT NULL`).Scan(&operations))
	require.Zero(t, operations, "a draft Run publishes nothing")
	for _, write := range r.fake.Writes() {
		require.False(t, strings.Contains(write.Path, "/pulls"), "draft Run cannot write a PR: %s", write.Path)
	}
}

const flowSourceRunFixture = `import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
const step = (name: string) => Action.make(name, { implementationVersion: "canary/v1", payload: {}, success: Schema.String })
const Route = step("route"), Deliver = step("deliver"), Notify = step("notify")
export const layer = Layer.mergeAll(Route.toLayer(() => Effect.succeed("routed"), { implementationVersion: "canary/v1" }), Notify.toLayer(() => Effect.succeed("notified"), { implementationVersion: "canary/v1" }), Deliver.toLayer(() => Effect.succeed("delivered"), { implementationVersion: "canary/v1" }))
export default Flow.make("todo", {
 description: "Typed scratch composition",
 capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
 payload: {}, success: Schema.String,
 body: Node.capture({}, () => Route.call({}).pipe(Node.andThen(Deliver.call({})), Node.andThen(Notify.call({}))))
})
`
