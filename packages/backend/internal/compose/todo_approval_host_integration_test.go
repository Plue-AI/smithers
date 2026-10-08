//go:build unix

package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A main-owned override runs in the composed install's managed coding host.
// Its real HumanTask.confirm produces the approval. The installed answer door,
// durable dispatcher, authenticated runtime bridge and executor deliver it;
// the next question independently reveals the boolean the flow consumed.
// Linux process transport does not qualify a real guest or reference timing.
func TestTodoApprovalManagedHostComposedInstall(t *testing.T) {
	testTodoApprovalManagedHost(t, "SMITHERS_TODO_APPROVAL_HOST")
}

// Uses the approved installed guest providers without a process fallback.
func TestTodoApprovalManagedHostMicroVM(t *testing.T) {
	if os.Getenv("SMITHERS_TODO_APPROVAL_MICROVM") != "1" {
		t.Skip("requires the reference microVM and approved bundle")
	}
	t.Setenv(pinnedMicroVMRehearsal, "1")
	testTodoApprovalManagedHost(t, pinnedMicroVMRehearsal)
}

func testTodoApprovalManagedHost(t *testing.T, enable string) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, enable, "C-STK-01", "approval-host-")
	require.True(t, r.install("Install through Machine ready"))
	source := `import { Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("todo", {
 description: "Require a person's approval before continuing.",
 capabilities: [],
 effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
 modelInvocable: false,
 payload: {}, success: Schema.Json, error: HumanTask.HumanTaskFailed,
 body: () => HumanTask.action.call({ name: "plan-approval", kind: "confirm", prompt: "Proceed with this plan?", maxAttempts: 1 }).pipe(
  Node.map((approved) => approved === true ? "Approved" : "Rejected"),
  Node.bindPlanned((prompt) => HumanTask.action.call({ name: "observed-answer", kind: "ask", prompt, maxAttempts: 1 }))
 )
})
`
	commit, digest := activateWatchdogOverride(t, r, source)
	for _, answer := range []string{"true", "false"} {
		t.Run(answer, func(t *testing.T) {
			n, err := r.file("Human approval "+answer, "Wait for my approval.")
			require.NoError(t, err)
			card, err := r.waitTodoWithin(n, 3*time.Minute, "needs_you")
			require.NoError(t, err)
			require.NotNil(t, card.Run)
			require.NotNil(t, card.FlowVersion)
			require.Equal(t, digest, card.FlowVersion.Digest)
			require.Equal(t, commit, card.FlowVersion.SourceCommit)
			require.Len(t, card.Waits, 1)
			require.Equal(t, "approval", card.Waits[0].Kind)
			require.Equal(t, "Proceed with this plan?", card.Waits[0].Prompt)
			require.Len(t, card.Waits[0].Actions, 2)
			path := fmt.Sprintf("/api/todos/%d", n)
			code, raw, err := r.keyed("POST", path, `{"op":"stop"}`, "approval-host-stop-"+answer)
			require.NoError(t, err)
			require.Equal(t, 409, code, string(raw))
			wait := card.Waits[0].ID
			body, err := json.Marshal(map[string]string{"wait": wait, "answer": answer})
			require.NoError(t, err)
			code, raw, err = r.keyed("POST", path+"/answer", string(body), "approval-host-answer-"+answer)
			require.NoError(t, err)
			require.Equal(t, 202, code, string(raw))
			prompt := "Approved"
			if answer == "false" {
				prompt = "Rejected"
			}
			require.Eventually(t, func() bool {
				next, err := r.todo(n)
				return err == nil && next.State == "needs_you" && len(next.Waits) == 1 && next.Waits[0].Kind == "question" && next.Waits[0].Prompt == prompt && next.Run != nil && next.Run.ID == card.Run.ID
			}, time.Minute, 100*time.Millisecond, "the real flow must consume the admitted boolean")
			opposite := "false"
			if answer == "false" {
				opposite = "true"
			}
			body, err = json.Marshal(map[string]string{"wait": wait, "answer": opposite})
			require.NoError(t, err)
			code, raw, err = r.keyed("POST", path+"/answer", string(body), "approval-host-late-"+answer)
			require.NoError(t, err)
			require.Equal(t, 409, code, string(raw))
			require.Contains(t, string(raw), `"answered_by":"rehearsal-owner"`)
			// Cancel the new question through the installed Drop door; it cannot be
			// confused with the already-settled approval or leave an executing run.
			code, raw, err = r.keyed("POST", path, `{"op":"drop"}`, "approval-host-drop-"+answer)
			require.NoError(t, err)
			require.Equal(t, 202, code, string(raw))
			_, err = r.waitTodoWithin(n, time.Minute, "dropped")
			require.NoError(t, err)
		})
	}
}
