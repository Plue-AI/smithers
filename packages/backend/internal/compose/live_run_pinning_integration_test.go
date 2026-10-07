package compose

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The admitted pin, checkpoint, branch authorization and Live socket are real;
// the journal transport is a fixture. This is not microVM qualification.
func TestLiveRunPublishesAdmittedVersion(t *testing.T) {
	for _, name := range []string{"pinned", "draft", "wrong digest", "wrong source", "wrong target", "draft with pin", "legacy todo without pin"} {
		t.Run(name, func(t *testing.T) {
			f := presenceInstall(t)
			provider := &liveRunFixture{head: 1, flowID: "todo"}
			f.p.dispatcher = provider
			store, err := jobs.NewStore(f.pool)
			require.NoError(t, err)
			target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", f.user.ID), WorkspaceID: f.row.ID, BindingKind: flowdispatch.StackBindingKind, BindingID: "fixture"}
			if name == "draft" || name == "draft with pin" {
				target.BindingKind = flowdispatch.DraftBindingKind
			}
			pin := &flowruntime.Pin{Flow: "todo", SourceCommit: strings.Repeat("a", 40), ExecutionDigest: strings.Repeat("b", 64)}
			flow := "todo"
			digest := pin.ExecutionDigest
			if name == "wrong digest" {
				digest = strings.Repeat("c", 64)
			}
			if name == "wrong source" {
				pin.SourceCommit = "main"
			}
			if name == "draft" || name == "legacy todo without pin" {
				pin = nil
			}
			admittedTarget := target
			if name == "wrong target" {
				admittedTarget.BindingID = "foreign"
			}
			payload, err := json.Marshal(map[string]any{"target": admittedTarget, "flowId": flow, "pin": pin})
			require.NoError(t, err)
			receipt, err := store.Admit(t.Context(), jobs.Admission{Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, Operation: flowdispatch.OperationLaunch, RequestID: "version-run", Payload: payload, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile, EffectKey: "version-run"})
			require.NoError(t, err)
			checkpoint, err := json.Marshal(flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: flow, RunID: "fixture-run", ExecutionDigest: digest})
			require.NoError(t, err)
			_, err = f.pool.Exec(t.Context(), `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, receipt.OperationID, checkpoint)
			require.NoError(t, err)
			socket := f.dial(t)
			sendPresenceFrame(t, socket, `{"t":"sub","id":1,"topic":"run:fixture-run"}`)
			frame := readPresenceFrame(t, socket)
			if name != "pinned" && name != "draft" && name != "legacy todo without pin" {
				require.Equal(t, "unsupported", frame.Code)
				require.Zero(t, provider.reads, "invalid admission must refuse before journal RPC")
				return
			}
			require.Equal(t, "snap", frame.T)
			var data map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(frame.Data, &data))
			if name == "pinned" {
				require.JSONEq(t, `{"flow_name":"todo","source_commit":"`+strings.Repeat("a", 40)+`","digest":"`+strings.Repeat("b", 64)+`"}`, string(data["flow_version"]))
				require.NotContains(t, data, "version")
				_, err = f.pool.Exec(t.Context(), `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,$2,$3,'loaded')`, f.row.RepositoryID, strings.Repeat("c", 40), strings.Repeat("d", 64))
				require.NoError(t, err)
				other := f.dial(t)
				sendPresenceFrame(t, other, `{"t":"sub","id":1,"topic":"run:fixture-run"}`)
				repeated := readPresenceFrame(t, other)
				require.Equal(t, frame.Data, repeated.Data, "activation never replaces the admitted run pin")
			} else if name == "draft" {
				require.JSONEq(t, `"draft version"`, string(data["version"]))
				require.NotContains(t, data, "flow_version")
			} else {
				require.NotContains(t, data, "version")
				require.NotContains(t, data, "flow_version")
				require.JSONEq(t, `{"runId":"fixture-run","flowId":"todo","status":"running"}`, string(data["summary"]))
			}
		})
	}
}

func TestLiveRunRefusesSummaryOutsideAdmittedPin(t *testing.T) {
	provider := &liveRunFixture{head: 1}
	reader := runProjectionReader{call: provider.CallRPC, run: "fixture-run", pin: &flowruntime.Pin{Flow: "todo", SourceCommit: strings.Repeat("a", 40), ExecutionDigest: strings.Repeat("b", 64)}}
	_, err := reader.page(t.Context(), nil)
	require.ErrorContains(t, err, "run summary conflicts with admitted pin")
}
