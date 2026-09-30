package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

const registrationTestFlow = `import { Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("register-repository", {
 description: "Registration review integration fixture",
 capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
 payload: {}, success: Schema.Json, error: HumanTask.HumanTaskFailed,
 body: () => HumanTask.action.call({name:"register-repository/review",kind:"select",prompt:"Register owner/repo?",options:["Approve","Decline"]}).pipe(
  Node.branch({if: answer => answer === "Approve", then: () => Node.succeed({decision:"approve",setup:true}),
   else: () => HumanTask.action.call({name:"register-repository/decline-note",kind:"ask",prompt:"Why decline?"}).pipe(Node.map(note => ({decision:"decline",note})))})
 )
})
`

type registrationHostDispatcher struct {
	client *runtimebridge.Client
	target flowruntime.Target
}

func (d *registrationHostDispatcher) CallRPC(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	if target != d.target {
		return nil, fmt.Errorf("wrong workspace execution authority: %+v", target)
	}
	return d.client.CallRPC(ctx, procedure, payload)
}
func (d *registrationHostDispatcher) StartHost(context.Context, flowruntime.Target) (bool, error) {
	return true, nil
}

// registrationResumes counts box resumes: listing reviews must never ask for one.
type registrationResumes struct{ calls int }

func (b *registrationResumes) ResumeWorkspace(context.Context, string, int64, int64) (services.WorkspaceResponse, error) {
	b.calls++
	return services.WorkspaceResponse{}, nil
}

// requireRegistrationToolchain names what the source host needs before it can
// start: Node 26.4 or newer on PATH (older Node cannot load the workspace's
// TypeScript sources) and the workspace's installed dependencies, which live
// in node_modules beside the root and inside packages/smithers. Without them
// the host dies at import time and the test times out with an opaque error.
func requireRegistrationToolchain(t *testing.T) {
	t.Helper()
	out, err := exec.Command("node", "-p", "process.versions.node").Output()
	if err != nil {
		testdb.Unavailable(t, fmt.Errorf("registration host needs node >=26.4.0 on PATH: %w", err))
		return
	}
	var major, minor int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(out)), "%d.%d", &major, &minor); err != nil || major < 26 || (major == 26 && minor < 4) {
		testdb.Unavailable(t, fmt.Errorf("registration host needs node >=26.4.0 on PATH, found %s", strings.TrimSpace(string(out))))
		return
	}
	for _, dir := range []string{"../../../../node_modules/@smthrs", "../../../smithers/node_modules"} {
		if _, err := os.Stat(dir); err != nil {
			testdb.Unavailable(t, fmt.Errorf("registration host needs the installed workspace dependencies (missing %s): run pnpm install --frozen-lockfile", filepath.Clean(dir)))
			return
		}
	}
}

