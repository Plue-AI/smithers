package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/faultprocess"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// A durable protocol peer isolates lost delivery acknowledgments. This proves
// route/dispatcher recovery, not engine step replay or VM pause qualification.
type pauseDeliveryFaultRuntime struct {
	*reviewFixtureReceiver
	path, point string
}

func (r *pauseDeliveryFaultRuntime) Signal(_ context.Context, input flowruntime.Signal) (flowruntime.MutationResult, error) {
	if strings.HasSuffix(r.point, "-pre-delivery") {
		faultprocess.Reached(r.point)
	}
	raw, err := os.ReadFile(r.path)
	tag := "AlreadyApplied"
	if os.IsNotExist(err) {
		raw, err = json.Marshal(input)
		if err == nil {
			err = os.WriteFile(r.path, raw, 0600)
		}
		tag = "Accepted"
	}
	if err != nil {
		return flowruntime.MutationResult{}, err
	}
	var prior flowruntime.Signal
	if err = json.Unmarshal(raw, &prior); err != nil {
		return flowruntime.MutationResult{}, err
	}
	if prior.ApplicationRequestID != input.ApplicationRequestID || prior.RunID != input.RunID || prior.Name != input.Name || string(prior.Payload) != string(input.Payload) {
		return flowruntime.MutationResult{}, fmt.Errorf("delivery identity changed")
	}
	if r.point != "" {
		faultprocess.Reached(r.point)
	}
	return flowruntime.MutationResult{Operation: "signal", ApplicationRequestID: input.ApplicationRequestID, Receipt: flowruntime.Receipt{Tag: tag, ReceiptID: input.ApplicationRequestID, RunID: input.RunID}}, nil
}
func pauseDeliveryFaultService(t *testing.T, pool *pgxpool.Pool, path, point string) (*services.MythicalService, *flowdispatch.Service) {
	t.Helper()
	service := services.NewMythicalService(pool, nil)
	service.SetTodoFlow(func(context.Context, int64, string) (string, error) {
		t.Error("pause resolved Active instead of its pin")
		return "", fmt.Errorf("unexpected Active read")
	})
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	receiver := &pauseDeliveryFaultRuntime{reviewFixtureReceiver: &reviewFixtureReceiver{}, path: path, point: point}
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: service, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return receiver, nil })})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	return service, dispatcher
}
func TestTodoPauseDeliveryCrashChild(t *testing.T) {
	if os.Getenv(faultprocess.ChildEnv) != "todo-pause-delivery" {
		return
	}
	pool, err := postgresfixture.Open(t.Context(), os.Getenv(faultprocess.DBEnv), 0)
	require.NoError(t, err)
	defer pool.Close()
	args := strings.Split(os.Getenv(faultprocess.ArgsEnv), "|")
	require.Len(t, args, 1)
	_, dispatcher := pauseDeliveryFaultService(t, pool, args[0], os.Getenv(faultprocess.PointEnv))
	require.NoError(t, dispatcher.RunWorker(t.Context(), jobs.WorkerConfig{WorkerID: "pause-kill-child", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond}))
}

