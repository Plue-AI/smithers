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
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// parallelFlowHost is the injected runtime boot response for a TODO lane: its
// flow host answers only once the T-MCH-06 scheduler granted the lane's
// machine, then accepts the pinned todo launch and keeps the run going. It
// grants, orders and counts nothing; the runtime queue does.
type parallelFlowHost struct{}

func (parallelFlowHost) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}, nil
}
func (parallelFlowHost) Launch(_ context.Context, l flowruntime.Launch) (flowruntime.LaunchResult, error) {
	digest := ""
	if l.Pin != nil {
		digest = l.Pin.ExecutionDigest
	}
	return flowruntime.LaunchResult{ApplicationRequestID: l.ApplicationRequestID, OwnerGeneration: l.OwnerGeneration, RuntimeArtifactDigest: l.RuntimeArtifactDigest,
		SourceRevision: l.SourceRevision, ExecutionDigest: digest, Receipt: flowruntime.Receipt{Tag: "Accepted", RunID: "run-" + l.ApplicationRequestID}}, nil
}
func (parallelFlowHost) Observe(_ context.Context, run, _ string, _ int) (flowruntime.Observation, error) {
	return flowruntime.Observation{Run: flowruntime.Run{RunID: run, FlowID: "todo", Status: "running"}, Events: []flowruntime.Event{}}, nil
}

var errParallelFlowHostUnsupported = errors.New("the C-STK-02 flow host only runs TODO launches")

func (parallelFlowHost) Approve(context.Context, flowruntime.Decision) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, errParallelFlowHostUnsupported
}
func (parallelFlowHost) Deny(context.Context, flowruntime.Decision) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, errParallelFlowHostUnsupported
}
func (parallelFlowHost) Signal(context.Context, flowruntime.Signal) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, errParallelFlowHostUnsupported
}
func (parallelFlowHost) Steer(context.Context, flowruntime.Steer) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, errParallelFlowHostUnsupported
}
func (parallelFlowHost) Cancel(context.Context, flowruntime.Lifecycle) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, errParallelFlowHostUnsupported
}
func (parallelFlowHost) Resume(context.Context, flowruntime.Lifecycle) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, errParallelFlowHostUnsupported
}

type parallelCard struct {
	N     int    `json:"n"`
	Title string `json:"title"`
	State string `json:"state"`
	Queue *struct {
		Reason   string `json:"reason"`
		Position int    `json:"position"`
	} `json:"queue"`
}

