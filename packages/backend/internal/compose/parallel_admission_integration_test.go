package compose

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
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
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// parallelFlowHost is the injected runtime boot response for a TODO lane: its
// flow host answers only once the T-MCH-06 scheduler granted the lane's
// machine, then accepts the pinned todo launch and keeps the run going. It
// grants, orders and counts nothing; the runtime queue does. Pause reports the
// guest resume wait so the production projector can retain a parked machine.
type parallelFlowHost struct{ paused *sync.Map }

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
func (h parallelFlowHost) Observe(_ context.Context, run, _ string, _ int) (flowruntime.Observation, error) {
	observed := flowruntime.Run{RunID: run, FlowID: "todo", Status: "running"}
	if h.paused != nil {
		if _, ok := h.paused.Load(run); ok {
			observed.Status = "parked"
			observed.PendingWaits = []flowruntime.PendingWait{{RunID: run, FlowID: "todo", Reason: "approval", Token: "pause-token", Name: "resume#1", Attempt: 1, Request: json.RawMessage(`{"kind":"pause"}`)}}
		}
	}
	return flowruntime.Observation{Run: observed, Events: []flowruntime.Event{}}, nil
}

var errParallelFlowHostUnsupported = errors.New("the C-STK-02 flow host only runs TODO launches")

func (parallelFlowHost) Approve(context.Context, flowruntime.Decision) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, errParallelFlowHostUnsupported
}
func (parallelFlowHost) Deny(context.Context, flowruntime.Decision) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, errParallelFlowHostUnsupported
}
func (h parallelFlowHost) Signal(_ context.Context, input flowruntime.Signal) (flowruntime.MutationResult, error) {
	if h.paused != nil && input.Name == "pause" {
		h.paused.Store(input.RunID, true)
		return flowruntime.MutationResult{Operation: "signal", ApplicationRequestID: input.ApplicationRequestID, Receipt: flowruntime.Receipt{Tag: "Accepted", RunID: input.RunID}}, nil
	}
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
// admission queue. Host measurements, idle clock and guest responses are
// injected; step 2 starts from a retained reviewed candidate. Expectations are
// literal. Fresh/retained guest qualification is a separate physical receipt.
//
// Step 2 observes automatic capture and confirmed stop through the install
// idle providers. Native guest/root qualification remains C-SEC-02 evidence.
func TestParallelAdmissionInstallBoundary(t *testing.T) {
	testParallelAdmissionInstallBoundary(t, false, false, false)
}

// C-J7-01: a Before request made with no free capacity must win the next
// slot, even though its TODO number is newer than every queued successor.
// This runs the install HTTP dispatcher, engine and real runtime admission
// scheduler. Missing idle providers and an unavailable safety census must retain
// both occupied slots; restoring disk capacity then admits the inserted TODO.
// Only host measurements, safety availability and guest responses are injected.
func TestTodoBeforeAdmittedWhenCapacityFrees(t *testing.T) {
	testParallelAdmissionInstallBoundary(t, true, false, false)
}

// A confirmed runtime stop frees an occupied slot without increasing capacity.
// Placement, pause and admission enter through the install HTTP and engine paths.
// J7's trusted-process adapter has no automatic idle-release providers (#3567,
// #3572); retaining its reviewed coding run (#3531) cannot free capacity there.
// This oracle holds the stop acknowledgment before its independent observation:
// capacity and queued TODOs stay unchanged until the runtime observes the stop.
func TestTodoBeforeAdmittedWhenHolderStops(t *testing.T) {
	testParallelAdmissionInstallBoundary(t, true, true, false)
}

// C-MCH-11 concurrent terminal demand across ten retained branches. The
// unresolved boot is injected; admission, authorization and live sources are real.
func TestTenBranchTerminalAdmissionInstallBoundary(t *testing.T) {
	testParallelAdmissionInstallBoundary(t, false, false, true)
}

func testParallelAdmissionInstallBoundary(t *testing.T, beforeCapacityRecovery, holderStops, matrix bool) {
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
	// moves capacity. The shared floor plus three machine disks is capacity 3.
	var freeDisk atomic.Int64
	freeDisk.Store(microsandbox.MinFreeDiskBytes + 3*microsandbox.MachineDiskBytes)
	if beforeCapacityRecovery {
		freeDisk.Store(microsandbox.MinFreeDiskBytes + 2*microsandbox.MachineDiskBytes) // capacity 2; both slots will be held
	}
	readDisk := func(context.Context) (int64, error) { return freeDisk.Load(), nil }
	profile := microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: microsandbox.MinFreeDiskBytes + 3*microsandbox.MachineDiskBytes, MacOSVersion: "15.6", Hypervisor: true}
	sizing := microsandbox.ComputeSizing(profile)
	require.Equal(t, 3, sizing.Capacity)
	// Ben's sleeping scratch branch: a stopped machine the runtime retains.
	machines, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	root := filepath.Join(scratch, "runtime")
	require.NoError(t, os.MkdirAll(root, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "owner"), []byte("smithers-backend-0123456789abcdef\n"), 0o600))
	count := 1
	if matrix {
		count = 10
	}
	branches := make([]db.Workspace, 0, count)
	inventory := make([]map[string]string, 0, count)
	for i := range count {
		branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machines, Name: fmt.Sprintf("notes-%d", i), TargetBookmark: fmt.Sprintf("scratch/ben/notes-%d", i), Kind: "container", Status: "suspended"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id=id WHERE id=$1`, branch.ID)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte(branch.ID))
		machine := "smthrs-ws-01234567-" + hex.EncodeToString(sum[:])[:20]
		directory := filepath.Join(root, "workspaces", hex.EncodeToString(sum[:]))
		require.NoError(t, os.MkdirAll(directory, 0o700))
		metadata, err := json.Marshal(map[string]any{"version": 1, "id": branch.ID, "machine": machine, "state": "stopped"})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(directory, "metadata.json"), metadata, 0o600))
		branches = append(branches, branch)
		inventory = append(inventory, map[string]string{"name": machine, "status": "stopped"})
	}
	scratchBranch := branches[0]
	inventoryJSON, err := json.Marshal(inventory)
	require.NoError(t, err)
	// Runtime boot/stop responses: every boot or wake stays in flight (holding
	// its grant) until the test ends; the inventory lists the sleeping machine.
	release := filepath.Join(scratch, "release-boots")
	firstBoot := filepath.Join(scratch, "first-boot")
	stopPending := filepath.Join(scratch, "stop-pending")
	stopAcknowledged := filepath.Join(scratch, "stop-acknowledged")
	msb := filepath.Join(scratch, "msb")
	require.NoError(t, os.WriteFile(msb, []byte(fmt.Sprintf(`#!/bin/sh
case "$1" in
 create|run|start)
  while [ ! -f %q ]; do
   if [ -f %q ]; then case "$*" in *"$(cat %q)"*) exit 0 ;; esac; fi
   sleep 0.05
  done; exit 1 ;;
 exec)
  case "$*" in *final-capture-fence*) printf 'FENCED\n'; dd bs=1 count=1 of=/dev/null 2>/dev/null ;;
  *) cat >/dev/null; printf '[]\n' ;; esac ;;
 stop) touch %q; printf '[]\n' ;;
 list)
  if [ -f %q ]; then
   printf '[{"name":"%%s","status":"running"}]\n' "$(cat %q)"
  else
   printf '%%s\n' %q
  fi ;;
 *) printf '[]\n' ;;
