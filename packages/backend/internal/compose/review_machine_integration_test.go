package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// These test-only dependency ports cannot qualify root inputs, pinned module
// imports or microVM isolation. The machine adapter, worker, database, delivery,
// GitHub client and HTTP admission/read doors are production implementations.
func exerciseReviewMachine(t *testing.T, pool *pgxpool.Pool, service *services.MythicalService, chatStore *chat.Store, router http.Handler, repository, user int64, successfulTerminal bool) {
	ctx := t.Context()
	defer func() {
		if !t.Failed() {
			return
		}
		rows, e := pool.Query(context.Background(), `SELECT event_type,data::text FROM product_job_events WHERE event_type IN ('terminal.failed','branch.machine.failed')`)
		if e != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			var kind, body string
			_ = rows.Scan(&kind, &body)
			t.Log(kind, body)
		}
	}()
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	root := t.TempDir()
	q := db.New(pool)
	machines, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	personBranch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repository, UserID: machines, Name: "review-waiter", TargetBookmark: "scratch/review-owner/review-waiter", Kind: "container", Status: "suspended"})
	require.NoError(t, err)
	if successfulTerminal {
		_, err = pool.Exec(ctx, `UPDATE workspaces SET kind='vm' WHERE id=$1`, personBranch.ID)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id=id WHERE id=$1`, personBranch.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET unix_login='review-owner',unix_uid=20000 WHERE repository_id=$1 AND user_id=$2`, repository, user)
	require.NoError(t, err)
	runtimeRoot := filepath.Join(root, "runtime")
	sum := sha256.Sum256([]byte(personBranch.ID))
	machineName := "smthrs-ws-01234567-" + hex.EncodeToString(sum[:])[:20]
	directory := filepath.Join(runtimeRoot, "workspaces", hex.EncodeToString(sum[:]))
	require.NoError(t, os.MkdirAll(directory, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(runtimeRoot, "owner"), []byte("smithers-backend-0123456789abcdef\n"), 0600))
	metadata, err := json.Marshal(map[string]any{"version": 1, "id": personBranch.ID, "machine": machineName, "state": "stopped"})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(directory, "metadata.json"), metadata, 0600))
	releaseBoot := filepath.Join(root, "release-boot")
	stopPending := filepath.Join(root, "stop-pending")
	stopAcknowledged := filepath.Join(root, "stop-acknowledged")
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf(`#!/bin/sh
case "$1" in
 list) if [ -f %q ]; then printf '[{"name":%q,"status":"running"}]\n'; else printf '[{"name":%q,"status":"stopped"}]\n'; fi ;;
 stop) touch %q; printf '[]\n' ;;
 start|run|create) while [ ! -f %q ]; do sleep 0.05; done; exit 1 ;;
 *) printf '[]\n' ;;
esac
`, stopPending, machineName, machineName, stopAcknowledged, releaseBoot)), 0700))
	t.Cleanup(func() { _ = os.WriteFile(releaseBoot, nil, 0600) })
	queue, err := microsandbox.New(ctx, microsandbox.Config{Root: filepath.Join(root, "runtime"), Binary: binary, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768, MaxRunningVMs: 1, HostProfile: &microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 8, DiskFreeBytes: 140 << 30}, SkipQualification: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, queue.Close()) })
	queue.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
	personProviders := microsandbox.AdmissionProviders{Ready: func(context.Context, microsandbox.AdmissionRequest) error { return nil }, FreeDisk: func(context.Context) (int64, error) { return 140 << 30, nil }}
	_, err = queue.WaitAdmission(ctx, personProviders, "person", "held", "owner", "terminal")
	require.NoError(t, err)
	composeAdmissionPublication(queue, service)
	runtime := &reviewRuntimeContract{queue: queue, head: strings.Repeat("a", 40), loseLaunch: true, loseApproval: true, failDelete: true}
	source := &reviewSourceContract{}
	machine := &reviewMachine{pool: pool, jobs: store, workspace: runtime, source: source}
	codec, err := webhook.NewSecretCodec("review-admission-host-key")
	require.NoError(t, err)
	bindings, err := flowhost.NewStore(pool, codec)
	require.NoError(t, err)
	transport := &reviewHostTransport{todoControlHostTransport: &todoControlHostTransport{receiver: runtime}, pool: pool, machine: reviewMachineName}
	guestServer := httptest.NewServer(transport)
	t.Cleanup(guestServer.Close)
	transport.endpoint = guestServer.URL
	resolver, err := flowhost.New(flowhost.Config{Store: bindings, Targets: machine, Launcher: transport, Catalogs: []flowhost.Catalog{{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/installed/coding-host", ArtifactDigest: strings.Repeat("d", 64), ServiceName: "coding-host", SystemFlows: services.SystemFlows}}})
	require.NoError(t, err)
	machine.resolver, machine.existing = resolver, resolver
	background, err := services.NewReviewBackground(pool, service, machine, reviewConversationDelivery{store: chatStore, resolve: conversationBranchResolver(services.NewWorkspaceService(db.New(pool)))})
	require.NoError(t, err)
	service.SetReviewBackground(background)
	call := func(key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "http://localhost:4000/api/reviews", strings.NewReader(`{"number":50,"conversation":"main"}`))
		req.RemoteAddr = "127.0.0.1:61000"
		req.Header.Set("Origin", "http://localhost:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "review-csrf")
		req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "review-csrf"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	machine.source = nil
	refused := call("adapter-no-source")
	require.Equal(t, 503, refused.Code, refused.Body.String())
	require.Contains(t, refused.Body.String(), "review_source_unavailable")
	require.Zero(t, runtime.creates)
	machine.source = source
	source.refusal = reviewRefusal("review_root_boundary_unavailable")
	refused = call("adapter-no-root")
	require.Equal(t, 503, refused.Code, refused.Body.String())
	require.Zero(t, runtime.creates)
	source.refusal = nil
	machine.workspace = struct {
		workspace.WorkspaceLifecycle
		workspace.WorkspaceSourceRevisionResolver
	}{runtime, runtime}
	refused = call("adapter-no-admission")
	require.Equal(t, 503, refused.Code, refused.Body.String())
	require.Contains(t, refused.Body.String(), "review_admission_unavailable")
	require.Zero(t, runtime.creates)
	machine.workspace = runtime
	// Person demand enters the install HTTP terminal door and is observed on
	// an authenticated live subscription; only boot/stop responses are injected.
	terminalServer := httptest.NewUnstartedServer(nil)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://" + terminalServer.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	auth := services.NewAuthService(q, cfg.Auth, nil, nil)
	auth.Members = &services.Members{Pool: pool}
	var personRuntime workspace.WorkspaceRuntime = queue
	registry := new(machined.Registry)
	if successfulTerminal {
		personBranch, err = q.GetWorkspace(ctx, personBranch.ID)
		require.NoError(t, err)
		reader, writer := io.Pipe()
		guest := &releasedTodoGuest{perfWakeRuntime: &perfWakeRuntime{queue: queue, row: personBranch, state: workspace.WorkspaceStopped, mode: "warm", entered: make(chan struct{})}, source: perfWakeHead, clone: "http://127.0.0.1:4000/review-owner/app.git"}
		guest.owner = &terminalMemberRuntime{replacementRuntime: &replacementRuntime{repoID: repository}, terminal: &echoOwnerTerminal{reader: reader, writer: writer}, branch: personBranch, member: microsandbox.MemberIdentity{Login: "review-owner", UID: 20000, Active: true}}
		personRuntime = &successfulReviewPersonGuest{releasedTodoGuest: guest, machine: machineName}
		registry = &guest.registry
		link, _ := presenceTestLink(t, registry, personBranch.ID)
		require.NoError(t, link.Reconciled())
	}
	workspaces := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(personRuntime), services.WithWorkspaceTransactions(pool),
		services.WithWorkspaceInstallAuthorization(q), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), personRuntime)),
		services.WithWorkspaceCredentialIssuer(auth), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"),
		services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy())))
	workspaces.BindBranchTerminalHost(func(context.Context, db.Workspace, int64) error { return nil })
	workspaces.EnableMachineAdmission(func(context.Context) (int64, error) { return 140 << 30, nil })
	terminal := &routes.WorkspaceTerminalHandler{OwnerOnly: true, Service: workspaces, SessionCookieName: "session", AllowedOrigins: cfg.Server.AllowedOrigins}
	manager := terminal.SharedTerminalSessions()
	t.Cleanup(manager.Close)
	auth.TerminalSubject = manager.OwnsSubject
	provider := &installOwnerTerminals{queries: q, branches: workspaces, registry: registry}
	provider.Bind(manager)
	terminal.OwnerTerminals = provider
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	presence := &branchPresence{queries: q, branches: workspaces}
	if successfulTerminal {
		presence.hosts = bindings
		presence.dispatcher, err = flowdispatch.New(flowdispatch.Config{Store: store, Resolver: installFlowResolver{resolver}})
		require.NoError(t, err)
		projector := services.NewMythicalService(pool, nil)
		projector.SetInstallParallel(&services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 8, DiskFreeBytes: 140 << 30}, FreeDisk: func(context.Context) (int64, error) { return 140 << 30, nil }, InUse: queue.InUse})
		projector.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(workspaces))
		go projector.StartMachineQueueProjection(ctx)
	}
	topics := &liveTopics{queries: q, todos: service, jobs: store, presence: presence}
	liveHandler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(ctx, nil), Origins: func() []string { return cfg.Server.AllowedOrigins }, Topics: topics.resolver}
	terminalServer.Config.Handler = parallelInstallRouter(cfg, q, pool, terminal, routerExtras{Live: liveHandler})
	terminalServer.Start()
	t.Cleanup(terminalServer.Close)
	accepted := call("adapter-review")
	require.Equal(t, 202, accepted.Code, accepted.Body.String())
	var admission services.ReviewAdmission
	require.NoError(t, json.Unmarshal(accepted.Body.Bytes(), &admission))
	require.Zero(t, runtime.creates, "the HTTP response must precede execution")
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- background.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "review-adapter", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
	}()
	defer func() { cancel(); require.NoError(t, <-done) }()
	require.Eventually(t, func() bool {
		for _, row := range queue.AdmissionSnapshot() {
			if row.Actor == admission.OperationID {
				return row.Class == "background" && row.State == "waiting" && row.Position == 1
			}
		}
		return false
	}, 5*time.Second, 10*time.Millisecond)
	runtime.mu.Lock()
	require.Zero(t, runtime.creates, "queued reviews never allocate a VM")
	runtime.mu.Unlock()
	request, err := http.NewRequestWithContext(ctx, "POST", terminalServer.URL+"/api/terminals", strings.NewReader(fmt.Sprintf(`{"branch":%q}`, personBranch.ID)))
	require.NoError(t, err)
	request.Header.Set("Origin", cfg.Server.PublicURL)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", uuid.NewString())
	request.Header.Set("X-CSRF-Token", "review-csrf")
	request.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
	request.AddCookie(&http.Cookie{Name: "__csrf", Value: "review-csrf"})
	terminalResponse, err := terminalServer.Client().Do(request)
	require.NoError(t, err)
	body, err := io.ReadAll(terminalResponse.Body)
	terminalResponse.Body.Close()
	require.NoError(t, err)
	require.Equal(t, 202, terminalResponse.StatusCode, string(body))
	var person services.WorkspaceSessionResponse
	require.NoError(t, json.Unmarshal(body, &person))
	personHolder := "workspace:" + personBranch.ID
	require.Eventually(t, func() bool {
		for _, row := range queue.AdmissionSnapshot() {
			if row.Holder == personHolder && row.Class == "person" && row.State == "waiting" && row.Position == 1 {
				return true
			}
		}
		return false
	}, 5*time.Second, 10*time.Millisecond)
	for _, row := range queue.AdmissionSnapshot() {
		if row.Actor == admission.OperationID {
			require.Equal(t, 2, row.Position)
		}
	}
	var homeSocket *websocket.Conn
	if successfulTerminal {
		home, _, e := websocket.Dial(ctx, "ws"+strings.TrimPrefix(terminalServer.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {cfg.Server.PublicURL}, "Cookie": {"session=review-cookie"}}})
		require.NoError(t, e)
		sendPresenceFrame(t, home, `{"t":"sub","id":2,"topic":"home"}`)
		frame := readPresenceFrame(t, home)
		require.Equal(t, "snap", frame.T, "%+v", frame)
		var card struct {
			BackgroundRuns []struct{ ID, Title, State, Detail string } `json:"background_runs"`
		}
		require.NoError(t, json.Unmarshal(frame.Data, &card))
		require.Len(t, card.BackgroundRuns, 1)
		require.Equal(t, admission.OperationID, card.BackgroundRuns[0].ID)
		require.Equal(t, "Review · #50", card.BackgroundRuns[0].Title)
		require.Equal(t, "waiting", card.BackgroundRuns[0].State)
		require.Equal(t, "waiting for a machine #2", card.BackgroundRuns[0].Detail)
		homeSocket = home
		defer home.CloseNow()
	}
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(terminalServer.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {cfg.Server.PublicURL}, "Cookie": {"session=review-cookie"}}})
	require.NoError(t, err)
	defer conn.CloseNow()
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, personBranch.ID))
	readMachine := func(state string, position int) liveFrame {
		for {
			frame := readPresenceFrame(t, conn)
			require.NotEqual(t, "err", frame.T, "%+v", frame)
			if frame.T != "snap" && frame.T != "delta" {
				continue
			}
			data := frame.Data
			if frame.T == "delta" {
				var fact struct {
					Data struct{ Branch json.RawMessage }
				}
				require.NoError(t, json.Unmarshal(data, &fact))
				if len(fact.Data.Branch) == 0 {
					continue
				}
				data = fact.Data.Branch
			}
			var card struct {
				Machine struct {
					State    string `json:"state"`
					Position int    `json:"position"`
				} `json:"machine"`
			}
			require.NoError(t, json.Unmarshal(data, &card))
			if card.Machine.State == state && card.Machine.Position == position {
				return frame
			}
		}
	}
	waiting := readMachine("waiting", 1)
	queue.ConfirmAdmissionStop("held", false) // initial occupied-slot observation
	require.Eventually(t, func() bool { return queue.AdmissionHeld(personHolder) }, 5*time.Second, 10*time.Millisecond)
	grantedState := "waking"
	if successfulTerminal {
		require.Eventually(t, func() bool {
			var count int
			return pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='terminal.running' AND data->>'session'=$1`, person.ID).Scan(&count) == nil && count == 1
		}, 5*time.Second, 10*time.Millisecond)
		grantedState = "awake"
	}
	granted := readMachine(grantedState, 0)
	require.Greater(t, *granted.Cursor, *waiting.Cursor)
	require.Equal(t, 1, queue.InUse())
	runtime.mu.Lock()
	require.Zero(t, runtime.creates, "a review cannot pass a terminal admitted through HTTP")
	runtime.mu.Unlock()
	// Both variants retain the slot until the independent runtime stop
	// observation. The successful variant closes a running terminal through
	// the person's authenticated door; the original variant fails its boot.
	require.NoError(t, os.WriteFile(stopPending, nil, 0600))
	if successfulTerminal {
		require.Eventually(t, func() bool {
			var count int
			return pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='terminal.running' AND data->>'session'=$1`, person.ID).Scan(&count) == nil && count == 1
		}, 5*time.Second, 10*time.Millisecond)
		destroy, e := http.NewRequestWithContext(ctx, "POST", terminalServer.URL+"/api/repos/review-owner/app/workspace/sessions/"+person.ID+"/destroy", nil)
		require.NoError(t, e)
		destroy.Header = request.Header.Clone()
		response, e := terminalServer.Client().Do(destroy)
		require.NoError(t, e)
		closedBody, e := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, e)
		require.Equal(t, 204, response.StatusCode, string(closedBody))
	} else {
		require.NoError(t, os.WriteFile(releaseBoot, nil, 0600))
	}
	if !successfulTerminal {
		require.Eventually(t, func() bool { _, err := os.Stat(stopAcknowledged); return err == nil }, 5*time.Second, 10*time.Millisecond)
	}
	// Neither a successful terminal close nor a stop acknowledgment frees
	// capacity through ten seconds of independently observed running.
	until := time.Now().Add(10 * time.Second)
	for time.Now().Before(until) {
		require.Equal(t, 1, queue.InUse())
		require.True(t, queue.AdmissionHeld(personHolder))
		runtime.mu.Lock()
		require.Zero(t, runtime.creates)
		runtime.mu.Unlock()
		time.Sleep(50 * time.Millisecond)
	}
	require.NoError(t, os.Remove(stopPending))
	if successfulTerminal {
		// Inject the independent stopped observation after the successful
		// terminal has closed. Closing alone is never a VM-stop receipt.
		observed := personRuntime.(*successfulReviewPersonGuest)
		observed.mu.Lock()
		observed.state = workspace.WorkspaceStopped
		observed.mu.Unlock()
		queue.ConfirmAdmissionStop(personHolder, false)
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='terminal.failed' AND data->>'session'=$1`, person.ID).Scan(&count))
		require.Zero(t, count, "a successful terminal closes without a failed-wake receipt")
	}
	require.NoError(t, workspaces.WaitForProvisioning(ctx))
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repository), PrincipalID: fmt.Sprintf("user:%d", user)}
	require.Eventually(t, func() bool {
		op, e := store.Get(ctx, scope, admission.OperationID)
		return e == nil && op.State == jobs.StateCompleted
	}, 10*time.Second, 10*time.Millisecond)
	if successfulTerminal {
		runs, e := service.BackgroundRuns(ctx, repository)
		require.NoError(t, e)
		require.Empty(t, runs, "a completed review disappears from Home")
		for {
			frame := readPresenceFrame(t, homeSocket)
			require.NotEqual(t, "err", frame.T)
			if frame.T != "snap" {
				continue
			}
			var card struct {
				BackgroundRuns []json.RawMessage `json:"background_runs"`
			}
			require.NoError(t, json.Unmarshal(frame.Data, &card))
			if len(card.BackgroundRuns) == 0 {
				break
			}
		}

	}
	runtime.mu.Lock()
	require.Zero(t, queue.InUse(), "confirmed retirement releases the review slot")
	for _, row := range queue.AdmissionSnapshot() {
		if row.Actor == admission.OperationID {
			require.Equal(t, "released", row.State)
		}
	}
	require.Equal(t, 1, runtime.creates)
	require.Equal(t, 4, runtime.launches, "lost launch and approval replies replay the same pinned plan before one run")
	require.Equal(t, 2, runtime.approvals)
	require.True(t, runtime.approved)
	require.Equal(t, int64(2), runtime.launch.Attempt)
	require.Equal(t, 2, runtime.deletes, "failed retirement must retry")
	require.Equal(t, 1, runtime.heldOnFailedDelete, "failed deletion retains capacity")
	require.Equal(t, admission.OperationID, runtime.launch.ApplicationRequestID)
	require.Equal(t, admission.Pin, *runtime.launch.Pin)
	require.JSONEq(t, `{"repo":".","from":"9999999999999999999999999999999999999999","to":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","verify":true,"narrate":false}`, string(runtime.launch.Payload))
	require.Equal(t, reviewWorkspaceID(admission.OperationID), runtime.id)
	runtime.mu.Unlock()
	require.EqualValues(t, 1, transport.starts.Load(), "lost guest acknowledgments reuse the authenticated host binding")
	// A row without the restored head refuses EnsureMachined step "head"
	// not_ready until the start exhausts (real install run 13, Stop 1).
	require.Equal(t, []string{admission.Head}, transport.seeds, "the review machine's branch head seed is the restored PR head")
	// The row names the VM the daemon boots, so agent admission accepts the
	// coding host spawn (real install run 14 refused it as unauthorized).
	require.Equal(t, []string{"admitted"}, transport.spawns)
	require.GreaterOrEqual(t, source.restores, 2)
	require.Equal(t, admission.Head, source.selected.Head)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id=$1`, reviewWorkspaceID(admission.OperationID)).Scan(&count))
	require.Zero(t, count)
	_, err = pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, personBranch.ID)
	require.NoError(t, err)
	for _, table := range []string{"mythical_items", "mythical_stacks"} {
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count)
	}
	req := httptest.NewRequest("GET", "http://localhost:4000/api/conversations/main", nil)
	req.RemoteAddr = "127.0.0.1:61000"
	req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	require.Equal(t, 200, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "Pinned adapter finding")
	require.NotContains(t, response.Body.String(), "private-thinking-canary")
	require.NotContains(t, response.Body.String(), "untrusted-html-canary")
	// The committed job no longer authorizes an engine target.
	_, err = machine.ResolveFlowHostTarget(ctx, reviewTarget(admission.OperationID, admission))
	require.Error(t, err)
}

type reviewSourceContract struct {
	refusal  error
	restores int
	selected services.ReviewAdmission
}

func (s *reviewSourceContract) Prepare(context.Context, services.ReviewAdmission) error {
	return s.refusal
}
func (s *reviewSourceContract) Restore(_ context.Context, _ string, a services.ReviewAdmission) error {
	s.restores++
	s.selected = a
	return nil
}
func (s *reviewSourceContract) Retire(context.Context, string, services.ReviewAdmission) error {
	return nil
}

// Only the guest's HTTP transport is controlled. The production resolver owns
// host binding, credentials, catalog selection and authenticated bridge calls.
type reviewHostTransport struct {
	*todoControlHostTransport
	pool  *pgxpool.Pool
	seeds []string
	// machine is the VM name the runtime boots the machine under. When set,
	// each start admits the coding host spawn as the production broker does.
	machine string
	spawns  []string
}

// StartFlowHost records the branch head seed the production machine broker
// reads at this boundary (EnsureMachined step "head", machineBranchHead).
func (h *reviewHostTransport) StartFlowHost(ctx context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	if h.pool == nil {
		return h.todoControlHostTransport.StartFlowHost(ctx, launch)
	}
	var seed string
	if err := h.pool.QueryRow(ctx, `SELECT COALESCE(NULLIF(head_commit_id,''),source_commit) FROM workspaces WHERE id=$1`, launch.Binding.WorkspaceID).Scan(&seed); err != nil {
		return flowhost.Connection{}, err
	}
	h.mu.Lock()
	h.seeds = append(h.seeds, seed)
	h.mu.Unlock()
	if h.machine != "" {
		err := h.admitCodingHost(ctx, launch)
		outcome := "admitted"
		if err != nil {
			outcome = err.Error()
		}
		h.mu.Lock()
		h.spawns = append(h.spawns, outcome)
		h.mu.Unlock()
		if err != nil {
			return flowhost.Connection{}, err
		}
	}
	return h.todoControlHostTransport.StartFlowHost(ctx, launch)
}

// admitCodingHost runs the production broker's checks before it spawns the
// coding host (microsandbox native_host.go): commit the run's actor under the
// daemon link's VM name, then admit the spawn. Both match workspaces.vm_id.
func (h *reviewHostTransport) admitCodingHost(ctx context.Context, launch flowhost.HostLaunch) error {
	branch := launch.Binding.WorkspaceID
	host := newMachineHost(h.pool, nil)
	host.registry = new(machined.Registry)
	link, _, _, closeLink, err := machineTestLink(ctx, host.registry, branch, h.machine)
	if err != nil {
		return err
	}
	defer closeLink()
	if _, err = host.commitAgentActor(ctx, branch, link.Machine(), launch.Binding.ID); err != nil {
		return err
	}
	return host.admitAgent(ctx, branch, launch.Binding.ID, func(context.Context) error { return nil })
}

func (h *reviewHostTransport) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/runtime/v1/command" {
		h.todoControlHostTransport.ServeHTTP(w, r)
		return
	}
	h.mu.Lock()
	launch := h.launch
	h.mu.Unlock()
	if launch.Credential == "" || r.Header.Get("Authorization") != "Bearer "+launch.Credential {
		http.Error(w, "unauthorized", 401)
		return
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "invalid command", 400)
		return
	}
	var header struct {
		Operation       string
		OwnerGeneration int64
	}
	if json.Unmarshal(raw, &header) != nil || header.OwnerGeneration != launch.Binding.OwnerGeneration {
		http.Error(w, "invalid generation", 409)
		return
	}
	var value any
	switch header.Operation {
	case "launch":
		var request flowruntime.Launch
		if json.Unmarshal(raw, &request) != nil {
			http.Error(w, "invalid launch", 400)
			return
		}
		var result flowruntime.LaunchResult
		result, err = h.receiver.Launch(r.Context(), request)
		value = map[string]any{"operation": "launch", "applicationRequestId": result.ApplicationRequestID, "ownerGeneration": result.OwnerGeneration, "runtimeArtifactDigest": result.RuntimeArtifactDigest, "sourceRevision": result.SourceRevision, "executionDigest": result.ExecutionDigest, "planId": result.PlanID, "planDigest": result.PlanDigest, "approval": result.Approval, "receipt": result.Receipt}
	case "approve":
		var request flowruntime.Decision
		if json.Unmarshal(raw, &request) != nil {
			http.Error(w, "invalid approval", 400)
			return
		}
		var result flowruntime.MutationResult
		result, err = h.receiver.Approve(r.Context(), request)
		value = map[string]any{"operation": result.Operation, "applicationRequestId": result.ApplicationRequestID, "receipt": result.Receipt}
	default:
		r.Body = io.NopCloser(bytes.NewReader(raw))
		h.todoControlHostTransport.ServeHTTP(w, r)
		return
	}
	if err != nil {
		http.Error(w, "guest unavailable", 503)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"protocol": flowruntime.Protocol, "ok": true, "value": value})
}

// reviewMachineName is the VM name the runtime boots the review machine
// under, distinct from its workspace ID as microsandbox names are.
const reviewMachineName = "smthrs-ws-2eb1e3a1-0123456789abcdef0123"

type reviewRuntimeContract struct {
	heldOnFailedDelete int
	queue              *microsandbox.Runtime
	workspace.WorkspaceLifecycle
	flowruntime.Runtime
	mu                             sync.Mutex
	head, id                       string
	exists, loseLaunch, failDelete bool
	approved, loseApproval         bool
	approvals                      int
	creates, launches, deletes     int
	launch                         flowruntime.Launch
}

func (*reviewRuntimeContract) Isolation() workspace.IsolationLevel {
	return workspace.IsolationSandboxed
}
func (r *reviewRuntimeContract) InspectWorkspace(context.Context, string) (workspace.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.exists {
		return workspace.Workspace{}, workspace.ErrWorkspaceNotFound
	}
	return workspace.Workspace{ID: r.id, State: workspace.WorkspaceRunning}, nil
}
func (r *reviewRuntimeContract) CreateWorkspace(_ context.Context, s workspace.WorkspaceSpec) (workspace.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.queue.BindAdmissionMachine("workspace:"+s.ID, reviewMachineName); err != nil {
		return workspace.Workspace{}, err
	}
	r.creates++
	r.id = s.ID
	r.exists = true
	return workspace.Workspace{ID: s.ID, State: workspace.WorkspaceRunning}, nil
}
func (r *reviewRuntimeContract) DeleteWorkspace(context.Context, string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deletes++
	if r.failDelete {
		r.heldOnFailedDelete = r.queue.InUse()
		r.failDelete = false
		return errors.New("lost delete reply")
	}
	r.exists = false
	r.queue.ConfirmAdmissionStop("workspace:"+r.id, false)
	return nil
}
func (r *reviewRuntimeContract) WorkspaceMachineIdentity(context.Context, string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.exists {
		return "", workspace.ErrWorkspaceNotFound
	}
	return reviewMachineName, nil
}
func (r *reviewRuntimeContract) ResolveWorkspaceSourceRevision(context.Context, string) (string, error) {
	return r.head, nil
}
func (*reviewRuntimeContract) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, SourceRevision: strings.Repeat("b", 40), RuntimeArtifactDigest: strings.Repeat("d", 64), OwnerGeneration: 1}, nil
}
func (r *reviewRuntimeContract) Launch(_ context.Context, l flowruntime.Launch) (flowruntime.LaunchResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.launches++
	r.launch = l
	if r.loseLaunch {
		r.loseLaunch = false
		return flowruntime.LaunchResult{}, errors.New("lost launch reply")
	}
	if l.Attempt == 1 {
		approval := json.RawMessage(`{"target":{"_tag":"Plan","planId":"review-plan","digest":"` + strings.Repeat("e", 64) + `"},"scope":"run"}`)
		return flowruntime.LaunchResult{ApplicationRequestID: l.ApplicationRequestID, SourceRevision: l.SourceRevision, RuntimeArtifactDigest: l.RuntimeArtifactDigest, OwnerGeneration: l.OwnerGeneration, ExecutionDigest: l.Pin.ExecutionDigest, PlanID: "review-plan", PlanDigest: strings.Repeat("e", 64), Approval: approval, Receipt: flowruntime.Receipt{Tag: "Parked", PlanID: "review-plan", Status: "waiting-approval"}}, nil
	}
	if !r.approved {
		return flowruntime.LaunchResult{}, errors.New("review cannot execute before approval")
	}
	return flowruntime.LaunchResult{ApplicationRequestID: l.ApplicationRequestID, SourceRevision: l.SourceRevision, RuntimeArtifactDigest: l.RuntimeArtifactDigest, OwnerGeneration: l.OwnerGeneration, ExecutionDigest: l.Pin.ExecutionDigest, Receipt: flowruntime.Receipt{RunID: "review-engine-run"}}, nil
}
func (r *reviewRuntimeContract) Approve(_ context.Context, d flowruntime.Decision) (flowruntime.MutationResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.approvals++
	if d.ApplicationRequestID != r.launch.ApplicationRequestID+":review-plan" || d.OwnerGeneration != r.launch.OwnerGeneration || !strings.Contains(string(d.Approval), strings.Repeat("e", 64)) {
		return flowruntime.MutationResult{}, errors.New("wrong review approval")
	}
	tag := "Accepted"
	if r.approved {
		tag = "AlreadyApplied"
	}
	r.approved = true
	if r.loseApproval {
		r.loseApproval = false
		return flowruntime.MutationResult{}, errors.New("lost approval reply")
	}
	return flowruntime.MutationResult{Operation: "approve", ApplicationRequestID: d.ApplicationRequestID, Receipt: flowruntime.Receipt{Tag: tag}}, nil
}

func (*reviewRuntimeContract) Observe(context.Context, string, string, int) (flowruntime.Observation, error) {
	output := `{"review":{"status":"success","ok":true,"comments":[{"path":"cache.ts","content":"Pinned adapter finding","startLine":20,"severity":"major","thinking":"private-thinking-canary"}]},"ui":{"html":"untrusted-html-canary"}}`
	return flowruntime.Observation{Terminal: true, Run: flowruntime.Run{RunID: "review-engine-run", FlowID: "review", Status: "completed", FinalOutput: &output}}, nil
}

func (r *reviewRuntimeContract) FreeDisk(context.Context) (int64, error) { return 140 << 30, nil }
func (r *reviewRuntimeContract) WaitAdmission(ctx context.Context, p microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	return r.queue.WaitAdmission(ctx, p, class, holder, actor, reason)
}
func (r *reviewRuntimeContract) CancelFailedAdmission(holder, actor string) {
	r.queue.CancelFailedAdmission(holder, actor)
}

func (r *reviewRuntimeContract) AdmissionSnapshot() []microsandbox.AdmissionRequest {
	return r.queue.AdmissionSnapshot()
}

// Only guest readiness and stop observations are controlled. The service still
// owns initialization, member credentials, queue publication and terminal doors.
type successfulReviewPersonGuest struct {
	*releasedTodoGuest
	machine string
}

func (r *successfulReviewPersonGuest) StartWorkspace(ctx context.Context, id string) (workspace.Workspace, error) {
	if !r.queue.AdmissionHeld("workspace:" + id) {
		return workspace.Workspace{}, errors.New("guest boot requires admission")
	}
	if err := r.queue.BindAdmissionMachine("workspace:"+id, r.machine); err != nil {
		return workspace.Workspace{}, err
	}
	return r.perfWakeRuntime.StartWorkspace(ctx, id)
}
func (r *successfulReviewPersonGuest) EnsureMachined(ctx context.Context, id string) error {
	return r.perfWakeRuntime.EnsureMachined(ctx, id)
}

func (r *successfulReviewPersonGuest) SyncTodoAdmission(scope string, holders []string, limit int) error {
	return r.queue.SyncTodoAdmission(scope, holders, limit)
}
func (r *successfulReviewPersonGuest) TodoAdmissionEligible(holder string) bool {
	return r.queue.TodoAdmissionEligible(holder)
}
func (r *successfulReviewPersonGuest) AdmissionOwnership(holder string) (bool, bool) {
	return r.queue.AdmissionOwnership(holder)
}
