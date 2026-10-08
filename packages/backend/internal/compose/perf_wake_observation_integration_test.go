package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Linux has no guest runtime. This boundary controls guest transport and host
// readiness, while admission, auth, durable status and observation are real.
// Native runtime classification is checked independently in microsandbox.
// It is not lifecycle/security qualification or a C-PERF receipt.
type perfWakeRuntime struct {
	queue *microsandbox.Runtime
	workspaceapi.WorkspaceRuntime
	mu               sync.Mutex
	row              db.Workspace
	state            workspaceapi.WorkspaceState
	mode             string
	entered, release chan struct{}
	once             sync.Once
	registry         machined.Registry
	owner            *terminalMemberRuntime
}

const perfWakeHead = "0123456789012345678901234567890123456789"
const perfWakeClone = "http://127.0.0.1:4000/presence-owner/app.git"

func (r *perfWakeRuntime) EnsureMachined(ctx context.Context, branch string) error {
	r.owner.admitted = true
	return r.owner.EnsureMachined(ctx, branch)
}
func (r *perfWakeRuntime) SessionCredentialsForMember(ctx context.Context, branch string, member microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error) {
	return r.owner.SessionCredentialsForMember(ctx, branch, member)
}
func (*perfWakeRuntime) StopService(context.Context, string, string) error { return nil }

func (r *perfWakeRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{Terminal: true, Execution: true, PersistentFiles: true, FileOperations: true}
}
func (r *perfWakeRuntime) WaitAdmission(ctx context.Context, providers microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	if r.queue != nil {
		r.once.Do(func() { close(r.entered) })
		return r.queue.WaitAdmission(ctx, providers, class, holder, actor, reason)
	}
	// Capacity is controlled because this VM has no guest runtime. The actual
	// installed readiness callback still verifies durable member/session and
	// branch authority; this is never a qualification receipt.
	if err := providers.Ready(ctx, microsandbox.AdmissionRequest{Class: class, Holder: holder, Actor: actor, Reason: reason}); err != nil {
		return ctx, err
	}
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
	case <-ctx.Done():
		return ctx, ctx.Err()
	}
	return ctx, nil
}
func (*perfWakeRuntime) GuestIdentity() (string, int) { return "agent", 1000 }
func (r *perfWakeRuntime) Request(class, holder, actor, reason string) (microsandbox.AdmissionRequest, error) {
	return r.queue.Request(class, holder, actor, reason)
}
func (r *perfWakeRuntime) CancelAdmission(holder, actor string, now time.Time) bool {
	return r.queue != nil && r.queue.CancelAdmission(holder, actor, now)
}
func (r *perfWakeRuntime) AdmissionSnapshot() []microsandbox.AdmissionRequest {
	if r.queue == nil {
		return nil
	}
	return r.queue.AdmissionSnapshot()
}
func (r *perfWakeRuntime) MachinedRegistry() *machined.Registry { return &r.registry }
func (r *perfWakeRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (r *perfWakeRuntime) InspectWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return workspaceapi.Workspace{ID: r.row.ID, Root: "/workspace", Home: "/home/member", State: r.state}, nil
}
func (r *perfWakeRuntime) StartWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.Workspace{}, err
	}
	if r.mode == "failed boot" {
		workspaceapi.ObserveWake(ctx, "warm", true)
		return workspaceapi.Workspace{}, errors.New("controlled guest boot refusal")
	}
	r.mu.Lock()
	r.state = workspaceapi.WorkspaceRunning
	r.mu.Unlock()
	workspaceapi.ObserveWake(ctx, "warm", false)
	return r.InspectWorkspace(ctx, id)
}
func (r *perfWakeRuntime) ListFiles(_ context.Context, _, path string) ([]workspaceapi.FileEntry, error) {
	if path == "" {
		return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}, {Name: ".jj", IsDir: true}}, nil
	}
	if path == ".git" {
		return []workspaceapi.FileEntry{{Name: "smithers-workspace-initialization.json"}}, nil
	}
	return nil, fmt.Errorf("unexpected guest directory %q", path)
}
func (r *perfWakeRuntime) ReadFile(_ context.Context, _, path string) ([]byte, error) {
	if path != ".git/smithers-workspace-initialization.json" {
		return nil, fmt.Errorf("unexpected guest file %q", path)
	}
	return json.Marshal(map[string]any{"version": 1, "workspace_id": r.row.ID, "repository_id": r.row.RepositoryID, "clone_url": perfWakeClone, "source_bookmark": r.row.TargetBookmark, "source_revision": perfWakeHead, "initialized_at": "2026-10-07T00:00:00Z"})
}
func (r *perfWakeRuntime) ExecuteCommand(_ context.Context, _ string, cmd workspaceapi.Command) (workspaceapi.CommandResult, error) {
	switch strings.Join(cmd.Args, " ") {
	case "git remote get-url origin":
		return workspaceapi.CommandResult{Stdout: perfWakeClone + "\n"}, nil
	case "git cat-file -e " + perfWakeHead + "^{commit}":
		return workspaceapi.CommandResult{}, nil
	case "jj --color=never log -r @ --no-graph -T commit_id ++ \"\\n\"":
		if r.mode == "missing head" {
			return workspaceapi.CommandResult{}, errors.New("controlled guest head refusal")
		}
		return workspaceapi.CommandResult{Stdout: perfWakeHead + "\n"}, nil
	default:
		return workspaceapi.CommandResult{}, fmt.Errorf("unexpected guest command %q", cmd.Args)
	}
}