func startRegistrationHost(t *testing.T, root string) (*runtimebridge.Client, func()) {
	t.Helper()
	requireRegistrationToolchain(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	script, err := filepath.Abs("testdata/registration-host.mjs")
	require.NoError(t, err)
	logs, err := os.CreateTemp(t.TempDir(), "host-*.log")
	require.NoError(t, err)
	cmd := exec.Command("node", script, root, strconv.Itoa(port))
	cmd.Stdout = logs
	cmd.Stderr = logs
	require.NoError(t, cmd.Start())
	var once sync.Once
	stop := func() { once.Do(func() { _ = cmd.Process.Kill(); _ = cmd.Wait(); _ = logs.Close() }) }
	t.Cleanup(func() {
		stop()
		if t.Failed() {
			output, _ := os.ReadFile(logs.Name())
			t.Log(string(output))
		}
	})
	endpoint := fmt.Sprintf("http://127.0.0.1:%d", port)
	// This source host imports the workspace packages on every replacement.
	// Give startup its own budget; recovery assertions below still have 60s.
	require.Eventually(t, func() bool {
		r, e := http.Get(endpoint + "/health")
		if e != nil {
			return false
		}
		defer r.Body.Close()
		return r.StatusCode == 200
	}, 90*time.Second, 100*time.Millisecond)
	client, err := runtimebridge.New(runtimebridge.Config{Endpoint: endpoint, Credential: "registration-integration-only"})
	require.NoError(t, err)
	return client, stop
}

func registrationHostRPC(t *testing.T, client *runtimebridge.Client, procedure string, payload any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	response, err := client.CallRPC(context.Background(), procedure, raw)
	require.NoError(t, err)
	var envelope struct {
		OK      bool            `json:"ok"`
		Payload json.RawMessage `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(response, &envelope))
	require.True(t, envelope.OK, string(response))
	return envelope.Payload
}

func TestAdminRegistrationReviewPostgresRestart(t *testing.T) {
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "registrant", LowerUsername: "registrant", DisplayName: "Registrant"})
	require.NoError(t, err)
	admin, err := q.CreateUser(ctx, db.CreateUserParams{Username: "will", LowerUsername: "will", DisplayName: "Will"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, "UPDATE users SET is_admin=true WHERE id=$1", admin.ID)
	require.NoError(t, err)
	admin.IsAdmin = true
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public,default_bookmark) VALUES ($1,'repo','repo',false,'main') RETURNING id`, owner.ID).Scan(&repo))
	workspace := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,vm_id,status) VALUES($1,$2,$3,'fixture','running')`, workspace, repo, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state) VALUES($1,$2,$3,'browser-flow','registrant/repo',$4,$5,$6,'coding','coding-host',$7,$8,1,'fixture',decode(repeat('00',32),'hex'),'running')`, uuid.NewString(), fmt.Sprintf("repository:%d", repo), fmt.Sprintf("user:%d", owner.ID), repo, owner.ID, workspace, strings.Repeat("a", 64), strings.Repeat("b", 40))
	require.NoError(t, err)
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "flows/register-repository"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "flows/register-repository/flow.ts"), []byte(registrationTestFlow), 0600))
	modules, err := filepath.Abs("../../../../node_modules")
	require.NoError(t, err)
	require.NoError(t, os.Symlink(modules, filepath.Join(root, "node_modules")))
	require.NoError(t, os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"type":"module"}`), 0600))
	// A second registrant box that sleeps. Its host binding stays, so the list
	// sees it; reading it must not wake it (#2341).
	sleeping := uuid.NewString()
	var sleepingRepo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public,default_bookmark) VALUES ($1,'asleep','asleep',false,'main') RETURNING id`, owner.ID).Scan(&sleepingRepo))
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,vm_id,status) VALUES($1,$2,$3,'fixture-sleeping','suspended')`, sleeping, sleepingRepo, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state) VALUES($1,$2,$3,'browser-flow','registrant/asleep',$4,$5,$6,'coding','coding-host',$7,$8,1,'fixture',decode(repeat('01',32),'hex'),'running')`, uuid.NewString(), fmt.Sprintf("repository:%d", sleepingRepo), fmt.Sprintf("user:%d", owner.ID), sleepingRepo, owner.ID, sleeping, strings.Repeat("a", 64), strings.Repeat("b", 40))
	require.NoError(t, err)
	resumes := &registrationResumes{}
	client, stop := startRegistrationHost(t, root)
	dispatcher := &registrationHostDispatcher{client: client, target: flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID), WorkspaceID: workspace, BindingKind: "browser-flow", BindingID: "registrant/repo"}}
	api := &browserFlowAPI{registrationPool: pool, dispatcher: dispatcher, boxes: resumes}
	list := func() []registrationInbox {
		// The app's own Inbox body (gateway.ts registrationInboxes): the admin's
		// selected box and repository ride along, and the first page's cursor is "".
		w := registrationRequest(api, &admin, false, `{"repo":"will/own-repo","workspaceId":"`+uuid.NewString()+`","procedure":"Registration.Reviews","payload":{"after":""}}`)
		require.Equal(t, 200, w.Code, w.Body.String())
		var result struct {
			Payload struct {
				Inboxes []registrationInbox `json:"inboxes"`
			} `json:"payload"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
		// The sleeping box is answered unread and left asleep; the running box's
		// reviews are listed beside it.
		read := []registrationInbox{}
		for _, inbox := range result.Payload.Inboxes {
			if inbox.WorkspaceID == sleeping {
				require.NotEmpty(t, inbox.Error)
				require.Empty(t, inbox.Rows)
				continue
			}
			require.Empty(t, inbox.Error)
			read = append(read, inbox)
		}
		require.Len(t, result.Payload.Inboxes, len(read)+1)
		require.Zero(t, resumes.calls)
		var status string
		require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, sleeping).Scan(&status))
		require.Equal(t, "suspended", status)
		return read
	}
	answer := func(row json.RawMessage, value string) *bytes.Buffer {
		var item struct {
			Payload map[string]any `json:"payload"`
		}
		require.NoError(t, json.Unmarshal(row, &item))
		item.Payload["decision"] = "approve"
		item.Payload["answer"] = value
		body, err := json.Marshal(map[string]any{"repo": "registrant/repo", "workspaceId": workspace, "procedure": "Approval.Submit", "payload": item.Payload})
		require.NoError(t, err)
		for _, actor := range []struct {
			user *db.User
			run  bool
		}{{&owner, false}, {&admin, true}} {
			denied := registrationRequest(api, actor.user, actor.run, string(body))
			require.Equal(t, 403, denied.Code, denied.Body.String())
		}
		// The runtime reads exact JSON keys. A second, differently cased key
		// must not conceal this real wait from the backend's admin guard.
		canonical, err := json.Marshal(item.Payload)
		require.NoError(t, err)
		shadowed := json.RawMessage(string(canonical[:len(canonical)-1]) + `,"Target":{"requestId":"other"}}`)
		shadowBody, err := json.Marshal(map[string]any{"repo": "registrant/repo", "workspaceId": workspace, "procedure": "Approval.Submit", "payload": shadowed})
		require.NoError(t, err)
		denied := registrationRequest(api, &owner, false, string(shadowBody))
		require.Equal(t, 403, denied.Code, denied.Body.String())
		var forged map[string]any
		require.NoError(t, json.Unmarshal(body, &forged))
		forged["payload"].(map[string]any)["target"].(map[string]any)["digest"] = "different-wait"
		invalid, err := json.Marshal(forged)
		require.NoError(t, err)
		refused := registrationRequest(api, &admin, false, string(invalid))
		require.Equal(t, 409, refused.Code, refused.Body.String())
		if value == "Please add a license." {
			refused = registrationRequest(api, &admin, false, strings.Replace(string(body), value, "   ", 1))
			require.Equal(t, 400, refused.Code, refused.Body.String())
		}
		w := registrationRequest(api, &admin, false, string(body))
		require.Equal(t, 200, w.Code, w.Body.String())
		require.Contains(t, w.Body.String(), `"ok":true`)
		return w.Body
	}
	hostTest := t
	for _, choice := range []string{"Approve", "Decline", "Cancel"} {
		t.Run(choice, func(t *testing.T) {
			var existing struct {
				Rows []json.RawMessage `json:"rows"`
			}
			require.NoError(t, json.Unmarshal(registrationHostRPC(t, client, "Projection.Snapshot", map[string]any{"selector": map[string]any{"_tag": "workspace-runs"}}), &existing))
			var plan map[string]any
			require.NoError(t, json.Unmarshal(registrationHostRPC(t, client, "Plan", map[string]any{"flowId": "register-repository", "input": map[string]any{}}), &plan))
			registrationHostRPC(t, client, "Approve", plan["approval"])
			var receipt struct {
				RunID string `json:"runId"`
			}
			start := map[string]any{"_tag": "Plan", "planId": plan["planId"], "digest": plan["digest"], "envelope": plan["envelope"], "idempotencyKey": uuid.NewString()}
			require.NoError(t, json.Unmarshal(registrationHostRPC(t, client, "Run", start), &receipt))
			assertDuplicate := func() {
				var duplicate struct {
					RunID string `json:"runId"`
				}
				require.NoError(t, json.Unmarshal(registrationHostRPC(t, client, "Run", start), &duplicate))
				require.Equal(t, receipt.RunID, duplicate.RunID, "retry must recover the accepted run")
			}
			assertDuplicate()
			require.NotEmpty(t, receipt.RunID)
			var inbox []registrationInbox

			require.Eventually(t, func() bool { inbox = list(); return len(inbox) == 1 && len(inbox[0].Rows) == 1 }, 60*time.Second, 100*time.Millisecond)
			require.Equal(t, "registrant/repo", inbox[0].Repo)
			before := inbox[0].Rows[0]
			// Fresh backend objects and a new Postgres connection, then a replacement
			// workspace host opening the same two durable databases while parked.
			restartedPool, err := postgresfixture.Open(ctx, databaseURL, 0)
			require.NoError(t, err)
			hostTest.Cleanup(restartedPool.Close)
			stop()
			client, stop = startRegistrationHost(hostTest, root)
			dispatcher.client = client
			api = &browserFlowAPI{registrationPool: restartedPool, dispatcher: dispatcher, boxes: resumes}
			inbox = list()
			require.Len(t, inbox, 1)
			var original, recovered struct {
				Payload json.RawMessage `json:"payload"`
			}
			require.NoError(t, json.Unmarshal(before, &original))
			require.NoError(t, json.Unmarshal(inbox[0].Rows[0], &recovered))
			require.JSONEq(t, string(original.Payload), string(recovered.Payload))
			assertDuplicate()
			cancelRequest := map[string]any{"runId": receipt.RunID, "reason": "restart acceptance", "idempotencyKey": "cancel:" + receipt.RunID}
			var cancelReceipt json.RawMessage
			if choice == "Cancel" {
				cancelReceipt = registrationHostRPC(t, client, "Cancel", cancelRequest)
				// A second process replacement must not resurrect a cancelled wait.
				stop()
				client, stop = startRegistrationHost(hostTest, root)
				dispatcher.client = client
			} else {
				answer(inbox[0].Rows[0], choice)
			}
			if choice == "Decline" {
				require.Eventually(t, func() bool {
					inbox = list()
					return len(inbox) == 1 && len(inbox[0].Rows) == 1 && strings.Contains(string(inbox[0].Rows[0]), registrationNote)
				}, 60*time.Second, 100*time.Millisecond)
				answer(inbox[0].Rows[0], "Please add a license.")
			}
			var last json.RawMessage
			require.Eventually(t, func() bool {
				var result struct {
					Rows []struct {
						RunID  string `json:"runId"`
						Status string `json:"status"`
					} `json:"rows"`
				}
				last = registrationHostRPC(t, client, "Projection.Snapshot", map[string]any{"selector": map[string]any{"_tag": "workspace-runs"}})
				require.NoError(t, json.Unmarshal(last, &result))
				for _, run := range result.Rows {
					if run.RunID == receipt.RunID {
						if choice == "Cancel" {
							return run.Status == "cancelled"
						}
						return run.Status == "completed"
					}
				}
				return false
			}, 60*time.Second, 100*time.Millisecond, "last snapshot: %s", &last)
			if choice == "Cancel" {
				require.JSONEq(t, string(cancelReceipt), string(registrationHostRPC(t, client, "Cancel", cancelRequest)), "a cancellation retry must answer the run's terminal state")
				var stale map[string]any
				require.NoError(t, json.Unmarshal(original.Payload, &stale))
				stale["decision"], stale["answer"] = "approve", "Approve"
				body, err := json.Marshal(map[string]any{"repo": "registrant/repo", "workspaceId": workspace, "procedure": "Approval.Submit", "payload": stale})
				require.NoError(t, err)
				refused := registrationRequest(api, &admin, false, string(body))
				require.Equal(t, http.StatusConflict, refused.Code, refused.Body.String())
				require.Contains(t, refused.Body.String(), "no longer pending")
			}
			assertDuplicate()
			var snapshot struct {
				Rows []struct {
					RunID  string `json:"runId"`
					Status string `json:"status"`
				} `json:"rows"`
			}
			require.NoError(t, json.Unmarshal(registrationHostRPC(t, client, "Projection.Snapshot", map[string]any{"selector": map[string]any{"_tag": "workspace-runs"}}), &snapshot))
			require.Len(t, snapshot.Rows, len(existing.Rows)+1, "retries must not create additional runs")
			count := 0
			for _, row := range snapshot.Rows {
				if row.RunID == receipt.RunID {
					if choice == "Cancel" {
						require.Equal(t, "cancelled", row.Status)
					} else {
						require.Equal(t, "completed", row.Status)
					}
					count++
				}
			}
			require.Equal(t, 1, count, "exactly one run survives retries and replacement")
			require.Empty(t, list()[0].Rows)
		})
	}
	stop()
}
