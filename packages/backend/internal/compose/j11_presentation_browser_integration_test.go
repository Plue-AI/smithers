package compose

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The repository action writes serializable data inside the native machine.
// The install observes its real journal and serves the mounted browser card;
// no HTTP response, monitor reader or live topic is replaced.
func TestJ11NativePresentationBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_J11_PRESENTATION_BROWSER") != "1" {
		t.Skip("enable native custom-view browser qualification")
	}
	spa, err := filepath.Abs("../../../../apps/app/dist")
	require.NoError(t, err)
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_J11_PRESENTATION_BROWSER", "C-J11-02", "j11-presentation-")
	require.True(t, r.install("Install"))
	activateMonitorOverride(t, r, `
import { RequestInput, StackBase } from "@smthrs/coding"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Schema } from "effect"
const Probe = Action.make("monitor/presentation-probe", { payload: {}, success: Schema.String, error: Schema.String, implementationVersion: "1" })
export const layer = Probe.toLayer(() => Effect.gen(function*() {
 const instance = yield* FlowRuntime.FlowInstance
 const journal = yield* Journal.Journal
 yield* journal.emitLossy(new JournalEvent.Input({
  runId: JournalEvent.RunId.make(instance.executionId),
  sourceId: JournalEvent.SourceId.make("hello-presentation"),
  sourceSeq: JournalEvent.SourceSeq.make(1),
  eventType: "flows.run.presentation", payload: { kind: "text", text: "Hello, Ada <script>globalThis.runPresentationCanary = true</script>" }
 })).pipe(Effect.orDie)
 yield* journal.flush.pipe(Effect.orDie)
 return yield* Effect.fail("Recorded custom view")
}), { implementationVersion: "1" })
export default Flow.make("todo", {
 description: "Declare a custom view inside a machine.", capabilities: ["*"], modelInvocable: false,
 effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
 payload: Schema.Struct({ ...RequestInput.fields, base: StackBase }), success: Schema.String, error: Schema.String,
 body: () => Probe.call({})
})`)
	n, err := r.file("Custom view", "Record a custom view")
	require.NoError(t, err)
	card, err := r.waitTodoWithin(n, 3*time.Minute, "failed")
	require.NoError(t, err)
	id := card.Branch.ID + ":" + card.Run.ID
	client := &http.Client{Jar: r.jar, Timeout: 30 * time.Second}
	response, err := client.Get(r.origin + "/api/runs/" + url.PathEscape(id) + "/trace")
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode)
	var monitor map[string]any
	require.NoError(t, json.NewDecoder(response.Body).Decode(&monitor))
	response.Body.Close()
	require.Equal(t, map[string]any{"kind": "text", "text": "Hello, Ada <script>globalThis.runPresentationCanary = true</script>"}, monitor["presentation"])
	runJ11MonitorBrowser(t, r, "C-J11-02: native custom", []string{"SMITHERS_J11_PRESENTATION_RUN=" + id}, "C-J11-02.spec.ts")
}