func TestPerfWarmWakeObservationComposedInstall(t *testing.T) {
	testPerfWarmWakeObservationComposedInstall(t, false)
}

// Successful terminal boots pass through the actual runtime scheduler and
// installed branch authority. Only disk and guest observations are injected.
func TestSuccessfulTerminalAdmissionComposedInstall(t *testing.T) {
	testPerfWarmWakeObservationComposedInstall(t, true)
}

func testPerfWarmWakeObservationComposedInstall(t *testing.T, scheduled bool) {
	for _, mode := range []string{"warm", "missing head", "failed boot"} {
		t.Run(mode, func(t *testing.T) {
			f := presenceInstall(t)
			q := db.New(f.pool)
			owner, err := q.GetBranchMachineOwner(t.Context())
			require.NoError(t, err)
			branch, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.row.RepositoryID, UserID: owner, Name: "wake", TargetBookmark: "scratch/presence-owner/wake", Status: "suspended", Kind: "vm"})
			require.NoError(t, err)
			runtime := &perfWakeRuntime{row: branch, state: workspaceapi.WorkspaceStopped, mode: mode, entered: make(chan struct{}), release: make(chan struct{})}
			if scheduled {
				root := t.TempDir()
				binary := filepath.Join(root, "msb")
				require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf '[]\\n'\n"), 0700))
				queue, err := microsandbox.New(t.Context(), microsandbox.Config{Root: filepath.Join(root, "runtime"), Binary: binary, SkipQualification: true, HostProfile: &microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, DiskFreeBytes: 140 << 30}, MaxRunningVMs: 1, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768})
				require.NoError(t, err)
				t.Cleanup(func() { require.NoError(t, queue.Close()) })
				queue.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
				runtime.queue = queue
			}
			reader, writer := io.Pipe()
			terminal := &echoOwnerTerminal{reader: reader, writer: writer}
			runtime.owner = &terminalMemberRuntime{replacementRuntime: &replacementRuntime{repoID: f.row.RepositoryID}, terminal: terminal, branch: branch, member: microsandbox.MemberIdentity{Login: "ben", UID: 20001, Active: true}}
			_, err = f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','ben',20001)`, f.row.RepositoryID, f.user.ID)
			require.NoError(t, err)
			link, _ := presenceTestLink(t, &runtime.registry, branch.ID)
			require.NoError(t, link.Reconciled())
			handler := &routes.WorkspaceTerminalHandler{OwnerOnly: true}
			manager := handler.SharedTerminalSessions()
			defer manager.Close()
			authConfig := testConfigAllFlagsOn().Auth
			authConfig.Mode = "selfhost"
			auth := services.NewAuthService(q, authConfig, nil, nil)
			auth.Members = &services.Members{Pool: f.pool}
			auth.TerminalSubject = manager.OwnsSubject
			service := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)), services.WithWorkspaceCredentialIssuer(auth), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"), services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy())))
			service.EnableMachineAdmission(func(context.Context) (int64, error) {
				if scheduled {
					select {
					case <-runtime.release:
					default:
						return 40 << 30, nil
					}
				}
				return 140 << 30, nil
			})
			service.BindBranchTerminalHost(func(context.Context, db.Workspace, int64) error { return nil })
			provider := &installOwnerTerminals{queries: q, branches: service, registry: &runtime.registry}
			provider.Bind(manager)
			handler.Service = service
			handler.OwnerTerminals = provider
			var logs bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(previous) })
			var release sync.Once
			finish := func() {
				release.Do(func() { close(runtime.release) })
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				require.NoError(t, service.WaitForProvisioning(ctx))
			}
			defer finish()
			t.Cleanup(func() {
				if t.Failed() {
					t.Log(logs.String())
				}
			})
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = "selfhost"
			terminalServer := httptest.NewUnstartedServer(nil)
			cfg.Server.PublicURL = "http://" + terminalServer.Listener.Addr().String()
			cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
			handler.AllowedOrigins = cfg.Server.AllowedOrigins
			router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q}, conformanceServices{pool: f.pool, terminal: handler})
			terminalServer.Config.Handler = router
			terminalServer.Start()
			defer terminalServer.Close()
			// Keep an authenticated production subscription open across the actual
			// terminal request. Its scratch source emits snapshots, not deltas.
			f.p.branches = service
			conn := f.dial(t)
			sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, branch.ID))
			readMachine := func(state string) liveFrame {
				for {
					frame := readPresenceFrame(t, conn)
					require.NotEqual(t, "err", frame.T)
					require.NotEqual(t, "gap", frame.T)
					if frame.T != "snap" && frame.T != "delta" {
						continue
					}
					var card struct {
						Machine struct {
							State string `json:"state"`
						} `json:"machine"`
					}
					require.NoError(t, json.Unmarshal(frame.Data, &card))
					if card.Machine.State == state {
						return frame
					}
				}
			}
			asleepFrame := readMachine("asleep")
			require.Equal(t, "snap", asleepFrame.T)
			requestID := uuid.NewString()
			call := func(authenticated bool) *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodPost, cfg.Server.PublicURL+"/api/terminals", strings.NewReader(`{"branch":"`+branch.ID+`"}`))
				req.RemoteAddr = "127.0.0.1:1234"
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
				req.Header.Set("X-CSRF-Token", "csrf")
				req.Header.Set("Idempotency-Key", requestID)
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
				if authenticated {
					req.AddCookie(&http.Cookie{Name: "smithers_session", Value: f.cookie})
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, req)
				return response
			}
			require.Equal(t, 401, call(false).Code)
			first := call(true)
			require.Equal(t, 202, first.Code, first.Body.String())
			var accepted services.WorkspaceSessionResponse
			require.NoError(t, json.Unmarshal(first.Body.Bytes(), &accepted))
			select {
			case <-runtime.entered:
			case <-time.After(time.Second):
				t.Fatal("admission did not start")
			}
			heldAt := time.Now()
			duplicate := call(true)
			require.Equal(t, 202, duplicate.Code, duplicate.Body.String())
			var repeated services.WorkspaceSessionResponse
			require.NoError(t, json.Unmarshal(duplicate.Body.Bytes(), &repeated))
			require.Equal(t, accepted.ID, repeated.ID)
			require.Equal(t, "pending", repeated.Status)
			var legacySessions int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_sessions WHERE id=$1`, accepted.ID).Scan(&legacySessions))
			require.Zero(t, legacySessions, "owner terminals must not create legacy session rows")
			if scheduled {
				require.Eventually(t, func() bool {
					rows := runtime.queue.AdmissionSnapshot()
					return len(rows) == 1 && rows[0].State == "waiting" && rows[0].Class == "person" && rows[0].Position == 1
				}, 5*time.Second, 10*time.Millisecond)
				require.Zero(t, runtime.queue.InUse())
				waiting := readMachine("waiting")
				var waitingCard struct{ Machine struct{ Position int } }
				require.NoError(t, json.Unmarshal(waiting.Data, &waitingCard))
				require.Equal(t, 1, waitingCard.Machine.Position)
			}
			heldFor := time.Since(heldAt)
			finish()
			var awake liveFrame
			if mode == "warm" {
				awake = readMachine("awake")
				require.Equal(t, "snap", awake.T)
				require.NotNil(t, awake.Cursor)
				require.NotNil(t, asleepFrame.Cursor)
				require.Greater(t, *awake.Cursor, *asleepFrame.Cursor)
			}
			var records []map[string]any
			for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
				var record map[string]any
				require.NoError(t, json.Unmarshal([]byte(line), &record))
				if record["requestId"] == requestID {
					records = append(records, record)
				}
			}
			require.Len(t, records, 1)
			record := records[0]
			require.Equal(t, branch.ID, record["branch"])
			require.Equal(t, "warm", record["kind"])
			require.NotEmpty(t, record["bootId"])
			acceptedNS, err := strconv.ParseInt(record["acceptedNs"].(string), 10, 64)
			require.NoError(t, err)
			require.Positive(t, acceptedNS)
			if mode == "warm" {
				require.Equal(t, false, record["failed"])
				require.Equal(t, perfWakeHead, record["workingHead"])
				awakeNS, err := strconv.ParseInt(record["awakeWrittenNs"].(string), 10, 64)
				require.NoError(t, err)
				require.GreaterOrEqual(t, awakeNS-acceptedNS, heldFor.Nanoseconds(), "timing must include the unresolved admission wait")
				stored, err := q.GetWorkspace(t.Context(), branch.ID)
				require.NoError(t, err)
				require.Equal(t, "running", stored.Status)
				if scheduled {
					require.Equal(t, 1, runtime.queue.InUse())
					rows := runtime.queue.AdmissionSnapshot()
					require.Len(t, rows, 1)
					require.Equal(t, "granted", rows[0].State)
					require.Equal(t, "workspace:"+branch.ID, rows[0].Holder)
					require.Zero(t, rows[0].Position)
				}
			} else {
				require.Equal(t, true, record["failed"])
				require.Empty(t, record["workingHead"])
			}
			// Feed the actual server record to the actual workload validator.
			input, err := json.Marshal(map[string]any{"sample": map[string]any{"requestId": requestID, "branch": branch.ID, "capturedHead": perfWakeHead, "clientMs": 0}, "observation": record, "awake": awake, "asleep": asleepFrame})
			require.NoError(t, err)
			command := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", `import { verifyWake, awakeFrame } from './scripts/perf/warm-wake.mjs'; let raw=''; for await (const part of process.stdin) raw+=part; const {sample,observation,awake,asleep}=JSON.parse(raw); if (!observation.failed && !awakeFrame([{...awake,sequence:2}],1,asleep.cursor)) throw new Error('production awake frame rejected'); console.log(JSON.stringify(verifyWake(sample,observation)));`)
			command.Dir = "../../../.."
			command.Stdin = bytes.NewReader(input)
			output, err := command.CombinedOutput()
			if mode == "warm" {
				require.NoError(t, err, string(output))
				require.Contains(t, string(output), `"hostMs":`)
				// Exercise the workload's teardown through the same authenticated
				// owner socket as the app. A legacy destroy sees no owner row.
				endpoint := "ws" + strings.TrimPrefix(terminalServer.URL, "http") + "/api/repos/presence-owner/app/workspace/sessions/" + accepted.ID + "/terminal"
				closeInput, err := json.Marshal(map[string]any{"endpoint": endpoint, "headers": map[string]string{"Cookie": "smithers_session=" + f.cookie, "Origin": cfg.Server.PublicURL}})
				require.NoError(t, err)
				closeCommand := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", `import { closeOwnerTerminal } from './scripts/perf/warm-wake.mjs'; import {createRequire} from 'node:module'; import {resolve} from 'node:path'; const require=createRequire(resolve('packages/smithers/package.json')); let raw=''; for await (const part of process.stdin) raw+=part; const {endpoint,headers}=JSON.parse(raw); await closeOwnerTerminal(require('ws'),endpoint,headers);`)
				closeCommand.Dir = "../../../.."
				closeCommand.Stdin = bytes.NewReader(closeInput)
				closeOutput, err := closeCommand.CombinedOutput()
				require.NoError(t, err, string(closeOutput))
				require.Eventually(t, func() bool {
					var count int
					err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='terminal.closed' AND data->>'session'=$1`, accepted.ID).Scan(&count)
					return err == nil && count == 1
				}, time.Second, 10*time.Millisecond)

			} else {
				require.Error(t, err)
				require.Contains(t, string(output), "cold or failed wake")
			}
		})
	}
}