// TestParallelAdmissionInstallBoundary is C-STK-02 (T-STK-03, #3572) on the
// composed install: real PostgreSQL, the production router, stack engine
// loop, flow dispatcher, owner terminal door and the T-MCH-06 microsandbox
// admission queue. Only host measurements (free disk) and runtime boot/stop
// responses (a recording msb whose boots never finish, and a flow host that
// answers on a granted machine) are injected. Expectations are literal.
//
// Step 2 runs its placement only. T1 reaching in_review and holding its slot
// until safe-idle release waits for T-MCH-06's production safe-idle
// observation providers; TestParallelRetainedMachineRelease covers that
// engine rule with an injected ownership observation.
func TestParallelAdmissionInstallBoundary(t *testing.T) {
	scratch, err := os.MkdirTemp("/tmp", "stk03")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(scratch) })
	t.Setenv("TMPDIR", scratch)
	pool, _ := postgresfixture.NewProductDatabase(t, 24)
	ctx := t.Context()
	q := db.New(pool)

	// People, repository and install binding.
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, u.ID)
		require.NoError(t, err)
		return u
	}
	maya, ben := user("maya"), user("ben")
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, maya.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: maya.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin'),($1,$3,'write')`, repo.ID, maya.ID, ben.ID)
	require.NoError(t, err)
	session := func(u db.User) string {
		cookie := u.Username + "-parallel-session"
		sum := sha256.Sum256([]byte(cookie))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return cookie
	}
	mayaCookie, benCookie := session(maya), session(ben)

	// The repository host: real Git smart transport over a bare repository.
	host := &pollingGitHost{dir: filepath.Join(scratch, "app.git")}
	require.NoError(t, host.git(ctx, nil, io.Discard, "init", "--bare", host.dir))
	var tree, commit bytes.Buffer
	require.NoError(t, host.git(ctx, strings.NewReader(""), &tree, "mktree"))
	require.NoError(t, host.git(ctx, nil, &commit, "commit-tree", strings.TrimSpace(tree.String()), "-m", "Fixture main"))
	require.NoError(t, host.git(ctx, nil, io.Discard, "update-ref", "refs/heads/main", strings.TrimSpace(commit.String())))

	// Host measurements: startup memory/cores never change; free disk alone
	// moves capacity. 136 GiB free is capacity 3.
	var freeDisk atomic.Int64
	freeDisk.Store(136 << 30)
	readDisk := func(context.Context) (int64, error) { return freeDisk.Load(), nil }
	profile := microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: 136 << 30, MacOSVersion: "15.6", Hypervisor: true}
	sizing := microsandbox.ComputeSizing(profile)
	require.Equal(t, 3, sizing.Capacity)
	// Ben's sleeping scratch branch: a stopped machine the runtime retains.
	machines, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	scratchBranch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machines, Name: "notes", TargetBookmark: "scratch/ben/notes", Kind: "vm", Status: "suspended"})
	require.NoError(t, err)
	root := filepath.Join(scratch, "runtime")
	sum := sha256.Sum256([]byte(scratchBranch.ID))
	sleeping := "smthrs-ws-01234567-" + hex.EncodeToString(sum[:])[:20]
	require.NoError(t, os.MkdirAll(filepath.Join(root, "workspaces", hex.EncodeToString(sum[:])), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "owner"), []byte("smithers-backend-0123456789abcdef\n"), 0o600))
	metadata, err := json.Marshal(map[string]any{"version": 1, "id": scratchBranch.ID, "machine": sleeping, "state": "stopped"})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(root, "workspaces", hex.EncodeToString(sum[:]), "metadata.json"), metadata, 0o600))
	// Runtime boot/stop responses: every boot or wake stays in flight (holding
	// its grant) until the test ends; the inventory lists the sleeping machine.
	release := filepath.Join(scratch, "release-boots")
	msb := filepath.Join(scratch, "msb")
	require.NoError(t, os.WriteFile(msb, []byte(fmt.Sprintf("#!/bin/sh\ncase \"$1\" in\n create|run|start) while [ ! -f %q ]; do sleep 0.05; done; exit 1 ;;\n list) printf '[{\"name\":\"%s\",\"status\":\"stopped\"}]\\n' ;;\n *) printf '[]\\n' ;;\nesac\n", release, sleeping)), 0o700))
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
	runtime, err := microsandbox.New(ctx, microsandbox.Config{Root: root, Binary: msb, SkipQualification: true, HostProfile: &profile,
		CPUs: sizing.CPUs, MemoryMiB: sizing.MemoryMiB, DiskMiB: int(microsandbox.MachineDiskBytes >> 20), MaxRunningVMs: 8})
	require.NoError(t, err)
	t.Cleanup(func() { _ = runtime.Close() })

	// The install composition (compose/main.go): the owner setting, capacity
	// and the runtime's admission readers.
	capacity := &services.InstallCapacityService{Queries: q, Profile: profile, FreeDisk: readDisk, InUse: runtime.InUse,
		AuthorizeParallel: func(ctx context.Context) error { _, err := services.Authorize(ctx, q, "settings.parallel"); return err }}
	require.NoError(t, capacity.ValidateStart(ctx))
	runtime.SetCapacityReader(capacity.Capacity)
	runtime.SetTodoParallelReader(func(ctx context.Context) (int, error) {
		parallel, err := capacity.Parallel(ctx)
		return parallel.Effective, err
	})
	auth := services.NewAuthService(q, testConfigAllFlagsOn().Auth, nil, nil)
	unlimited := services.NewUnlimitedBillingPolicy()
	workspaces := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(pool),
		services.WithWorkspaceBillingPolicy(installMachineAdmissionPolicy{Policy: unlimited, start: services.NewMachineAdmissionPolicy(unlimited)}),
		services.WithWorkspaceInstallAuthorization(q), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)),
		services.WithWorkspaceCredentialIssuer(auth), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
	workspaces.EnableMachineAdmission(readDisk)
	require.NoError(t, workspaces.ReconstructMachineAdmission(ctx))
	t.Cleanup(func() {
		_ = os.WriteFile(release, nil, 0o600)
		done, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = workspaces.WaitForProvisioning(done)
	})

	stack := services.NewMythicalService(pool, host, services.WithMythicalInstallAuthorization(true))
	stack.SetPolicyReader(noPolicy{})
	stack.SetInstallParallel(capacity)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: stack, SteerAuthorizer: stack, ObservationDelay: 20 * time.Millisecond, MaxObservationDelay: 200 * time.Millisecond,
		Resolver: flowruntime.ResolverFunc(func(_ context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
			if !runtime.AdmissionHeld("workspace:" + target.WorkspaceID) {
				return nil, nil
			}
			return parallelFlowHost{}, nil
		})})
	require.NoError(t, err)
	stack.SetOrchestration(nil, dispatcher, services.NewWorkspaceMythicalLanes(workspaces))
	stack.EnableTodoAdmission()
	stack.SetTodoFlow(func(ctx context.Context, repositoryID int64, _ string) (string, error) {
		return services.ActiveFlowDigest(ctx, q, repositoryID, "todo")
	})
	_, err = stack.RequestBootstrap(ctx, repo.ID, maya.ID, 1, false)
	require.NoError(t, err)
	require.NoError(t, stack.PollOnce(ctx))
	stackRow, err := q.GetMythicalStack(ctx, repo.ID)
	require.NoError(t, err)
	require.Equal(t, "active", stackRow.State, stackRow.LastError)

	// The served install: router, live channel and the background workers.
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	liveContext, stopLive := context.WithCancel(ctx)
	t.Cleanup(stopLive)
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(liveContext))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	topics := &liveTopics{queries: q, todos: stack, jobs: store, capacity: capacity, install: &services.InstallSetupService{Capacity: capacity}}
	liveHandler := &routes.LiveHandler{Hub: live.NewHub(liveContext, nil), Queries: q, Origins: func() []string { return cfg.Server.AllowedOrigins }, Topics: topics.resolver}
	setup := &routes.GitHubAppSetupHandler{Owners: q, Origins: liveHandler.Origins, Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}}
	// The install's owner terminal door (compose/main.go): a person's wake
	// enters the same runtime queue through OpenOwnerTerminal.
	terminals := &routes.WorkspaceTerminalHandler{Service: workspaces, AllowedOrigins: cfg.Server.AllowedOrigins, OwnerOnly: true}
	owners := &installOwnerTerminals{queries: q, branches: workspaces, registry: new(machined.Registry)}
	terminals.OwnerTerminals = owners
	terminals.TerminalSessions = terminals.SharedTerminalSessions()
	t.Cleanup(terminals.TerminalSessions.Close)
	owners.Bind(terminals.TerminalSessions)
	router := parallelInstallRouter(cfg, q, pool, terminals, routerExtras{GitHubAppSetup: setup, Mythical: &routes.MythicalHandler{Service: stack}, Live: liveHandler})
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	go func() {
		worker, stop := context.WithCancel(liveContext)
		defer stop()
		_ = dispatcher.RunWorker(worker, jobs.WorkerConfig{WorkerID: "c-stk-02", Capacity: 8, Lease: 5 * time.Second, PollInterval: 20 * time.Millisecond, RetryDelay: 50 * time.Millisecond})
	}()
	go stack.Start(liveContext)

	call := func(method, path, body, cookie string) (int, []byte) {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51900"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", uuid.NewString())
		req.Header.Set("X-CSRF-Token", "parallel-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "parallel-csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res.Code, res.Body.Bytes()
	}
	cards := func() map[int]parallelCard {
		t.Helper()
		code, body := call("GET", "/api/todos", "", mayaCookie)
		require.Equal(t, 200, code, string(body))
		var list []parallelCard
		require.NoError(t, json.Unmarshal(body, &list), string(body))
		byNumber := map[int]parallelCard{}
		for _, card := range list {
			byNumber[card.N] = card
		}
		return byNumber
	}
	// states maps a TODO number to its state; queued maps a TODO number to
	// its literal "waiting for a machine #n" position.
	settle := func(step string, states map[int]string, queued map[int]int) {
		t.Helper()
		var last map[int]parallelCard
		ok := assertEventually(30*time.Second, func() bool {
			last = cards()
			if len(last) != len(states) {
				return false
			}
			for n, state := range states {
				card := last[n]
				if card.State != state {
					return false
				}
				position, waiting := queued[n]
				if waiting != (card.Queue != nil) || waiting && (card.Queue.Reason != "machine" || card.Queue.Position != position) {
					return false
				}
			}
			return true
		})
		require.True(t, ok, "%s: cards %+v", step, last)
	}

	// Step 1: five TODOs in stack order with parallel 2.
	code, body := call("PUT", "/api/install", `{"parallel":2}`, mayaCookie)
	require.Equal(t, 200, code, string(body))
	for _, title := range []string{"T1", "T2", "T3", "T4", "T5"} {
		code, body := call("POST", "/api/todos", fmt.Sprintf(`{"title":%q,"prompt":"Add a line","place":{"mode":"append"}}`, title), mayaCookie)
		require.Equal(t, 202, code, string(body))
	}
	settle("step 1", map[int]string{1: "working", 2: "working", 3: "queued", 4: "queued", 5: "queued"}, map[int]int{3: 1, 4: 2, 5: 3})
	require.Equal(t, 2, runtime.InUse())

	// The live channel: every Home snapshot names the literal waiting order,
	// in stack order, and the effective limit the owner sees.
	dial := func(topic string) *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{
			Subprotocols: []string{live.Protocol}, Host: "127.0.0.1:4000",
			HTTPHeader: http.Header{"Cookie": {"smithers_session=" + mayaCookie}, "Origin": {cfg.Server.PublicURL}}})
		require.NoError(t, err)
		t.Cleanup(func() { conn.CloseNow() })
		require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":%q}`, topic))))
		return conn
	}
	type homeView struct {
		Order     []int
		Positions map[int]int
		Parallel  int
	}
	readHome := func(conn *websocket.Conn) (string, homeView) {
		t.Helper()
		readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		for {
			_, raw, err := conn.Read(readCtx)
			require.NoError(t, err)
			var frame live.Frame
			require.NoError(t, json.Unmarshal(raw, &frame))
			require.NotEqual(t, "err", frame.T, string(raw))
			if frame.T != "snap" && frame.T != "delta" {
				continue
			}
			data := frame.Data
			if frame.T == "delta" {
				var event struct {
					Data struct {
						Home json.RawMessage `json:"home"`
					} `json:"data"`
				}
				require.NoError(t, json.Unmarshal(frame.Data, &event), string(raw))
				if len(event.Data.Home) == 0 {
					continue
				}
				data = event.Data.Home
			}
			var home struct {
				Parallel *int `json:"parallel"`
				Items    []struct {
					N     int `json:"n"`
					Queue *struct {
						Reason   string `json:"reason"`
						Position int    `json:"position"`
					} `json:"queue"`
				} `json:"items"`
			}
			require.NoError(t, json.Unmarshal(data, &home), string(raw))
			// A source fact patches only items and counts (HomeProjection.ts);
			// the snapshot carries the effective limit the owner sees.
			view := homeView{Positions: map[int]int{}, Parallel: -1}
			if frame.T == "snap" {
				require.NotNil(t, home.Parallel, "Home reports the effective limit to the owner")
				view.Parallel = *home.Parallel
			}
			for _, item := range home.Items {
				view.Order = append(view.Order, item.N)
				if item.Queue != nil {
					require.Equal(t, "machine", item.Queue.Reason)
					view.Positions[item.N] = item.Queue.Position
				}
			}
			return frame.T, view
		}
	}
	homeSnapshot := func(step string, want homeView) {
		t.Helper()
		conn := dial("home")
		defer conn.CloseNow()
		kind, got := readHome(conn)
		require.Equal(t, "snap", kind)
		require.Equal(t, want, got, step)
	}
	// todoSnapshot reads one card's own topic; 0 means not waiting.
	todoSnapshot := func(step string, n, position int) {
		t.Helper()
		conn := dial(fmt.Sprintf("todo:%d", n))
		defer conn.CloseNow()
		readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		for {
			_, raw, err := conn.Read(readCtx)
			require.NoError(t, err)
			var frame live.Frame
			require.NoError(t, json.Unmarshal(raw, &frame))
			require.NotEqual(t, "err", frame.T, string(raw))
			if frame.T != "snap" {
				continue
			}
			var card parallelCard
			require.NoError(t, json.Unmarshal(frame.Data, &card), string(raw))
			if position == 0 {
				require.Nil(t, card.Queue, "%s: todo:%d", step, n)
			} else {
				require.NotNil(t, card.Queue, "%s: todo:%d", step, n)
				require.Equal(t, position, card.Queue.Position, "%s: todo:%d", step, n)
			}
			return
		}
	}
	homeSnapshot("step 1", homeView{Order: []int{1, 2, 3, 4, 5}, Positions: map[int]int{3: 1, 4: 2, 5: 3}, Parallel: 2})
	todoSnapshot("step 1", 3, 1)
	todoSnapshot("step 1", 5, 3)
	todoSnapshot("step 1", 1, 0)
	held := func(step string, want int) {
		t.Helper()
		require.Equal(t, want, runtime.InUse(), step)
	}

	// Step 2, placement only: T6 is filed after T5 but placed Before T2. It
	// waits ahead of T3 without taking a slot from the two holders. (Its
	// admission after T1's safe-idle release is pending T-MCH-06.)
	code, body = call("POST", "/api/todos", `{"title":"T6","prompt":"Add a line","place":{"mode":"before","n":2}}`, mayaCookie)
	require.Equal(t, 202, code, string(body))
	settle("step 2", map[int]string{1: "working", 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "queued"}, map[int]int{6: 1, 3: 2, 4: 3, 5: 4})
	homeSnapshot("step 2", homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{6: 1, 3: 2, 4: 3, 5: 4}, Parallel: 2})
	todoSnapshot("step 2", 3, 2)
	todoSnapshot("step 2", 6, 1)
	held("step 2", 2)

	// Step 3: the owner raises the request to 8. Capacity 3 clamps it, and
	// the third machine goes to the next TODO in stack order: T6, not T3.
	code, body = call("PUT", "/api/install", `{"parallel":8}`, mayaCookie)
	require.Equal(t, 200, code, string(body))
	var install struct {
		Parallel int `json:"parallel"`
	}
	require.NoError(t, json.Unmarshal(body, &install))
	require.Equal(t, 8, install.Parallel)
	saved, err := q.GetInstallParallel(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `8`, string(saved))
	settle("step 3", map[int]string{1: "working", 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "working"}, map[int]int{3: 1, 4: 2, 5: 3})
	homeSnapshot("step 3", homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{3: 1, 4: 2, 5: 3}, Parallel: 3})
	todoSnapshot("step 3", 3, 1)
	todoSnapshot("step 3", 6, 0)
	held("step 3", 3)

	// Step 4: free disk falls to capacity 2, then 0, while three TODO machines
	// are held. Nothing is preempted and nothing new is granted; the saved
	// request stays 8.
	working := map[int]string{1: "working", 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "working"}
	for _, fixture := range []struct {
		free     int64
		parallel int
	}{{104 << 30, 2}, {60 << 30, 0}} {
		freeDisk.Store(fixture.free)
		step := fmt.Sprintf("step 4 effective %d", fixture.parallel)
		homeEventually := assertEventually(10*time.Second, func() bool {
			conn := dial("home")
			defer conn.CloseNow()
			_, got := readHome(conn)
			return got.Parallel == fixture.parallel
		})
		require.True(t, homeEventually, step)
		// Hold the observation across several engine passes and scheduler ticks.
		until := time.Now().Add(4 * time.Second)
		for time.Now().Before(until) {
			held(step, 3)
			time.Sleep(200 * time.Millisecond)
		}
		settle(step, working, map[int]int{3: 1, 4: 2, 5: 3})
		homeSnapshot(step, homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{3: 1, 4: 2, 5: 3}, Parallel: fixture.parallel})
		code, body = call("GET", "/api/install", "", mayaCookie)
		require.Equal(t, 200, code, string(body))
		require.NoError(t, json.Unmarshal(body, &install))
		require.Equal(t, 8, install.Parallel, step)
	}

	// Step 5: Ben opens a terminal on his sleeping scratch branch through the
	// install's terminal door while TODOs wait. His person request waits
	// ahead of every TODO; one Home delta moves all their positions.
	freeDisk.Store(104 << 30)
	homeConn := dial("home")
	kind, before := readHome(homeConn)
	require.Equal(t, "snap", kind)
	require.Equal(t, homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{3: 1, 4: 2, 5: 3}, Parallel: 2}, before)
	code, body = call("POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, scratchBranch.ID), benCookie)
	require.Equal(t, 202, code, string(body))
	shifted := homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{3: 2, 4: 3, 5: 4}, Parallel: -1}
	before.Parallel = -1
	for {
		kind, got := readHome(homeConn)
		require.Equal(t, "delta", kind)
		if reflect.DeepEqual(got, shifted) {
			break
		}
		// A delta is the old order or the whole new one, never a partial move.
		require.Equal(t, before, got, "step 5 delta")
	}
	settle("step 5 waiting", working, map[int]int{3: 2, 4: 3, 5: 4})
	todoSnapshot("step 5 waiting", 3, 2)
	held("step 5 waiting", 3)
	// Capacity returns to 4: one machine is free and T3 is eligible again.
	// Ben's person request is granted before it; T3 starts and waits #1.
	freeDisk.Store(168 << 30)
	require.True(t, assertEventually(15*time.Second, func() bool { return runtime.AdmissionHeld("workspace:" + scratchBranch.ID) }), "Ben's wake is granted: %s %+v", scratchBranch.ID, runtime.AdmissionSnapshot())
	settle("step 5 granted", map[int]string{1: "working", 2: "working", 3: "starting", 4: "queued", 5: "queued", 6: "working"}, map[int]int{3: 1, 4: 2, 5: 3})
	homeSnapshot("step 5 granted", homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{3: 1, 4: 2, 5: 3}, Parallel: 4})
	held("step 5 granted", 4)
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		held("step 5 granted", 4)
		time.Sleep(200 * time.Millisecond)
	}
}