esac
`, release, firstBoot, firstBoot, stopAcknowledged, stopPending, stopPending, inventoryJSON)), 0o700))
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
	machineRuntime, err := microsandbox.New(ctx, microsandbox.Config{Root: root, Binary: msb, SkipQualification: true, HostProfile: &profile,
		CPUs: sizing.CPUs, MemoryMiB: sizing.MemoryMiB, DiskMiB: int(microsandbox.MachineDiskBytes >> 20), MaxRunningVMs: 8})
	require.NoError(t, err)
	runtime := &parallelIdleRuntime{Runtime: machineRuntime}
	t.Cleanup(func() { _ = runtime.Close() })

	// The install composition (compose/main.go): the owner setting, capacity
	// and the runtime's admission readers.
	capacity := &services.InstallCapacityService{Queries: q, Profile: profile, FreeDisk: readDisk, InUse: runtime.InUse,
		AuthorizeParallel: func(ctx context.Context) error { _, err := services.Authorize(ctx, q, "settings"); return err }}
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
	guest := parallelFlowHost{paused: new(sync.Map)}
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: stack, SteerAuthorizer: stack, ObservationDelay: 20 * time.Millisecond, MaxObservationDelay: 200 * time.Millisecond,
		Resolver: flowruntime.ResolverFunc(func(_ context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
			if !runtime.AdmissionHeld("workspace:" + target.WorkspaceID) {
				return nil, nil
			}
			return guest, nil
		})})
	require.NoError(t, err)
	stack.SetOrchestration(nil, dispatcher, services.NewWorkspaceMythicalLanes(workspaces))
	composeAdmissionPublication(runtime, stack)
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
	if matrix {
		cfg.RateLimit.TerminalOpenPerMin = 100
	}
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	liveContext, stopLive := context.WithCancel(ctx)
	t.Cleanup(stopLive)
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(liveContext))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	topics := &liveTopics{queries: q, todos: stack, jobs: store, capacity: capacity, install: &services.InstallSetupService{Capacity: capacity}, presence: &branchPresence{queries: q, branches: workspaces}}
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
	if os.Getenv("SMITHERS_PARALLEL_BROWSER_DIR") != "" {
		fmt.Println("PARALLEL_BROWSER_READY " + server.URL)
	}
	go func() {
		worker, stop := context.WithCancel(liveContext)
		defer stop()
		_ = dispatcher.RunWorker(worker, jobs.WorkerConfig{WorkerID: "c-stk-02", Capacity: 8, Lease: 5 * time.Second, PollInterval: 20 * time.Millisecond, RetryDelay: 50 * time.Millisecond})
	}()
	go stack.Start(liveContext)

	callKey := func(method, path, body, cookie, key string) (int, []byte) {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51900"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "parallel-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "parallel-csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res.Code, res.Body.Bytes()
	}
	call := func(method, path, body, cookie string) (int, []byte) {
		return callKey(method, path, body, cookie, uuid.NewString())
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
	if matrix {
		freeDisk.Store(microsandbox.MinFreeDiskBytes + microsandbox.MachineDiskBytes) // exactly one slot
		exerciseTenBranchTerminals(t, branches, runtime.Runtime, server.URL, cfg.Server.PublicURL, mayaCookie, benCookie, call, &freeDisk, queuedSSHProbe(t, pool, workspaces, cfg, ben.ID))
		return
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
	requestedParallel := `{"parallel":2}`
	if beforeCapacityRecovery {
		requestedParallel = `{"parallel":8}` // unchanged throughout recovery
	}
	code, body := call("PUT", "/api/install", requestedParallel, mayaCookie)
	require.Equal(t, 200, code, string(body))
	for _, title := range []string{"T1", "T2", "T3", "T4", "T5"} {
		code, body := call("POST", "/api/todos", fmt.Sprintf(`{"title":%q,"prompt":"Add a line","place":{"mode":"append"}}`, title), mayaCookie)
		require.Equal(t, 202, code, string(body))
	}
	settle("step 1", map[int]string{1: "working", 2: "working", 3: "queued", 4: "queued", 5: "queued"}, map[int]int{3: 1, 4: 2, 5: 3})
	require.Equal(t, 2, runtime.InUse())
	parallelBrowserCheckpoint(t, "working")

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

	// Step 2: T6 is filed after T5 but placed Before T2. It waits ahead
	// of T3 while both existing machines remain held.
	beforeTarget := 2
	beforeOrder := []int{1, 6, 2, 3, 4, 5}
	if beforeCapacityRecovery {
		beforeTarget = 3
		beforeOrder = []int{1, 2, 6, 3, 4, 5}
	}
	beforeKey := uuid.NewString()
	beforeBody := fmt.Sprintf(`{"title":"T6","prompt":"Add a line","place":{"mode":"before","n":%d}}`, beforeTarget)
	code, body = callKey("POST", "/api/todos", beforeBody, mayaCookie, beforeKey)
	require.Equal(t, 202, code, string(body))
	beforeReceipt := append([]byte(nil), body...)
	if beforeCapacityRecovery {
		// A reconnect/double press while capacity is held replays the durable
		// placement receipt. It cannot append another TODO or queue entry.
		code, body = callKey("POST", "/api/todos", beforeBody, mayaCookie, beforeKey)
		require.Equal(t, 202, code, string(body))
		require.JSONEq(t, string(beforeReceipt), string(body))
	}
	settle("step 2", map[int]string{1: "working", 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "queued"}, map[int]int{6: 1, 3: 2, 4: 3, 5: 4})
	homeSnapshot("step 2", homeView{Order: beforeOrder, Positions: map[int]int{6: 1, 3: 2, 4: 3, 5: 4}, Parallel: 2})
	todoSnapshot("step 2", 3, 2)
	todoSnapshot("step 2", 6, 1)
	held("step 2", 2)
	parallelBrowserCheckpoint(t, "placed")

	if beforeCapacityRecovery {
		// Release an occupied slot or increase disk capacity. The runtime
		// scheduler must re-read demand and admit T6 before its successors.
		releasedHolder := ""
		firstState := "working"
		expectedParallel, expectedHeld := 3, 3
		if holderStops {
			first, err := q.GetMythicalItemByNumber(ctx, repo.ID, 1)
			require.NoError(t, err)
			code, body = call("POST", "/api/todos/1", `{"op":"stop"}`, mayaCookie)
			require.Equal(t, 202, code, string(body))
			settle("paused holder retains capacity", map[int]string{1: "paused", 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "queued"}, map[int]int{6: 1, 3: 2, 4: 3, 5: 4})
			firstState = "paused"
			held("paused holder retains capacity", 2)
			releasedHolder = "workspace:" + first.WorkspaceID
			require.True(t, runtime.AdmissionHeld(releasedHolder))
			// A successful stop command is only an acknowledgment. Keep the
			// guest observable as running while the actual runtime stop waits.
			sum := sha256.Sum256([]byte(first.WorkspaceID))
			machine := "smthrs-ws-01234567-" + hex.EncodeToString(sum[:])[:20]
			require.NoError(t, os.WriteFile(stopPending, []byte(machine), 0o600))
			stopped := make(chan error, 1)
			stopCtx, cancelStop := context.WithTimeout(ctx, 10*time.Second)
			defer cancelStop()
			go func() { stopped <- runtime.StopWorkspace(stopCtx, first.WorkspaceID) }()
			require.True(t, assertEventually(5*time.Second, func() bool {
				_, err := os.Stat(stopAcknowledged)
				return err == nil
			}), "runtime did not request the guest stop")
			select {
			case err := <-stopped:
				t.Fatalf("stop returned before independent observation: %v", err)
			case <-time.After(300 * time.Millisecond):
			}
			require.True(t, runtime.AdmissionHeld(releasedHolder), "acknowledgment must retain ownership")
			held("stop acknowledged, guest still running", 2)
			pending := cards()
			require.Equal(t, "paused", pending[1].State)
			require.Equal(t, "working", pending[2].State)
			for _, n := range []int{3, 4, 5, 6} {
				require.Equal(t, "queued", pending[n].State, "acknowledgment cannot admit T%d", n)
			}
			for _, n := range []int64{3, 4, 5, 6} {
				queued, err := q.GetMythicalItemByNumber(ctx, repo.ID, n)
				require.NoError(t, err)
				require.Empty(t, queued.WorkspaceID, "no machine before observed stop")
				require.Empty(t, queued.RequestRunID, "no run before observed stop")
			}
			// Only this observed disappearance allows the production scheduler
			// to reuse the occupied slot; neither disk nor parallel changes.
			require.NoError(t, os.Remove(stopPending))
			require.NoError(t, <-stopped)
			require.False(t, runtime.AdmissionHeld(releasedHolder), "stop must be observed before capacity is reused")
			expectedParallel, expectedHeld = 2, 2
		} else {
			// J7's assisted process runtime cannot qualify safe-idle release.
			// Exercise that dependency failure on the production scheduler too:
			// incomplete composition and an unreadable safety authority must not
			// manufacture capacity or let the older successor leapfrog T6.
			idle := microsandbox.AdmissionIdleProviders{
				FreeDisk: readDisk,
				Safety: func(context.Context) ([]microsandbox.AdmissionSafety, error) {
					return nil, errors.New("presence authority unavailable")
				},
				Prepare: func(context.Context, string) error {
					t.Error("unknown safety must not capture a branch")
					return errors.New("unexpected capture")
				},
				Stop: func(context.Context, string) error {
					t.Error("unknown safety must not stop a machine")
					return errors.New("unexpected stop")
				},
			}
			now := time.Now()
			for _, missing := range []string{"disk", "safety", "capture", "stop"} {
				partial := idle
				switch missing {
				case "disk":
					partial.FreeDisk = nil
				case "safety":
					partial.Safety = nil
				case "capture":
					partial.Prepare = nil
				case "stop":
					partial.Stop = nil
				}
				require.ErrorContains(t, runtime.SetAdmissionIdleProviders(partial), "admission idle providers unavailable", missing)
				require.ErrorContains(t, runtime.ReconcileAdmissionIdle(ctx, now, now.Add(-time.Minute), partial), "admission idle providers unavailable", missing)
			}
			require.ErrorContains(t, runtime.ReconcileAdmissionIdle(ctx, now, now.Add(-time.Minute), idle), "presence authority unavailable")
			settle("idle release unavailable", map[int]string{1: "working", 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "queued"}, map[int]int{6: 1, 3: 2, 4: 3, 5: 4})
			held("idle release unavailable", 2)
			for _, n := range []int64{3, 4, 5, 6} {
				queued, err := q.GetMythicalItemByNumber(ctx, repo.ID, n)
				require.NoError(t, err)
				require.Empty(t, queued.WorkspaceID, "no machine without released capacity")
				require.Empty(t, queued.RequestRunID, "no run without released capacity")
			}
			freeDisk.Store(microsandbox.MinFreeDiskBytes + 3*microsandbox.MachineDiskBytes)
		}
		var last map[int]parallelCard
		require.True(t, assertEventually(30*time.Second, func() bool {
			last = cards()
			for _, n := range []int{3, 4, 5} {
				require.Equal(t, "queued", last[n].State, "successor T%d admitted before inserted T6: %+v", n, last)
			}
			return last[6].State == "working"
		}), "inserted TODO did not take freed capacity: %+v; admission %+v", last, runtime.AdmissionSnapshot())
		settle("Before capacity recovery", map[int]string{1: firstState, 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "working"}, map[int]int{3: 1, 4: 2, 5: 3})
		homeSnapshot("Before capacity recovery", homeView{Order: []int{1, 2, 6, 3, 4, 5}, Positions: map[int]int{3: 1, 4: 2, 5: 3}, Parallel: expectedParallel})
		inserted, err := q.GetMythicalItemByNumber(ctx, repo.ID, 6)
		require.NoError(t, err)
		require.NotEmpty(t, inserted.WorkspaceID)
		require.NotEmpty(t, inserted.RequestRunID)
		require.True(t, runtime.AdmissionHeld("workspace:"+inserted.WorkspaceID))
		// The same durable request also replays after the queued item has
		// acquired its machine and run; replay must not reset either identity.
		code, body = callKey("POST", "/api/todos", beforeBody, mayaCookie, beforeKey)
		require.Equal(t, 202, code, string(body))
		require.JSONEq(t, string(beforeReceipt), string(body))
		replayed, err := q.GetMythicalItemByNumber(ctx, repo.ID, 6)
		require.NoError(t, err)
		require.Equal(t, inserted.WorkspaceID, replayed.WorkspaceID)
		require.Equal(t, inserted.RequestRunID, replayed.RequestRunID)
		require.Equal(t, inserted.Attempt, replayed.Attempt)
		require.Len(t, cards(), 6, "replayed Before must not allocate another TODO")
		for _, n := range []int64{3, 4, 5} {
			successor, err := q.GetMythicalItemByNumber(ctx, repo.ID, n)
			require.NoError(t, err)
			require.Empty(t, successor.WorkspaceID, "queued successor must have no machine")
			require.Empty(t, successor.RequestRunID, "queued successor must have no launch")
		}
		var facts int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.created' AND (data->>'n')::bigint=6 AND (data->>'before')::bigint=3`).Scan(&facts))
		require.Equal(t, 1, facts)
		held("Before capacity recovery", expectedHeld)
		if releasedHolder != "" {
			require.False(t, runtime.AdmissionHeld(releasedHolder))
			require.Equal(t, microsandbox.MinFreeDiskBytes+2*microsandbox.MachineDiskBytes, freeDisk.Load(), "a released slot, not more disk, admitted T6")
		}
		saved, err := q.GetInstallParallel(ctx)
		require.NoError(t, err)
		require.JSONEq(t, `8`, string(saved), "automatic capacity recovery must preserve the owner setting")
		return
	}

	// The reviewed candidate is prior-step input to this admission check.
	// Release uses the production safety observer, daemon capture/publication
	// and runtime stop observation, not a direct grant or stop call.
	retainedObservations := 0
	parallelAutomaticIdleRelease(t, pool, workspaces, stack, runtime, host, repo.ID, maya.ID, stopPending, stopAcknowledged, firstBoot, readDisk, func() {
		settle("in review holds until observed stop", map[int]string{1: "in_review", 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "queued"}, map[int]int{6: 1, 3: 2, 4: 3, 5: 4})
		homeSnapshot("in review retains slot", homeView{Order: beforeOrder, Positions: map[int]int{6: 1, 3: 2, 4: 3, 5: 4}, Parallel: 2})
		held("in review retains slot", 2)
		retainedObservations++
		if retainedObservations == 1 {
			parallelBrowserCheckpoint(t, "reviewed")
		} else {
			parallelBrowserCheckpoint(t, "stopping")
		}
	})
	settle("step 2 released", map[int]string{1: "in_review", 2: "working", 3: "queued", 4: "queued", 5: "queued", 6: "working"}, map[int]int{3: 1, 4: 2, 5: 3})
	homeSnapshot("step 2 released", homeView{Order: beforeOrder, Positions: map[int]int{3: 1, 4: 2, 5: 3}, Parallel: 2})
	todoSnapshot("step 2 released", 6, 0)
	held("step 2 released", 2)
	parallelBrowserCheckpoint(t, "released")
	parallelBrowserCheckpoint(t, "settings")

	// Step 3: the owner raises the request to 8. Capacity 3 clamps it, and
	// the third machine goes to the next TODO in stack order: T3, after T6.
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
	settle("step 3", map[int]string{1: "in_review", 2: "working", 3: "working", 4: "queued", 5: "queued", 6: "working"}, map[int]int{4: 1, 5: 2})
	homeSnapshot("step 3", homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{4: 1, 5: 2}, Parallel: 3})
	todoSnapshot("step 3", 4, 1)
	todoSnapshot("step 3", 6, 0)
	held("step 3", 3)
	parallelBrowserCheckpoint(t, "raised")

	// Step 4: free disk falls to capacity 2, then 0, while three TODO machines
	// are held. Nothing is preempted and nothing new is granted; the saved
	// request stays 8.
	working := map[int]string{1: "in_review", 2: "working", 3: "working", 4: "queued", 5: "queued", 6: "working"}
	for _, fixture := range []struct {
		free     int64
		parallel int
	}{{microsandbox.MinFreeDiskBytes + 2*microsandbox.MachineDiskBytes, 2}, {microsandbox.MinFreeDiskBytes + (20 << 30), 0}} {
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
		settle(step, working, map[int]int{4: 1, 5: 2})
		homeSnapshot(step, homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{4: 1, 5: 2}, Parallel: fixture.parallel})
		code, body = call("GET", "/api/install", "", mayaCookie)
		require.Equal(t, 200, code, string(body))
		require.NoError(t, json.Unmarshal(body, &install))
		require.Equal(t, 8, install.Parallel, step)
		if fixture.parallel == 0 {
			parallelBrowserCheckpoint(t, "zero")
		}
	}

	// Step 5: Ben opens a terminal on his sleeping scratch branch through the
	// install's terminal door while TODOs wait. His person request waits
	// ahead of every TODO; one Home delta moves all their positions.
	freeDisk.Store(microsandbox.MinFreeDiskBytes + 2*microsandbox.MachineDiskBytes)
	homeConn := dial("home")
	kind, before := readHome(homeConn)
	require.Equal(t, "snap", kind)
	require.Equal(t, homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{4: 1, 5: 2}, Parallel: 2}, before)
	// Keep a real TODO subscription open across the person dispatch.
	// Its cursors must identify committed source events, including replay;
	// a refreshed seeded card cannot satisfy this acceptance boundary.
	readFrame := func(conn *websocket.Conn) live.Frame {
		t.Helper()
		deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		for {
			_, raw, err := conn.Read(deadline)
			require.NoError(t, err)
			var frame live.Frame
			require.NoError(t, json.Unmarshal(raw, &frame))
			require.NotEqual(t, "err", frame.T, string(raw))
			if frame.T == "snap" || frame.T == "delta" {
				require.NotNil(t, frame.Cursor)
				return frame
			}
		}
	}
	thirdItem, err := q.GetMythicalItemByNumber(ctx, repo.ID, 4)
	require.NoError(t, err)
	todoConn := dial("todo:4")
	todoBefore := readFrame(todoConn)
	require.Equal(t, "snap", todoBefore.T)
	readQueueDelta := func(conn *websocket.Conn, previous int64) live.Frame {
		t.Helper()
		for {
			frame := readFrame(conn)
			require.Equal(t, "delta", frame.T)
			require.Greater(t, int64(*frame.Cursor), previous)
			previous = int64(*frame.Cursor)
			var event jobs.Event
			require.NoError(t, json.Unmarshal(frame.Data, &event))
			var data struct {
				Card parallelCard `json:"card"`
			}
			require.NoError(t, json.Unmarshal(event.Data, &data))
			if data.Card.Queue == nil || data.Card.Queue.Position != 2 {
				continue
			}
			require.Equal(t, 4, data.Card.N)
			require.Equal(t, "machine", data.Card.Queue.Reason)
			var committed []byte
			require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND sequence=$3`,
				fmt.Sprint(repo.ID), "todo:"+uuid.UUID(thirdItem.ID.Bytes).String(), *frame.Cursor).Scan(&committed))
			require.JSONEq(t, string(committed), string(event.Data))
			return frame
		}
	}
	code, body = call("POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, scratchBranch.ID), benCookie)
	require.Equal(t, 202, code, string(body))
	shifted := homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{4: 2, 5: 3}, Parallel: -1}
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
	todoShift := readQueueDelta(todoConn, int64(*todoBefore.Cursor))
	// Reconnect from the pre-dispatch cursor: the production journal replays
	// the same fact instead of synthesizing a new queue state or cursor.
	replayConn := dial("todo:4")
	require.Equal(t, "snap", readFrame(replayConn).T)
	require.NoError(t, replayConn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"todo:4","cursor":%d}`, *todoBefore.Cursor))))
	replayed := readQueueDelta(replayConn, int64(*todoBefore.Cursor))
	require.Equal(t, *todoShift.Cursor, *replayed.Cursor)
	require.JSONEq(t, string(todoShift.Data), string(replayed.Data))
	// Scratch branches have no TODO journal. Their real branch source still
	// exposes the runtime position on an authenticated subscription.
	branchConn := dial("branch:" + scratchBranch.ID)
	branchWaiting := readFrame(branchConn)
	require.Equal(t, "snap", branchWaiting.T)
	var branchCard struct {
		Machine struct {
			State    string `json:"state"`
			Position int    `json:"position"`
		} `json:"machine"`
	}
	require.NoError(t, json.Unmarshal(branchWaiting.Data, &branchCard))
	require.Equal(t, "waiting", branchCard.Machine.State)
	require.Equal(t, 1, branchCard.Machine.Position)
	// A second real terminal on the same sleeping branch coalesces without
	// taking a second position or letting a TODO jump ahead of the person.
	code, body = call("POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, scratchBranch.ID), benCookie)
	require.Equal(t, 202, code, string(body))
	require.True(t, assertEventually(10*time.Second, func() bool {
		personRows := 0
		for _, row := range runtime.AdmissionSnapshot() {
			if row.Holder == "workspace:"+scratchBranch.ID && row.State == "waiting" {
				personRows++
				if row.Class != "person" || row.Position != 1 {
					return false
				}
			}
		}
		return personRows == 1
	}), "both terminal launches share the person actor and one holder: %+v", runtime.AdmissionSnapshot())
	// A second member's terminal promotes no new holder: both people see the
	// same branch position and, later, share exactly one confirmed-stop slot.
	code, body = call("POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, scratchBranch.ID), mayaCookie)
	require.Equal(t, 202, code, string(body))
	require.True(t, assertEventually(10*time.Second, func() bool {
		people := map[string]bool{}
		for _, row := range runtime.AdmissionSnapshot() {
			if row.Holder == "workspace:"+scratchBranch.ID && row.State == "waiting" {
				if row.Class != "person" || row.Position != 1 {
					return false
				}
				people[row.Actor] = true
			}
		}
		return people[fmt.Sprintf("person:%d", maya.ID)] && people[fmt.Sprintf("person:%d", ben.ID)] && len(people) == 2
	}), "two members coalesce on the same branch: %+v", runtime.AdmissionSnapshot())
	readBranchPlace := func(position int, state string) {
		t.Helper()
		var branch services.BranchMachineResponse
		require.True(t, assertEventually(2*time.Second, func() bool {
			code, body := call("GET", "/api/branches/"+scratchBranch.ID, "", mayaCookie)
			require.Equal(t, 200, code, string(body))
			require.NoError(t, json.Unmarshal(body, &branch))
			return branch.Machine.WaitPosition == position && branch.State == state
		}), "branch machine %+v", branch)
	}
	// Concurrent requests enter the real terminal/auth/router door. They must
	// keep the two member actors on one waiting holder and leave every TODO
	// position unchanged; duplicate launches cannot spend extra slots.
	type terminalResult struct {
		code int
		body []byte
	}
	results := make(chan terminalResult, 50)
	var launches sync.WaitGroup
	for i := range 50 {
		launches.Add(1)
		go func() {
			defer launches.Done()
			cookie := benCookie
			if i%2 == 0 {
				cookie = mayaCookie
			}
			code, body := call("POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, scratchBranch.ID), cookie)
			results <- terminalResult{code, body}
		}()
	}
	launches.Wait()
	close(results)
	accepted, limited := 0, 0
	for result := range results {
		switch result.code {
		case http.StatusAccepted:
			accepted++
		case http.StatusTooManyRequests:
			limited++
			var refusal struct {
				Code  string `json:"code"`
				Class string `json:"class"`
			}
			require.NoError(t, json.Unmarshal(result.body, &refusal))
			require.Equal(t, "rate_limit_exceeded", refusal.Code)
			require.Equal(t, "capacity", refusal.Class)
		default:
			t.Fatalf("terminal launch returned %d: %s", result.code, result.body)
		}
	}
	require.Positive(t, accepted)
	require.Positive(t, limited, "the production per-member launch limit remains enforced")
	require.Equal(t, 50, accepted+limited)
	waitingActors := map[string]bool{}
	for _, row := range runtime.AdmissionSnapshot() {
		if row.Holder == "workspace:"+scratchBranch.ID && row.State == "waiting" {
			require.Equal(t, "person", row.Class)
			require.Equal(t, 1, row.Position)
			waitingActors[row.Actor] = true
		}
	}
	require.Len(t, waitingActors, 2)
	held("concurrent terminal requests", 3)
	readBranchPlace(1, "asleep")
	settle("step 5 waiting", working, map[int]int{4: 2, 5: 3})
	todoSnapshot("step 5 waiting", 4, 2)
	held("step 5 waiting", 3)
	parallelBrowserCheckpoint(t, "person")
	var browser *exec.Cmd
	var browserOutput *bufio.Scanner
	var browserErrors bytes.Buffer
	if os.Getenv("SMITHERS_LIVE_BROWSER") == "1" {
		app, err := filepath.Abs("../../../../apps/app")
		require.NoError(t, err)
		browserCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		t.Cleanup(cancel)
		browser = exec.CommandContext(browserCtx, "bun", "e2e/real/admission-branch.browser.ts")
		browser.Dir = app
		browser.Env = append(os.Environ(), "SMITHERS_ADMISSION_ORIGIN="+server.URL, "SMITHERS_ADMISSION_BRANCH="+scratchBranch.ID, "SMITHERS_ADMISSION_COOKIE="+mayaCookie)
		output, err := browser.StdoutPipe()
		require.NoError(t, err)
		browser.Stderr = &browserErrors
		require.NoError(t, browser.Start())
		t.Cleanup(func() {
			cancel()
			if browser.ProcessState == nil {
				_ = browser.Wait()
			}
		})
		browserOutput = bufio.NewScanner(output)
		waiting := false
		for browserOutput.Scan() {
			line := browserOutput.Text()
			t.Log(line)
			if line == "ADMISSION_BROWSER_WAITING" {
				waiting = true
				break
			}
		}
		require.True(t, waiting, "browser did not observe the real queue: %s", browserErrors.String())
	}
	// Capacity returns to 4: one machine is free and T3 is eligible again.
	// Ben's person request is granted before it; T3 starts and waits #1.
	freeDisk.Store(microsandbox.MinFreeDiskBytes + 4*microsandbox.MachineDiskBytes)
	require.True(t, assertEventually(15*time.Second, func() bool { return runtime.AdmissionHeld("workspace:" + scratchBranch.ID) }), "Ben's wake is granted: %s %+v", scratchBranch.ID, runtime.AdmissionSnapshot())
	settle("step 5 granted", map[int]string{1: "in_review", 2: "working", 3: "working", 4: "starting", 5: "queued", 6: "working"}, map[int]int{4: 1, 5: 2})
	homeSnapshot("step 5 granted", homeView{Order: []int{1, 6, 2, 3, 4, 5}, Positions: map[int]int{4: 1, 5: 2}, Parallel: 4})
	held("step 5 granted", 4)
	parallelBrowserCheckpoint(t, "granted")
	readBranchPlace(0, "waking")
	// The already-mounted branch subscriber must observe the actual grant,
	// rather than relying on a fresh GET or an intercepted browser frame.
	// Scratch machine transitions have committed cursors and replay even
	// after replacing the source resolver and hub (no in-process counter).
	lastBranchCursor := int64(*branchWaiting.Cursor)
	var machineGrant live.Frame
	for {
		frame := readFrame(branchConn)
		if frame.T == "snap" {
			continue
		}
		require.Equal(t, "delta", frame.T)
		require.Greater(t, int64(*frame.Cursor), lastBranchCursor)
		lastBranchCursor = int64(*frame.Cursor)
		var event jobs.Event
		require.NoError(t, json.Unmarshal(frame.Data, &event))
		require.Contains(t, []string{"branch.machine", "branch.machine.granted"}, event.Type)
		var fact struct {
			Branch struct {
				Machine struct {
					State    string
					Position int
				}
			}
		}
		require.NoError(t, json.Unmarshal(event.Data, &fact))
		var committed []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND sequence=$3`, fmt.Sprint(repo.ID), "branch:"+scratchBranch.ID+":machine", *frame.Cursor).Scan(&committed))
		require.JSONEq(t, string(committed), string(event.Data))
		if fact.Branch.Machine.State == "waking" {
			require.Zero(t, fact.Branch.Machine.Position)
			machineGrant = frame
			break
		}
	}
	restartedTopics := *topics
	restartedLive := &routes.LiveHandler{Hub: live.NewHub(liveContext, nil), Queries: q, Origins: liveHandler.Origins, Topics: restartedTopics.resolver}
	restartedServer := httptest.NewServer(parallelInstallRouter(cfg, q, pool, terminals, routerExtras{Live: restartedLive}))
	defer restartedServer.Close()
	replayBranch, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(restartedServer.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, Host: "127.0.0.1:4000", HTTPHeader: http.Header{"Origin": {cfg.Server.PublicURL}, "Cookie": {"smithers_session=" + benCookie}}})
	require.NoError(t, err)
	defer replayBranch.CloseNow()
	require.NoError(t, replayBranch.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s","cursor":%d}`, scratchBranch.ID, *branchWaiting.Cursor))))
	for {
		replay := readFrame(replayBranch)
		require.Equal(t, "delta", replay.T)
		if *replay.Cursor == *machineGrant.Cursor {
			require.JSONEq(t, string(machineGrant.Data), string(replay.Data))
			break
		}
	}

	if browser != nil {
		for browserOutput.Scan() {
			t.Log(browserOutput.Text())
		}
		require.NoError(t, browserOutput.Err())
		require.NoError(t, browser.Wait(), browserErrors.String())
	}
	// A second projector (as during worker recovery) must reuse the journal's
	// last committed observation, not append an invented transition.
	scratchScope := jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: "branch:" + scratchBranch.ID + ":machine"}
	stableHead, err := store.Head(ctx, scratchScope)
	require.NoError(t, err)
	recovered := services.NewMythicalService(pool, host, services.WithMythicalInstallAuthorization(true))
	recovered.SetInstallParallel(capacity)
	recovered.SetOrchestration(nil, dispatcher, services.NewWorkspaceMythicalLanes(workspaces))
	recoveryCtx, stopRecovery := context.WithCancel(liveContext)
	defer stopRecovery()
	go recovered.StartMachineQueueProjection(recoveryCtx)
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		held("step 5 granted", 4)
		readBranchPlace(0, "waking")
		time.Sleep(200 * time.Millisecond)
	}
	afterRecovery, err := store.Head(ctx, scratchScope)
	require.NoError(t, err)
	require.Equal(t, stableHead, afterRecovery, "unchanged scratch observations survive projector recovery without extra facts")
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
		case in == reflect.TypeOf(&routes.UserHandler{}):
			args[i] = reflect.ValueOf(&routes.UserHandler{ProfileService: services.NewUserService(q)})
		case in == reflect.TypeOf(&routes.WorkspaceHandler{}) && terminal != nil:
			args[i] = reflect.ValueOf(&routes.WorkspaceHandler{Service: terminal.Service.(*services.WorkspaceService)})
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