// Guest observations share one production runtime queue. Delegation here only
// selects the retained guest whose boot/PTY/filesystem is being observed.
type terminalFIFOGuests struct {
	*perfWakeRuntime
	guests  map[string]*perfWakeRuntime
	started chan string
}

func (r *terminalFIFOGuests) SyncTodoAdmission(scope string, holders []string, limit int) error {
	return r.queue.SyncTodoAdmission(scope, holders, limit)
}
func (r *terminalFIFOGuests) TodoAdmissionEligible(holder string) bool {
	return r.queue.TodoAdmissionEligible(holder)
}
func (r *terminalFIFOGuests) AdmissionOwnership(holder string) (bool, bool) {
	return r.queue.AdmissionOwnership(holder)
}
func (r *terminalFIFOGuests) InspectWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	return r.guests[id].InspectWorkspace(ctx, id)
}
func (r *terminalFIFOGuests) StartWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	if !r.queue.AdmissionHeld("workspace:" + id) {
		return workspaceapi.Workspace{}, fmt.Errorf("boot without admission")
	}
	machine, err := r.guests[id].StartWorkspace(ctx, id)
	if err == nil {
		r.started <- id
	}
	return machine, err
}
func (r *terminalFIFOGuests) EnsureMachined(ctx context.Context, id string) error {
	return r.guests[id].EnsureMachined(ctx, id)
}
func (r *terminalFIFOGuests) SessionCredentialsForMember(ctx context.Context, id string, m microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error) {
	return r.guests[id].SessionCredentialsForMember(ctx, id, m)
}
func (r *terminalFIFOGuests) ReadFile(ctx context.Context, id, path string) ([]byte, error) {
	return r.guests[id].ReadFile(ctx, id, path)
}
func (r *terminalFIFOGuests) ExecuteCommand(ctx context.Context, id string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	return r.guests[id].ExecuteCommand(ctx, id, command)
}