// parallelInstallRouter is buildRouter, the install's production router,
// with the C-STK-02 handlers; every other door is left unmounted.
func parallelInstallRouter(cfg *config.Config, q *db.Queries, pool *pgxpool.Pool, terminal *routes.WorkspaceTerminalHandler, extras routerExtras) http.Handler {
	fn := reflect.ValueOf(buildRouter)
	args := make([]reflect.Value, fn.Type().NumIn())
	for i := range args[:len(args)-1] {
		in := fn.Type().In(i)
		args[i] = reflect.Zero(in)
		switch {
		case in == reflect.TypeOf(cfg):
			args[i] = reflect.ValueOf(cfg)
		case in == reflect.TypeOf(q):
			args[i] = reflect.ValueOf(q)
		case in == reflect.TypeOf(pool):
			args[i] = reflect.ValueOf(pool)
		case in == reflect.TypeOf(terminal) && terminal != nil:
			args[i] = reflect.ValueOf(terminal)
		}
	}
	args[len(args)-1] = reflect.ValueOf([]any{extras})
	return fn.CallSlice(args)[0].Interface().(http.Handler)
}

// assertEventually polls condition every 50 ms until it holds or the budget ends.
func assertEventually(budget time.Duration, condition func() bool) bool {
	deadline := time.Now().Add(budget)
	for {
		if condition() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}
