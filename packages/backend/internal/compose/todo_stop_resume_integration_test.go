package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Only guest protocol observations are controlled. Commands cross the production
// resolver, PostgreSQL binding lease and authenticated runtime bridge.
type pauseReceiver struct {
	*reviewFixtureReceiver
	signals chan flowruntime.Signal
	reject  atomic.Bool
}

func (r *pauseReceiver) Signal(ctx context.Context, input flowruntime.Signal) (flowruntime.MutationResult, error) {
	select {
	case r.signals <- input:
	case <-ctx.Done():
		return flowruntime.MutationResult{}, ctx.Err()
	}
	if r.reject.Load() {
		return flowruntime.MutationResult{}, nil
	}
	return flowruntime.MutationResult{Operation: "signal", ApplicationRequestID: input.ApplicationRequestID, Receipt: flowruntime.Receipt{Tag: "Accepted", ReceiptID: input.ApplicationRequestID, RunID: input.RunID}}, nil
}

// todoControlHostTransport replaces the unavailable Linux guest transport, never the
// resolver or binding store. It reports the exact authenticated launch identity.
type todoControlHostTransport struct {
	starts   atomic.Int32
	mu       sync.Mutex
	launch   flowhost.HostLaunch
	endpoint string
	receiver flowruntime.Runtime
}