func exerciseTenBranchTerminals(t *testing.T, branches []db.Workspace, runtime *microsandbox.Runtime, serverURL, publicURL, mayaCookie, benCookie string, call func(string, string, string, string) (int, []byte), freeDisk *atomic.Int64, sshProbe func(db.Workspace) (func(int), func())) {
	t.Helper()
	ctx := t.Context()
	open := func(branch db.Workspace, cookie string) {
		t.Helper()
		code, body := call("POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, branch.ID), cookie)
		require.Equal(t, http.StatusAccepted, code, string(body))
	}
	// First arrivals establish literal FIFO expectations independently of the
	// scheduler's ranks. Later requests arrive concurrently on all ten holders.
	for i, branch := range branches {
		open(branch, mayaCookie)
		require.Eventually(t, func() bool {
			for _, row := range runtime.AdmissionSnapshot() {
				if row.Holder == "workspace:"+branch.ID {
					if i == 0 {
						return row.State == "granted"
					}
					return row.State == "waiting" && row.Position == i
				}
			}
			return false
		}, 5*time.Second, 10*time.Millisecond)
	}
	results := make(chan struct {
		code int
		body []byte
	}, 40)
	var group sync.WaitGroup
	for i := range 40 {
		group.Add(1)
		go func() {
			defer group.Done()
			cookie := mayaCookie
			if (i/10)%2 == 0 {
				cookie = benCookie
			}
			code, body := call("POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, branches[i%10].ID), cookie)
			results <- struct {
				code int
				body []byte
			}{code, body}
		}()
	}
	group.Wait()
	close(results)
	for result := range results {
		require.Equal(t, http.StatusAccepted, result.code, string(result.body))
	}
	sshWaiting := false
	check := func() bool {
		rows := runtime.AdmissionSnapshot()
		expectedRows := 20
		if sshWaiting {
			expectedRows++
		}
		if runtime.InUse() != 1 || len(rows) != expectedRows {
			return false
		}
		for i, branch := range branches {
			actors := map[string]bool{}
			for _, row := range rows {
				if row.Holder != "workspace:"+branch.ID {
					continue
				}
				if row.Class != "person" || actors[row.Actor] {
					return false
				}
				actors[row.Actor] = true
				if i == 0 {
					if row.State != "granted" || row.Position != 0 {
						return false
					}
				} else if row.State != "waiting" || row.Position != i {
					return false
				}
			}
			expectedActors := 2
			if i == 9 && sshWaiting {
				expectedActors = 3
			}
			if len(actors) != expectedActors {
				return false
			}
		}
		return true
	}
	require.Eventually(t, check, 10*time.Second, 10*time.Millisecond, "50 launches must coalesce into two actors per holder: %+v", runtime.AdmissionSnapshot())
	sshPosition, closeSSH := sshProbe(branches[9])
	sshPosition(9)
	sshWaiting = true
	require.Eventually(t, func() bool {
		return len(runtime.AdmissionSnapshot()) == 21 && runtime.InUse() == 1
	}, 5*time.Second, 10*time.Millisecond, "SSH must add its own actor to the existing branch holder")
	// Every member-facing branch response and authenticated live subscription
	// must expose the same dense FIFO positions. No frame is manufactured.
	connections := make([]*websocket.Conn, len(branches))
	cursors := make([]int64, len(branches))
	for i, branch := range branches {
		code, body := call("GET", "/api/branches/"+branch.ID, "", benCookie)
		require.Equal(t, http.StatusOK, code, string(body))
		var card services.BranchMachineResponse
		require.NoError(t, json.Unmarshal(body, &card))
		require.Equal(t, i, card.Machine.WaitPosition)
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(serverURL, "http")+"/api/live", &websocket.DialOptions{
			Subprotocols: []string{live.Protocol}, Host: strings.TrimPrefix(publicURL, "http://"),
			HTTPHeader: http.Header{"Cookie": {"smithers_session=" + benCookie}, "Origin": {publicURL}},
		})
		require.NoError(t, err)
		require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, branch.ID))))
		deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
		for {
			_, raw, err := conn.Read(deadline)
			require.NoError(t, err)
			var frame live.Frame
			require.NoError(t, json.Unmarshal(raw, &frame))
			require.NotEqual(t, "err", frame.T, string(raw))
			if frame.T != "snap" {
				continue
			}
			require.NotNil(t, frame.Cursor)
			cursors[i] = *frame.Cursor
			var snapshot struct {
				Machine struct {
					State    string `json:"state"`
					Position int    `json:"position"`
				} `json:"machine"`
			}
			require.NoError(t, json.Unmarshal(frame.Data, &snapshot))
			require.Equal(t, i, snapshot.Machine.Position)
			if i > 0 {
				require.Equal(t, "waiting", snapshot.Machine.State)
			} else {
				require.Equal(t, "waking", snapshot.Machine.State)
			}
			break
		}
		cancel()
		connections[i] = conn
		t.Cleanup(func() { conn.CloseNow() })
	}
	// Capacity falling below held must neither stop the in-flight boot nor
	// admit any waiting branch. Read-only doors remain usable during the boot.
	freeDisk.Store(microsandbox.MinFreeDiskBytes + (20 << 30))
	until := time.Now().Add(2100 * time.Millisecond)
	for time.Now().Before(until) {
		require.True(t, check(), "disk pressure changed held ownership: %+v", runtime.AdmissionSnapshot())
		code, body := call("GET", "/api/todos", "", benCookie)
		require.Equal(t, http.StatusOK, code, string(body))
		time.Sleep(20 * time.Millisecond)
	}
	freeDisk.Store(microsandbox.MinFreeDiskBytes + microsandbox.MachineDiskBytes)
	require.True(t, check(), "restored capacity cannot spend an unconfirmed slot")

	// Keep the actual subscriptions alive across disk recovery and owner
	// changes. A fresh subscription alone cannot prove advancing publication.
	observe := func(granted int) {
		t.Helper()
		require.Eventually(t, func() bool {
			if runtime.InUse() != granted {
				return false
			}
			for i, branch := range branches {
				for _, row := range runtime.AdmissionSnapshot() {
					if row.State == "cancelled" || row.State == "released" || row.Holder != "workspace:"+branch.ID {
						continue
					}
					if i < granted {
						if row.State != "granted" {
							return false
						}
					} else if row.State != "waiting" || row.Position != i-granted+1 {
						return false
					}
				}
			}
			return true
		}, 5*time.Second, 10*time.Millisecond)
		for i := granted - 1; i < len(branches); i++ {
			deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
			for {
				_, raw, err := connections[i].Read(deadline)
				require.NoError(t, err)
				var frame live.Frame
				require.NoError(t, json.Unmarshal(raw, &frame))
				require.NotEqual(t, "err", frame.T, string(raw))
				require.NotEqual(t, "gap", frame.T, string(raw))
				if frame.T != "snap" && frame.T != "delta" {
					continue
				}
				require.NotNil(t, frame.Cursor)
				var card struct {
					Machine struct {
						State    string `json:"state"`
						Position int    `json:"position"`
					} `json:"machine"`
				}
				data := frame.Data
				if frame.T == "delta" {
					var event jobs.Event
					require.NoError(t, json.Unmarshal(data, &event))
					var fact struct{ Branch json.RawMessage }
					require.NoError(t, json.Unmarshal(event.Data, &fact))
					data = fact.Branch
				}
				require.NoError(t, json.Unmarshal(data, &card))
				state, position := "waiting", i-granted+1
				if i < granted {
					state, position = "waking", 0
				}
				if card.Machine.State != state || card.Machine.Position != position {
					continue
				}
				require.Greater(t, *frame.Cursor, cursors[i], "grant and rank changes need a newer source cursor")
				cursors[i] = *frame.Cursor
				break
			}
			cancel()
			code, body := call("GET", "/api/branches/"+branches[i].ID, "", benCookie)
			require.Equal(t, http.StatusOK, code, string(body))
			var branch services.BranchMachineResponse
			require.NoError(t, json.Unmarshal(body, &branch))
			position := 0
			if i >= granted {
				position = i - granted + 1
			}
			require.Equal(t, position, branch.Machine.WaitPosition)
		}
	}
	freeDisk.Store(microsandbox.MinFreeDiskBytes + 2*microsandbox.MachineDiskBytes) // two slots; the oldest waiting holder wins
	observe(2)
	sshPosition(8)
	closeSSH()
	require.Eventually(t, func() bool {
		active := 0
		for _, row := range runtime.AdmissionSnapshot() {
			if row.Holder == "workspace:"+branches[9].ID && row.State == "waiting" {
				active++
			}
		}
		return active == 2 && runtime.InUse() == 2
	}, 5*time.Second, 10*time.Millisecond, "SSH cancellation cannot remove either terminal actor or spend the holder's slot")
	code, body := call("PUT", "/api/install", `{"capacity":1}`, mayaCookie)
	require.Equal(t, http.StatusOK, code, string(body))
	freeDisk.Store(microsandbox.MinFreeDiskBytes + 3*microsandbox.MachineDiskBytes) // three disk slots, still limited by owner to one
	until = time.Now().Add(2100 * time.Millisecond)
	for time.Now().Before(until) {
		require.Equal(t, 2, runtime.InUse(), "lowering capacity cannot preempt either unresolved wake")
		require.True(t, runtime.AdmissionHeld("workspace:"+branches[0].ID))
		require.True(t, runtime.AdmissionHeld("workspace:"+branches[1].ID))
		require.False(t, runtime.AdmissionHeld("workspace:"+branches[2].ID))
		time.Sleep(20 * time.Millisecond)
	}
	code, body = call("PUT", "/api/install", `{"capacity":3}`, mayaCookie)
	require.Equal(t, http.StatusOK, code, string(body))
	observe(3)
}