func TestSuccessfulTerminalFIFOInstallBoundary(t *testing.T) {
	testSuccessfulTerminalFIFOInstallBoundary(t, 3, 1)
}
func TestSuccessfulFiftyTerminalInstallBoundary(t *testing.T) {
	testSuccessfulTerminalFIFOInstallBoundary(t, 10, 5)
}
func testSuccessfulTerminalFIFOInstallBoundary(t *testing.T, branchCount, perBranch int) {
	f := presenceInstall(t)
	ctx := t.Context()
	q := db.New(f.pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='cancelled'`)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','ben',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf '[]\\n'\n"), 0700))
	profile := microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, DiskFreeBytes: 140 << 30}
	queue, err := microsandbox.New(ctx, microsandbox.Config{Root: filepath.Join(root, "runtime"), Binary: binary, SkipQualification: true, HostProfile: &profile, MaxRunningVMs: 1, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, queue.Close()) })
	var freeDisk atomic.Int64
	freeDisk.Store(40 << 30)
	readDisk := func(context.Context) (int64, error) { return freeDisk.Load(), nil }
	capacity := &services.InstallCapacityService{Queries: q, Profile: profile, FreeDisk: readDisk, InUse: queue.InUse}
	queue.SetCapacityReader(capacity.Capacity)
	runtime := &terminalFIFOGuests{perfWakeRuntime: &perfWakeRuntime{queue: queue, entered: make(chan struct{})}, guests: map[string]*perfWakeRuntime{}, started: make(chan string, branchCount)}
	var branches []db.Workspace
	for i := 0; i < branchCount; i++ {
		branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.row.RepositoryID, UserID: owner, Name: fmt.Sprintf("fifo-%d", i), TargetBookmark: fmt.Sprintf("scratch/presence-owner/fifo-%d", i), Status: "suspended", Kind: "vm"})
		require.NoError(t, err)
		reader, writer := io.Pipe()
		guest := &perfWakeRuntime{row: branch, state: workspaceapi.WorkspaceStopped, mode: "warm"}
		guest.owner = &terminalMemberRuntime{replacementRuntime: &replacementRuntime{repoID: f.row.RepositoryID}, terminal: &echoOwnerTerminal{reader: reader, writer: writer}, branch: branch, member: microsandbox.MemberIdentity{Login: "ben", UID: 20001, Active: true}}
		runtime.guests[branch.ID] = guest
		link, _ := presenceTestLink(t, &runtime.registry, branch.ID)
		require.NoError(t, link.Reconciled())
		branches = append(branches, branch)
	}
	handler := &routes.WorkspaceTerminalHandler{OwnerOnly: true}
	manager := handler.SharedTerminalSessions()
	defer manager.Close()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	if perBranch > 1 {
		cfg.RateLimit.TerminalOpenPerMin = 100
	} // same configured budget as the existing fifty-request matrix
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	handler.AllowedOrigins = cfg.Server.AllowedOrigins
	auth := services.NewAuthService(q, cfg.Auth, nil, nil)
	auth.Members = &services.Members{Pool: f.pool}
	auth.TerminalSubject = manager.OwnsSubject
	service := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)), services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceCredentialIssuer(auth), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"), services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy())))
	service.EnableMachineAdmission(readDisk)
	service.BindBranchTerminalHost(func(context.Context, db.Workspace, int64) error { return nil })
	provider := &installOwnerTerminals{queries: q, branches: service, registry: &runtime.registry}
	provider.Bind(manager)
	handler.Service, handler.OwnerTerminals = service, provider
	f.p.branches = service
	stack := services.NewMythicalService(f.pool, nil)
	stack.SetInstallParallel(capacity)
	stack.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(service))
	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	topics := &liveTopics{queries: q, todos: stack, jobs: store, presence: f.p, capacity: capacity}
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go stack.StartMachineQueueProjection(workerCtx)
	liveHandler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(workerCtx, nil), Origins: func() []string { return cfg.Server.AllowedOrigins }, Topics: topics.resolver}
	server.Config.Handler = parallelInstallRouter(cfg, q, f.pool, handler, routerExtras{Live: liveHandler})
	server.Start()
	defer server.Close()
	// All demand enters through the authenticated terminal door. Disk keeps
	// grants closed while the literal FIFO is established, including a duplicate.
	sessions := map[string][]string{}
	request := func(branchID, requestID string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/terminals", strings.NewReader(fmt.Sprintf(`{"branch":%q}`, branchID)))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", requestID)
		req.Header.Set("X-CSRF-Token", "csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: f.cookie})
		res, err := server.Client().Do(req)
		if err != nil {
			return nil, err
		}
		return res, nil
	}
	for i, branch := range branches {
		requestID := uuid.NewString()
		response, err := request(branch.ID, requestID)
		require.NoError(t, err)
		var session services.WorkspaceSessionResponse
		require.Equal(t, 202, response.StatusCode)
		require.NoError(t, json.NewDecoder(response.Body).Decode(&session))
		response.Body.Close()
		sessions[branch.ID] = append(sessions[branch.ID], session.ID)
		duplicate, err := request(branch.ID, requestID)
		require.NoError(t, err)
		var repeated services.WorkspaceSessionResponse
		require.Equal(t, 202, duplicate.StatusCode)
		require.NoError(t, json.NewDecoder(duplicate.Body).Decode(&repeated))
		duplicate.Body.Close()
		require.Equal(t, session.ID, repeated.ID)
		require.Eventually(t, func() bool {
			for _, row := range queue.AdmissionSnapshot() {
				if row.Holder == "workspace:"+branch.ID {
					return row.State == "waiting" && row.Position == i+1
				}
			}
			return false
		}, 5*time.Second, 10*time.Millisecond)
	}
	// Each holder already has a literal FIFO position. Add the remaining
	// unique HTTP requests concurrently across all ten branches while boots
	// remain unresolved; they must share the same one-slot machine per branch.
	type terminalResult struct {
		branch  string
		session services.WorkspaceSessionResponse
		status  int
		err     error
	}
	results := make(chan terminalResult, branchCount*(perBranch-1))
	for _, branch := range branches {
		for j := 1; j < perBranch; j++ {
			go func(id string) {
				result := terminalResult{branch: id}
				response, e := request(id, uuid.NewString())
				result.err = e
				if e == nil {
					result.status = response.StatusCode
					result.err = json.NewDecoder(response.Body).Decode(&result.session)
					response.Body.Close()
				}
				results <- result
			}(branch.ID)
		}
	}
	for i := 0; i < branchCount*(perBranch-1); i++ {
		result := <-results
		require.NoError(t, result.err)
		require.Equal(t, 202, result.status)
		require.NotEmpty(t, result.session.ID)
		sessions[result.branch] = append(sessions[result.branch], result.session.ID)
	}
	for _, branch := range branches {
		require.Len(t, sessions[branch.ID], perBranch)
	}
	require.Zero(t, queue.InUse())
	require.Empty(t, runtime.started)
	// Each mounted card receives the committed wake before the next observed
	// stop makes room. A stop acknowledgment alone cannot advance this queue.
	var sockets []*websocket.Conn
	var cursors []int64
	for i, branch := range branches {
		require.Eventually(t, func() bool {
			var state string
			var position int
			err := f.pool.QueryRow(ctx, `SELECT data->'branch'->'machine'->>'state',COALESCE((data->'branch'->'machine'->>'position')::int,0) FROM product_job_events WHERE principal_id=$1 ORDER BY sequence DESC LIMIT 1`, "branch:"+branch.ID+":machine").Scan(&state, &position)
			return err == nil && state == "waiting" && position == i+1
		}, 5*time.Second, 10*time.Millisecond)
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {cfg.Server.PublicURL}, "Cookie": {"smithers_session=" + f.cookie}}})
		require.NoError(t, err)
		defer conn.CloseNow()
		sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, branch.ID))
		for {
			frame := readPresenceFrame(t, conn)
			require.NotEqual(t, "err", frame.T)
			if frame.T != "snap" {
				continue
			}
			var card struct {
				Machine struct {
					State    string
					Position int
				}
			}
			require.NoError(t, json.Unmarshal(frame.Data, &card))
			if card.Machine.State != "waiting" || card.Machine.Position != i+1 {
				continue
			}
			cursors = append(cursors, *frame.Cursor)
			break
		}
		sockets = append(sockets, conn)
	}
	freeDisk.Store(72 << 30)
	for i, branch := range branches {
		select {
		case started := <-runtime.started:
			require.Equal(t, branch.ID, started)
		case <-time.After(5 * time.Second):
			t.Fatal("FIFO branch did not boot")
		}
		require.Equal(t, 1, queue.InUse())
		for {
			frame := readPresenceFrame(t, sockets[i])
			require.NotEqual(t, "err", frame.T)
			if frame.T != "delta" {
				continue
			}
			var event jobs.Event
			require.NoError(t, json.Unmarshal(frame.Data, &event))
			var fact struct {
				Branch struct {
					ID      string
					Machine struct{ State string }
				}
			}
			require.NoError(t, json.Unmarshal(event.Data, &fact))
			if fact.Branch.Machine.State != "awake" {
				continue
			}
			require.Equal(t, branch.ID, fact.Branch.ID)
			require.Greater(t, *frame.Cursor, cursors[i])
			break
		}
		require.Eventually(t, func() bool {
			var count, distinct int
			err := f.pool.QueryRow(ctx, `SELECT count(*),count(DISTINCT data->>'session') FROM product_job_events WHERE event_type='terminal.running' AND data->>'session'=ANY($1::text[])`, sessions[branch.ID]).Scan(&count, &distinct)
			return err == nil && count == perBranch && distinct == perBranch
		}, 5*time.Second, 10*time.Millisecond, "terminal guest accepted the real member credential")
		// Inject a delayed stop observation, keeping the granted slot throughout.
		for until := time.Now().Add(1100 * time.Millisecond); time.Now().Before(until); {
			require.Equal(t, 1, queue.InUse())
			running := 0
			for _, guest := range runtime.guests {
				guest.mu.Lock()
				if guest.state == workspaceapi.WorkspaceRunning {
					running++
				}
				guest.mu.Unlock()
			}
			require.Equal(t, 1, running, "the observed guest inventory never exceeds the slot limit")
			require.Empty(t, runtime.started)
			time.Sleep(20 * time.Millisecond)
		}
		guest := runtime.guests[branch.ID]
		guest.mu.Lock()
		guest.state = workspaceapi.WorkspaceStopped
		guest.mu.Unlock()
		queue.ConfirmAdmissionStop("workspace:"+branch.ID, false)
	}
	require.NoError(t, service.WaitForProvisioning(ctx))
	require.Zero(t, queue.InUse())
	require.Len(t, queue.AdmissionSnapshot(), branchCount)
	for _, row := range queue.AdmissionSnapshot() {
		require.Equal(t, "released", row.State)
	}
	manager.Close()
	require.NoError(t, service.WaitForProvisioning(ctx))
	require.Eventually(t, func() bool {
		var closed int
		return f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='terminal.closed'`).Scan(&closed) == nil && closed == branchCount*perBranch
	}, 10*time.Second, 10*time.Millisecond, "every terminal closes before its database is retired")
}
