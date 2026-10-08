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
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Linux has no guest runtime. This boundary controls guest transport and host
// readiness, while admission, auth, durable status and observation are real.
// Native runtime classification is checked independently in microsandbox.
// It is not lifecycle/security qualification or a C-PERF receipt.
type perfWakeRuntime struct {
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
	for _, mode := range []string{"warm", "missing head", "failed boot"} {
		t.Run(mode, func(t *testing.T) {
			f := presenceInstall(t)
			q := db.New(f.pool)
			owner, err := q.GetBranchMachineOwner(t.Context())
			require.NoError(t, err)
			branch, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.row.RepositoryID, UserID: owner, Name: "wake", TargetBookmark: "scratch/presence-owner/wake", Status: "suspended", Kind: "vm"})
			require.NoError(t, err)
			runtime := &perfWakeRuntime{row: branch, state: workspaceapi.WorkspaceStopped, mode: mode, entered: make(chan struct{}), release: make(chan struct{})}
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
			service := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)), services.WithWorkspaceCredentialIssuer(auth), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"), services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy())))
			service.EnableMachineAdmission(func(context.Context) (int64, error) { return 140 << 30, nil })
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
			cfg.Server.PublicURL = "http://localhost:4000"
			cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
			handler.AllowedOrigins = cfg.Server.AllowedOrigins
			router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q}, conformanceServices{pool: f.pool, terminal: handler})
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
			} else {
				require.Error(t, err)
				require.Contains(t, string(output), "cold or failed wake")
			}
		})
	}
}