func TestTodoStopResumeDeliveryCrashComposed(t *testing.T) {
	for _, op := range []string{"stop", "resume"} {
		for _, crossing := range []string{"pre-delivery", "delivery"} {
			t.Run(op+"/"+crossing, func(t *testing.T) {
				t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr12_pausekill")
				path := filepath.Join(t.TempDir(), "signal.json")
				pool, _ := postgresfixture.NewProductDatabase(t)
				ctx := t.Context()
				q := db.New(pool)
				owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
				require.NoError(t, err)
				repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner.ID)
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
				require.NoError(t, err)
				require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repo.ID))}))
				require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-06T01:00:00Z"}`, repo.ID))}))
				_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
				require.NoError(t, err)
				item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "running", Checks: []byte(`{"todo":true,"run_launched":true,"run_attached":false}`)})
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,request_run_id='run-1',title='Interrupted',stack_position=1 WHERE id=$1`, item.ID, owner.ID)
				require.NoError(t, err)
				digest := "e274ce85c2e7f9fdef2bb4de75700e9847920893d24e6f69d692a573ff11ed3d"
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET flow_digest=$2,workspace_id='11111111-1111-4111-8111-111111111111',checks=jsonb_set(jsonb_set(checks,'{flowSource}',to_jsonb(repeat('a',40))),'{run_attached}'::text[],'true') WHERE id=$1`, item.ID, digest)
				require.NoError(t, err)
				raw := "interrupted-session"
				hash := sha256.Sum256([]byte(raw))
				_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
				require.NoError(t, err)
				service, dispatcher := pauseDeliveryFaultService(t, pool, path, "")
				server := mergeFaultServer(t, pool, service)
				origin := server.URL
				call := func(method, body, key string) (int, map[string]any) {
					req, err := http.NewRequest(method, origin+"/api/todos/1", strings.NewReader(body))
					require.NoError(t, err)
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Origin", origin)
					req.Header.Set("X-CSRF-Token", "csrf")
					req.Header.Set("Idempotency-Key", key)
					req.AddCookie(&http.Cookie{Name: "smithers_session", Value: raw})
					req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
					res, err := http.DefaultClient.Do(req)
					require.NoError(t, err)
					defer res.Body.Close()
					var value map[string]any
					require.NoError(t, json.NewDecoder(res.Body).Decode(&value))
					return res.StatusCode, value
				}

				if op == "resume" {
					// Seed a valid previously parked attempt before the person's Resume.
					wait := map[string]any{"scope": jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}, "target": flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID), WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16])}, "flow": "todo", "run": "run-1", "name": "resume#1"}
					pause, err := json.Marshal(map[string]any{"generation": 1, "run": "run-1", "requested": true, "at": "2026-10-07T18:51:00Z", "wait": wait})
					require.NoError(t, err)
					_, err = pool.Exec(ctx, `UPDATE mythical_items SET paused_at=NOW(),checks=jsonb_set(checks,'{pause}',$2::jsonb) WHERE id=$1`, item.ID, pause)
					require.NoError(t, err)
				}
				before, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				status, receipt := call("POST", fmt.Sprintf(`{"op":%q}`, op), "pause-kill-"+op)
				require.Equal(t, 202, status, receipt)
				point := op + "-" + crossing
				child := faultprocess.Start(t, "TestTodoPauseDeliveryCrashChild", "todo-pause-delivery", point, pool.Config().ConnString(), path)
				child.Await(t, faultprocess.Marker+point)
				child.Kill(t)
				fmt.Println(faultprocess.Marker + point)
				delivered, readErr := os.ReadFile(path)
				if crossing == "pre-delivery" {
					require.True(t, os.IsNotExist(readErr), "marker must precede the external effect")
				} else {
					require.NoError(t, readErr)
				}
				status, replayed := call("POST", fmt.Sprintf(`{"op":%q}`, op), "pause-kill-"+op)
				require.Equal(t, 202, status, replayed)
				require.Equal(t, receipt, replayed)
				workerCtx, cancel := context.WithCancel(ctx)
				done := make(chan error, 1)
				go func() {
					done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "pause-kill-recovery", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond})
				}()
				defer func() { cancel(); require.NoError(t, <-done) }()
				require.Eventually(t, func() bool {
					var count int
					err := pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal' AND state='completed'`).Scan(&count)
					return err == nil && count == 1
				}, 10*time.Second, 20*time.Millisecond)
				after, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.Attempt, after.Attempt)
				require.Equal(t, before.FlowDigest, after.FlowDigest)
				require.NotEqual(t, "cancelled", after.State)
				again, err := os.ReadFile(path)
				require.NoError(t, err)
				if crossing == "delivery" {
					require.Equal(t, delivered, again, "lost acknowledgment must reconcile the same external effect")
				}
				var signal flowruntime.Signal
				require.NoError(t, json.Unmarshal(again, &signal))
				require.Equal(t, "run-1", signal.RunID)
				require.JSONEq(t, "1", string(signal.Payload))
				expected := "pause"
				if op == "resume" {
					expected = "resume#1"
				}
				require.Equal(t, expected, signal.Name)
				var facts, intents int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type=$1`, "todo."+op+".requested").Scan(&facts))
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&intents))
				require.Equal(t, 1, facts)
				require.Equal(t, 1, intents)
				status, card := call("GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, map[string]any{"flow_name": "todo", "source_commit": strings.Repeat("a", 40), "digest": digest}, card["flow_version"])
				evidence := filepath.Join("../../../..", ".artifacts/checks/C-DUR-01", time.Now().UTC().Format("20060102T150405.000000000Z"), point)
				require.NoError(t, os.MkdirAll(evidence, 0700))
				observation, err := json.MarshalIndent(map[string]any{"point": point, "subject": "todo-pause-delivery", "signal_effects_seen": 1, "writes_acknowledged": 1, "writes_found": 1, "run": signal.RunID, "signal": signal.Name, "application_request_id": signal.ApplicationRequestID, "flow_version": card["flow_version"], "identity": faultprocess.Identity(t), "qualification": "protocol-peer; engine pause recovery remains required"}, "", "  ")
				require.NoError(t, err)
				require.NoError(t, os.WriteFile(filepath.Join(evidence, "observations.json"), observation, 0600))
				fmt.Printf("CRASH-OBSERVATION {\"point\":%q,\"subject\":\"todo-pause-delivery\",\"effectsSeen\":1,\"writesAcknowledged\":1,\"writesFound\":1,\"qualification\":\"protocol-peer; engine pause recovery remains required\"}\n", point)
			})
		}
	}
}