func (*todoControlHostTransport) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (h *todoControlHostTransport) InspectFlowHost(context.Context, flowhost.HostLaunch) (flowhost.Connection, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.launch.Credential == "" {
		return flowhost.Connection{}, flowhost.ErrHostNotRunning
	}
	return flowhost.Connection{Endpoint: h.endpoint}, nil
}
func (h *todoControlHostTransport) StartFlowHost(_ context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.launch = launch
	h.starts.Add(1)
	return flowhost.Connection{Endpoint: h.endpoint}, nil
}
func (h *todoControlHostTransport) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	launch := h.launch
	h.mu.Unlock()
	if launch.Credential == "" || r.Header.Get("Authorization") != "Bearer "+launch.Credential {
		http.Error(w, "unauthorized", 401)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/health" {
		_ = json.NewEncoder(w).Encode(map[string]any{"runtimeBridge": flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: launch.Binding.RuntimeArtifactDigest, SourceRevision: launch.Binding.SourceRevision, OwnerGeneration: launch.Binding.OwnerGeneration}})
		return
	}
	var command struct {
		Operation            string            `json:"operation"`
		ApplicationRequestID string            `json:"applicationRequestId"`
		RunID                string            `json:"runId"`
		OwnerGeneration      int64             `json:"ownerGeneration"`
		MessageID            string            `json:"messageId"`
		InputVersion         int64             `json:"version"`
		CreatedAt            float64           `json:"createdAt"`
		Attribution          map[string]string `json:"attribution"`
		Steer                struct {
			Kind string `json:"kind"`
			Body string `json:"body"`
		} `json:"steer"`
		Signal struct {
			Name    string          `json:"name"`
			Payload json.RawMessage `json:"payload"`
		} `json:"signal"`
	}
	if r.URL.Path == "/runtime/v1/observe" {
		var input struct {
			RunID string `json:"runId"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			http.Error(w, "invalid observation", 400)
			return
		}
		observed, err := h.receiver.Observe(r.Context(), input.RunID, "", 1)
		if err != nil {
			http.Error(w, "guest unavailable", 503)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"protocol": flowruntime.Protocol, "ok": true, "value": map[string]any{"run": observed.Run, "events": observed.Events, "nextCursor": observed.NextCursor, "hasMore": observed.HasMore, "terminal": observed.Terminal}})
		return
	}
	if r.URL.Path != "/runtime/v1/command" || json.NewDecoder(r.Body).Decode(&command) != nil || (command.Operation != "signal" && command.Operation != "steer") || command.OwnerGeneration != launch.Binding.OwnerGeneration {
		http.Error(w, "unsupported guest command", 400)
		return
	}
	var result flowruntime.MutationResult
	var err error
	if command.Operation == "steer" {
		result, err = h.receiver.Steer(r.Context(), flowruntime.Steer{ApplicationRequestID: command.ApplicationRequestID, OwnerGeneration: command.OwnerGeneration, RunID: command.RunID, MessageID: command.MessageID, InputVersion: command.InputVersion, CreatedAt: command.CreatedAt, Attribution: command.Attribution, Kind: command.Steer.Kind, Body: command.Steer.Body})
	} else {
		result, err = h.receiver.Signal(r.Context(), flowruntime.Signal{ApplicationRequestID: command.ApplicationRequestID, OwnerGeneration: command.OwnerGeneration, RunID: command.RunID, Name: command.Signal.Name, Payload: command.Signal.Payload})
	}
	if err != nil {
		http.Error(w, "guest unavailable", 503)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"protocol": flowruntime.Protocol, "ok": true, "value": map[string]any{"operation": result.Operation, "applicationRequestId": result.ApplicationRequestID, "receipt": result.Receipt}})
}

func TestTodoStopResumeComposedInstall(t *testing.T) {
	testTodoStopResumeComposedInstall(t, "running", "working")
}

func TestTodoHeldReviewStopResumeComposedInstall(t *testing.T) {
	testTodoStopResumeComposedInstall(t, "proposed", "in_review")
}

func TestReleasedTodoResumeAdmissionComposedInstall(t *testing.T) {
	testTodoStopResumeComposedInstall(t, "running", "working", true)
}

func testTodoStopResumeComposedInstall(t *testing.T, engineState, productState string, released ...bool) {
	scheduled := len(released) > 0 && released[0]

	if os.Getenv("SMITHERS_TEST_DATABASE_NAMESPACE") == "" {
		t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr6todocontrol")
	}
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
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
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: engineState, Checks: []byte(`{"todo":true,"run_launched":true,"run_attached":false}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,request_run_id='run-1',title='Interrupted',stack_position=1 WHERE id=$1`, item.ID, owner.ID)
	require.NoError(t, err)
	if engineState == "proposed" {
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET pr_number=41,pr_state='open',pr_head=repeat('c',40),pr_url='https://github.com/owner/app/pull/41' WHERE id=$1`, item.ID)
		require.NoError(t, err)
	}
	service := services.NewMythicalService(pool, nil)
	source, digest := strings.Repeat("a", 40), rehearsalBuiltinTodoDigest(t)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET flow_digest=$2,workspace_id='11111111-1111-4111-8111-111111111111',checks=jsonb_set(jsonb_set(checks,'{flowSource}',to_jsonb($3::text)),'{run_attached}','true') WHERE id=$1`, item.ID, digest, source)
	require.NoError(t, err)
	activeDigest := digest
	var activeReads atomic.Int32
	service.SetTodoFlow(func(context.Context, int64, string) (string, error) {
		activeReads.Add(1)
		return activeDigest, nil
	})
	receiver := &pauseReceiver{reviewFixtureReceiver: &reviewFixtureReceiver{}, signals: make(chan flowruntime.Signal, 10)}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,vm_id,status) VALUES('11111111-1111-4111-8111-111111111111',$1,$2,'pause-machine','running')`, repo.ID, owner.ID)
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("pause-host-test-key")
	require.NoError(t, err)
	bindings, err := flowhost.NewStore(pool, codec)
	require.NoError(t, err)
	transport := &todoControlHostTransport{receiver: receiver}
	guestServer := httptest.NewServer(transport)
	t.Cleanup(guestServer.Close)
	transport.endpoint = guestServer.URL
	var launcher flowhost.Launcher = transport
	var guest *releasedTodoGuest
	var disk atomic.Int64
	if scheduled {
		guest, launcher = composeReleasedTodoHost(t, pool, owner, repo.ID, item.ID, source, transport, &disk)
		composeAdmissionPublication(guest.queue, service)
	}
	resolver, err := flowhost.New(flowhost.Config{Store: bindings, Targets: services.NewMythicalFlowHostTargetResolver(service), Launcher: launcher, Catalogs: []flowhost.Catalog{{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/installed/coding-host", ArtifactDigest: strings.Repeat("a", 64), ServiceName: "coding-host", SystemFlows: services.SystemFlows}}})
	require.NoError(t, err)
	// The original run already owns a verified host. Reads and control signals
	// inspect that binding; they cannot start a replacement guest.
	initialTarget := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID), WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(item.ID.Bytes).String()}
	_, err = resolver.ResolveFlowRuntime(ctx, initialTarget)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: service, Resolver: installFlowResolver{resolver}})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(item.ID.Bytes).String()}
	projection, _ := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16]), "generation": item.Generation, "attempt": 1, "phase": "todo", "flowDigest": digest, "flowSource": source})
	raw := "interrupted-session"
	hash := sha256.Sum256([]byte(raw))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(t.Context()))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	topics := &liveTopics{queries: q, todos: service, jobs: store}
	liveHandler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(t.Context(), nil), Origins: func() []string { return cfg.Server.AllowedOrigins }, Topics: topics.resolver}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}, Live: liveHandler})
	server.Start()
	t.Cleanup(server.Close)
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

	// Hold one real subscription across all control transitions. Durable TODO
	// facts must advance the source cursor, rather than polling a seeded card.
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + raw}, "Origin": {origin}}})
	require.NoError(t, err)
	t.Cleanup(func() { socket.CloseNow() })
	require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1"}`)))
	var lastCursor int64 = -1
	observeCard := func(predicate func(map[string]any) bool) {
		t.Helper()
		readCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		for {
			_, raw, err := socket.Read(readCtx)
			require.NoError(t, err)
			var frame live.Frame
			require.NoError(t, json.Unmarshal(raw, &frame))
			require.NotEqual(t, "err", frame.T, string(raw))
			require.NotEqual(t, "gap", frame.T, string(raw))
			if frame.T != "snap" && frame.T != "delta" {
				continue
			}
			var card map[string]any
			require.NoError(t, json.Unmarshal(frame.Data, &card))
			if frame.T == "delta" {
				var fact struct{ Data struct{ Card map[string]any } }
				require.NoError(t, json.Unmarshal(frame.Data, &fact))
				card = fact.Data.Card
			}
			if card == nil || !predicate(card) {
				continue
			}
			require.NotNil(t, frame.Cursor)
			require.Greater(t, *frame.Cursor, lastCursor, "a new lifecycle fact needs a new durable source cursor")
			lastCursor = *frame.Cursor
			return
		}
	}
	observeCard(func(card map[string]any) bool { return card["state"] == productState })

	// Every refusal precedes runtime intent and leaves the item unchanged.
	original, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	for _, test := range []struct {
		name, sql string
		status    int
	}{
		{"question", `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[{"id":"q","kind":"question","prompt":"Which?","since":"2026-10-06T00:00:00Z"}]') WHERE id=$1`, 409},
		{"approval", `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[{"id":"a","kind":"approval","prompt":"Allow?","since":"2026-10-06T00:00:00Z"}]') WHERE id=$1`, 409},
		{"starting", `UPDATE mythical_items SET checks=jsonb_set(checks,'{run_attached}','false') WHERE id=$1`, 409},
		{"ended run", `UPDATE mythical_items SET request_outcome='validated' WHERE id=$1`, 409},
		{"failed", `UPDATE mythical_items SET state='blocked' WHERE id=$1`, 409},
		{"unknown protocol", `UPDATE mythical_items SET flow_digest=repeat('f',64) WHERE id=$1`, 503},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, test.sql, item.ID)
			require.NoError(t, err)
			before, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			status, body := call("POST", `{"op":"stop"}`, test.name)
			require.Equal(t, test.status, status, body)
			after, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, before, after)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,flow_digest=$4,request_outcome=$5 WHERE id=$1`, item.ID, original.State, original.Checks, original.FlowDigest, original.RequestOutcome)
			require.NoError(t, err)
		})
	}
	service.SetLauncher(nil)
	status, body := call("POST", `{"op":"stop"}`, "uncomposed")
	require.Equal(t, 503, status, body)
	service.SetLauncher(dispatcher)
	// A run credential cannot control TODOs. A delegated person credential
	// (via:codex) is allowed by MVP Appendix C and is not a run credential.
	for index, scopes := range []string{"read:repository,write:repository", "read:repository,via:codex"} {
		token := "smithers_" + strings.Repeat([]string{"d", "e"}[index], 40)
		tokenBytes := sha256.Sum256([]byte(token))
		tokenHash := hex.EncodeToString(tokenBytes[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: fmt.Sprintf("pause-agent-%d", index), TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: scopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		for _, op := range []string{"stop", "resume"} {
			req, err := http.NewRequest("POST", origin+"/api/todos/1", strings.NewReader(fmt.Sprintf(`{"op":%q}`, op)))
			require.NoError(t, err)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", "agent-"+op)
			response, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, 403, response.StatusCode)
		}
	}

	var intents int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&intents))
	require.Zero(t, intents)
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_pause_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pause fact unavailable'; END $$;
 CREATE TRIGGER refuse_pause_fact BEFORE INSERT ON product_job_events FOR EACH ROW WHEN (NEW.event_type='todo.stop.requested') EXECUTE FUNCTION refuse_pause_fact()`)
	require.NoError(t, err)
	status, body = call("POST", `{"op":"stop"}`, "rollback")
	require.Equal(t, 503, status, body)
	afterFailure, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, original, afterFailure)
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_pause_fact ON product_job_events; DROP FUNCTION refuse_pause_fact()`)
	require.NoError(t, err)
	status, card := call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, productState, card["state"])
	require.Equal(t, true, card["run"].(map[string]any)["executing"])
	status, receipt := call("POST", `{"op":"stop"}`, "stop-1")
	require.Equal(t, 202, status, receipt)
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, productState, card["state"])
	require.Equal(t, "requested", card["stop"])
	observeCard(func(card map[string]any) bool { return card["stop"] == "requested" })
	status, replay := call("POST", `{"op":"stop"}`, "stop-1")
	require.Equal(t, 202, status, replay)
	require.Equal(t, receipt, replay)
	status, _ = call("POST", `{"op":"stop"}`, "stop-2")
	require.Equal(t, 409, status)
	status, _ = call("POST", `{"op":"resume"}`, "early-resume")
	require.Equal(t, 409, status)
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "fr6-controls", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond})
	}()
	t.Cleanup(func() { cancel(); require.NoError(t, <-done) })
	select {
	case signal := <-receiver.signals:
		require.Equal(t, "pause", signal.Name)
		require.JSONEq(t, "1", string(signal.Payload))
		require.Equal(t, "run-1", signal.RunID)
	case <-time.After(5 * time.Second):
		var failure string
		_ = pool.QueryRow(ctx, `SELECT last_error FROM product_job_dispatches ORDER BY updated_at DESC LIMIT 1`).Scan(&failure)
		t.Fatalf("Stop not dispatched: %s", failure)
	}
	projectWaits := func(waits []flowruntime.PendingWait, statuses ...string) {
		runStatus := "running"
		if len(statuses) > 0 {
			runStatus = statuses[0]
		}
		require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, Target: target, FlowID: "todo", RunID: "run-1", ExecutionDigest: digest, Run: &flowruntime.Run{RunID: "run-1", FlowID: "todo", Status: runStatus, PendingWaits: waits}}}))
	}
	project := func(name string) {
		var waits []flowruntime.PendingWait
		if name != "" {
			waits = []flowruntime.PendingWait{{RunID: "child", Token: "durable-token", Name: name, Reason: "approval", Request: json.RawMessage(`{"kind":"pause"}`)}}
		}
		projectWaits(waits)
	}
	for _, invalid := range []struct {
		name   string
		mutate func(*flowruntime.PendingWait)
	}{
		{"missing token", func(w *flowruntime.PendingWait) { w.Token = "" }},
		{"question reason", func(w *flowruntime.PendingWait) { w.Reason = "question" }},
		{"question request", func(w *flowruntime.PendingWait) { w.Request = json.RawMessage(`{"kind":"question"}`) }},
		{"malformed request", func(w *flowruntime.PendingWait) { w.Request = json.RawMessage(`"not JSON"`) }},
		{"old cycle", func(w *flowruntime.PendingWait) { w.Name, w.Attempt = "resume", 0 }},
		{"future cycle", func(w *flowruntime.PendingWait) { w.Name, w.Attempt = "resume", 2 }},
		{"fractional cycle", func(w *flowruntime.PendingWait) { w.Name, w.Attempt = "resume", 1.5 }},
	} {
		t.Run("Stop ignores invalid park "+invalid.name, func(t *testing.T) {
			wait := flowruntime.PendingWait{RunID: "child", Token: "durable-token", Name: "resume#1", Reason: "approval", Request: json.RawMessage(`{"kind":"pause"}`)}
			invalid.mutate(&wait)
			projectWaits([]flowruntime.PendingWait{wait})
			_, card := call("GET", "", "")
			require.Equal(t, productState, card["state"])
			require.Equal(t, "requested", card["stop"])
			require.NotContains(t, card, "pause")
			saved, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.False(t, saved.PausedAt.Valid)
			require.Equal(t, "run-1", saved.RequestRunID)
			require.EqualValues(t, 1, saved.Attempt)
		})
	}
	project("resume#99")
	_, card = call("GET", "", "")
	require.Equal(t, productState, card["state"])
	projectWaits([]flowruntime.PendingWait{{RunID: "child", Token: "durable-token", Name: "resume", Attempt: 1, Reason: "approval", Request: json.RawMessage(`"{\"kind\":\"pause\",\"name\":\"resume#1\"}"`)}})
	_, card = call("GET", "", "")
	require.Equal(t, "paused", card["state"])
	require.Equal(t, "person", card["pause"].(map[string]any)["reason"])
	observeCard(func(card map[string]any) bool { return card["state"] == "paused" })
	if engineState == "proposed" {
		require.EqualValues(t, 41, card["pr"].(map[string]any)["number"])
		require.Equal(t, strings.Repeat("c", 40), card["pr"].(map[string]any)["head"])
		require.Equal(t, false, card["pr"].(map[string]any)["draft"])
		parked, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, "open", parked.PRState)
	}

	require.Equal(t, map[string]any{"flow_name": "todo", "source_commit": source, "digest": digest}, card["flow_version"])
	// A new Active version arrives while the original run is stopped. Resume
	// must signal that same run without reading Active or rewriting its pin.
	activeDigest = strings.Repeat("f", 64)
	_, err = pool.Exec(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,$2,$3,'loaded')`, repo.ID, strings.Repeat("b", 40), activeDigest)
	require.NoError(t, err)
	// Persisted waits must belong to this exact cycle and authority. A stale
	// wait cannot admit a freshly reconstructed signal for another cycle.
	parked, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	for _, corrupt := range []struct{ name, path, value string }{
		{"cycle", "{pause,wait,name}", `"resume#99"`},
		{"flow", "{pause,wait,flow}", `"review"`},
		{"tenant", "{pause,wait,scope,TenantID}", `"repository:999"`},
		{"principal", "{pause,wait,scope,PrincipalID}", `"user:999"`},
	} {
		t.Run("Resume refuses stale "+corrupt.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,$2::text[],$3::jsonb) WHERE id=$1`, item.ID, corrupt.path, corrupt.value)
			require.NoError(t, err)
			before, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			var intentsBefore, intentsAfter int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&intentsBefore))
			status, body := call("POST", `{"op":"resume"}`, "stale-"+corrupt.name)
			require.Equal(t, 503, status, body)
			after, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, before, after)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&intentsAfter))
			require.Equal(t, intentsBefore, intentsAfter)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=$2 WHERE id=$1`, item.ID, parked.Checks)
			require.NoError(t, err)
		})
	}
	// A branch wait masks the pause, and Resume leaves that wait untouched.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[{"id":"foreign","kind":"foreign_push","prompt":"Push","since":"2026-10-06T00:00:00Z"}]') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	_, card = call("GET", "", "")
	require.Equal(t, "needs_you", card["state"])
	require.Contains(t, card, "pause")
	if scheduled {
		guest.mu.Lock()
		guest.state = workspaceapi.WorkspaceStopped
		guest.mu.Unlock()
		_, err = pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, guest.row.ID)
		require.NoError(t, err)
		disk.Store(40 << 30)
	}
	status, receipt = call("POST", `{"op":"resume"}`, "resume-1")
	if scheduled {
		require.Eventually(t, func() bool {
			for _, row := range guest.queue.AdmissionSnapshot() {
				if row.Holder == "workspace:"+guest.row.ID {
					return row.Class == "person" && row.State == "waiting" && row.Position == 1
				}
			}
			return false
		}, 8*time.Second, 10*time.Millisecond)
		require.Empty(t, receiver.signals, "Resume must wait for capacity before delivery")
		require.EqualValues(t, 1, transport.starts.Load())
		require.Zero(t, guest.queue.InUse())
		disk.Store(140 << 30)
	}

	require.Equal(t, 202, status, receipt)
	_, card = call("GET", "", "")
	require.Equal(t, "needs_you", card["state"])
	require.Contains(t, card, "pause", "admission is not completion")
	select {
	case signal := <-receiver.signals:
		require.Equal(t, "resume#1", signal.Name)
		require.Equal(t, "run-1", signal.RunID)
	case <-time.After(5 * time.Second):
		t.Fatal("Resume not dispatched")
	}
	require.Eventually(t, func() bool {
		saved, e := q.GetMythicalItem(ctx, item.ID)
		return e == nil && strings.Contains(string(saved.Checks), `"delivered": true`)
	}, 5*time.Second, 10*time.Millisecond)
	project("resume#1")
	_, card = call("GET", "", "")
	require.Contains(t, card, "pause", "old parked checkpoints cannot report resumed")
	projectWaits(nil, "parked")
	_, card = call("GET", "", "")
	require.Equal(t, "needs_you", card["state"])
	require.NotContains(t, card, "pause")
	observeCard(func(card map[string]any) bool { return card["state"] == "needs_you" && card["pause"] == nil })
	require.Equal(t, map[string]any{"flow_name": "todo", "source_commit": source, "digest": digest}, card["flow_version"])
	require.Zero(t, activeReads.Load(), "Stop and Resume must not resolve the newer Active version")
	saved, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, "run-1", saved.RequestRunID)
	require.EqualValues(t, 1, saved.Attempt)
	require.Equal(t, digest, saved.FlowDigest.String)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[]') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	// A later Stop uses another wait, on the same run and pin.
	status, _ = call("POST", `{"op":"stop"}`, "stop-cycle-2")
	require.Equal(t, 202, status)
	select {
	case signal := <-receiver.signals:
		require.Equal(t, "pause", signal.Name)
		require.JSONEq(t, "2", string(signal.Payload))
	case <-time.After(5 * time.Second):
		t.Fatal("second Stop not dispatched")
	}
	project("resume#1")
	_, card = call("GET", "", "")
	require.Equal(t, productState, card["state"])
	project("resume#2")
	_, card = call("GET", "", "")
	require.Equal(t, "paused", card["state"])
	// A bad runtime receipt is a visible delivery failure, never Resumed.
	// A new person request retries the same wait, run and attempt.
	receiver.reject.Store(true)
	status, _ = call("POST", `{"op":"resume"}`, "failed-resume")
	require.Equal(t, 202, status)
	select {
	case signal := <-receiver.signals:
		require.Equal(t, "resume#2", signal.Name)
	case <-time.After(5 * time.Second):
		t.Fatal("failed Resume was not dispatched")
	}
	require.Eventually(t, func() bool { _, card = call("GET", "", ""); return card["control_failure"] != nil }, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, "paused", card["state"])
	require.Equal(t, map[string]any{"op": "resume", "message": "Resume failed"}, card["control_failure"])
	receiver.reject.Store(false)
	status, _ = call("POST", `{"op":"resume"}`, "retried-resume")
	require.Equal(t, 202, status)
	select {
	case signal := <-receiver.signals:
		require.Equal(t, "resume#2", signal.Name)
		require.Equal(t, "run-1", signal.RunID)
	case <-time.After(5 * time.Second):
		t.Fatal("retried Resume was not dispatched")
	}
	require.Eventually(t, func() bool {
		saved, e := q.GetMythicalItem(ctx, item.ID)
		return e == nil && strings.Contains(string(saved.Checks), `"delivered": true`)
	}, 5*time.Second, 10*time.Millisecond)
	project("")
	_, card = call("GET", "", "")
	require.Equal(t, productState, card["state"])
	require.NotContains(t, card, "control_failure")
	saved, err = q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, saved.Attempt)
	require.Equal(t, "run-1", saved.RequestRunID)
	require.Equal(t, digest, saved.FlowDigest.String)
	// Completion may win after admission but before the next pause boundary.
	// It must settle the Stop request visibly, rather than leave a live toast.
	status, _ = call("POST", `{"op":"stop"}`, "stop-at-completion")
	require.Equal(t, 202, status)
	select {
	case <-receiver.signals:
	case <-time.After(5 * time.Second):
		t.Fatal("final Stop was not dispatched")
	}
	output := `{"plan":{"changes":[]},"outcome":{"status":"validated","rounds":1,"blocked":null,"result":{"status":"validated","findings":[],"changes":[]}}}`
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateCompleted,
		Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, Target: target, FlowID: "todo", RunID: "run-1", ExecutionDigest: digest,
			Run: &flowruntime.Run{RunID: "run-1", FlowID: "todo", Status: "completed", FinalOutput: &output}}}))
	_, card = call("GET", "", "")
	require.NotContains(t, card, "pause")
	require.Equal(t, map[string]any{"op": "stop", "message": "Finished before Stop"}, card["control_failure"])
	expectedStarts := 1
	if scheduled {
		expectedStarts = 2
		require.Equal(t, 1, guest.queue.InUse())
	}
	require.EqualValues(t, expectedStarts, transport.starts.Load(), "control retries reuse the fenced host after a released machine wakes")

}