// The production gateway and daemon bridge own authentication, durable SSH
// reservation, person admission and cancellation. No daemon session starts:
// this holder waits behind the injected unresolved boots.
func queuedSSHProbe(t *testing.T, pool *pgxpool.Pool, service *services.WorkspaceService, cfg *config.Config, member int64) func(db.Workspace) (func(int), func()) {
	t.Helper()
	ctx := t.Context()
	q := db.New(pool)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = q.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: member, Name: "admission", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET unix_login='ben',unix_uid=20001 WHERE user_id=$1`, member)
	require.NoError(t, err)
	sshConfig := *cfg
	sshConfig.SSH.Addr = "127.0.0.1:0"
	sshConfig.SSH.HostKeyDir = t.TempDir()
	bridge := installDaemonBridge(pool, service, new(machined.Registry))
	_, port, stop, err := startInstallSSH(ctx, &sshConfig, pool, repository.NewRemoteClient(nil, "admission"), nil, bridge, cfg.Server.PublicURL)
	require.NoError(t, err)
	t.Cleanup(stop)
	hostBytes, err := os.ReadFile(filepath.Join(sshConfig.SSH.HostKeyDir, "ssh_host_ed25519_key"))
	require.NoError(t, err)
	host, err := gossh.ParsePrivateKey(hostBytes)
	require.NoError(t, err)
	return func(branch db.Workspace) (func(int), func()) {
		client, err := gossh.Dial("tcp", net.JoinHostPort("127.0.0.1", port), &gossh.ClientConfig{User: branch.Name, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.FixedHostKey(host.PublicKey()), Timeout: 5 * time.Second})
		require.NoError(t, err)
		t.Cleanup(func() { client.Close() })
		session, err := client.NewSession()
		require.NoError(t, err)
		stderr, err := session.StderrPipe()
		require.NoError(t, err)
		positions := make(chan string, 32)
		go func() {
			scanner := bufio.NewScanner(stderr)
			for scanner.Scan() {
				positions <- scanner.Text()
			}
			close(positions)
		}()
		require.NoError(t, session.Start("true"))
		return func(position int) {
			t.Helper()
			wanted := fmt.Sprintf("waiting for a machine #%d", position)
			timer := time.NewTimer(5 * time.Second)
			defer timer.Stop()
			for {
				select {
				case line, ok := <-positions:
					require.True(t, ok, "SSH closed before reporting %s", wanted)
					if line == wanted {
						var id string
						require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM workspace_sessions WHERE workspace_id=$1 AND user_id=$2 AND status IN ('pending','starting')`, branch.ID, member).Scan(&id))
						receipt, err := service.MemberReservation(ctx, id, branch.RepositoryID, member, "ben", 20001)
						require.NoError(t, err)
						require.Equal(t, branch.ID, receipt.WorkspaceID)
						for _, invalid := range []struct {
							repository, member int64
							login              string
							uid                uint32
						}{
							{branch.RepositoryID, member, "root", 20001},
							{branch.RepositoryID, member, "ben", 0},
							{branch.RepositoryID, member - 1, "maya", 20000},
							{branch.RepositoryID, member + 1, "ben", 20001},
							{branch.RepositoryID + 1, member, "ben", 20001},
						} {
							_, err := service.MemberReservation(ctx, id, invalid.repository, invalid.member, invalid.login, invalid.uid)
							require.Error(t, err, "foreign reservation identity must refuse")
						}
						_, err = service.GetSession(ctx, id, branch.RepositoryID, member)
						require.Error(t, err, "the HTTP reader still requires a request credential")
						return
					}
				case <-timer.C:
					t.Fatalf("SSH did not report %s", wanted)
				}
			}
		}, func() { session.Close(); client.Close() }
	}
}