// Guest observations only: production box preparation, wake, member authority,
// slot allocation, credentials and dispatch remain installed implementations.
type releasedTodoGuest struct {
	*perfWakeRuntime
	source, clone string
}

func (r *releasedTodoGuest) EnsureMachined(context.Context, string) error { return nil }
func (r *releasedTodoGuest) Capabilities() workspaceapi.WorkspaceCapabilities {
	c := r.perfWakeRuntime.Capabilities()
	c.ManagedServices = true
	return c
}
func (r *releasedTodoGuest) InstallWorkspaceCodingBinding(_ context.Context, _ string, b workspaceapi.WorkspaceCodingBinding) error {
	return b.Validate()
}
func (r *releasedTodoGuest) ReadFile(ctx context.Context, id, path string) ([]byte, error) {
	b, e := r.perfWakeRuntime.ReadFile(ctx, id, path)
	return []byte(strings.ReplaceAll(strings.ReplaceAll(string(b), perfWakeHead, r.source), perfWakeClone, r.clone)), e
}
func (r *releasedTodoGuest) ExecuteCommand(ctx context.Context, id string, c workspaceapi.Command) (workspaceapi.CommandResult, error) {
	for i, v := range c.Args {
		c.Args[i] = strings.ReplaceAll(v, r.source, perfWakeHead)
	}
	result, e := r.perfWakeRuntime.ExecuteCommand(ctx, id, c)
	result.Stdout = strings.ReplaceAll(strings.ReplaceAll(result.Stdout, perfWakeHead, r.source), perfWakeClone, r.clone)
	return result, e
}

type releasedTodoTransport struct {
	*todoControlHostTransport
	guest *releasedTodoGuest
}

func (r *releasedTodoTransport) InspectFlowHost(ctx context.Context, l flowhost.HostLaunch) (flowhost.Connection, error) {
	w, e := r.guest.InspectWorkspace(ctx, l.Authority.WorkspaceID)
	if e != nil {
		return flowhost.Connection{}, e
	}
	if w.State != workspaceapi.WorkspaceRunning {
		return flowhost.Connection{}, workspaceapi.ErrWorkspaceStopped
	}
	return r.todoControlHostTransport.InspectFlowHost(ctx, l)
}
func (r *releasedTodoTransport) ResolveFlowHostSource(context.Context, flowhost.Authority) (string, error) {
	return r.guest.source, nil
}
func (r *releasedTodoTransport) StopFlowHost(context.Context, flowhost.Binding) error {
	r.mu.Lock()
	r.launch = flowhost.HostLaunch{}
	r.mu.Unlock()
	return nil
}

func composeReleasedTodoHost(t *testing.T, pool *pgxpool.Pool, owner db.User, repository int64, itemID pgtype.UUID, source string, transport *todoControlHostTransport, disk *atomic.Int64) (*releasedTodoGuest, flowhost.Launcher) {
	t.Helper()
	ctx, q := t.Context(), db.New(pool)
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\necho '[]'\n"), 0700))
	queue, e := microsandbox.New(t.Context(), microsandbox.Config{Root: filepath.Join(root, "runtime"), Binary: binary, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768, MaxRunningVMs: 1, HostProfile: &microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 8, DiskFreeBytes: 140 << 30}, SkipQualification: true})
	require.NoError(t, e)
	t.Cleanup(func() { require.NoError(t, queue.Close()) })
	queue.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
	machineOwner, e := q.GetBranchMachineOwner(ctx)
	require.NoError(t, e)
	_, e = pool.Exec(ctx, `UPDATE workspaces SET user_id=$1,vm_id=id,target_bookmark='todo/1' WHERE id='11111111-1111-4111-8111-111111111111'`, machineOwner)
	require.NoError(t, e)
	_, e = pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES('11111111-1111-4111-8111-111111111111',$1,$2,'write')`, machineOwner, owner.ID)
	require.NoError(t, e)
	_, e = pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES('11111111-1111-4111-8111-111111111111',$1,$2,'todo')`, repository, itemID)
	require.NoError(t, e)
	row, e := q.GetWorkspace(ctx, "11111111-1111-4111-8111-111111111111")
	require.NoError(t, e)
	guest := &releasedTodoGuest{perfWakeRuntime: &perfWakeRuntime{queue: queue, row: row, state: workspaceapi.WorkspaceRunning, entered: make(chan struct{})}, source: source, clone: "http://127.0.0.1:4000/" + owner.Username + "/app.git"}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	auth := services.NewAuthService(q, cfg.Auth, nil, nil)
	boxes := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(guest), services.WithWorkspaceTransactions(pool), services.WithWorkspaceInstallAuthorization(q), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), guest)), services.WithWorkspaceCredentialIssuer(auth), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"), services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy())))
	disk.Store(140 << 30)
	boxes.EnableMachineAdmission(func(context.Context) (int64, error) { return disk.Load(), nil })
	launcher := newBoxHostLauncher(&releasedTodoTransport{todoControlHostTransport: transport, guest: guest}, boxes, nil)
	return guest, launcher
}
