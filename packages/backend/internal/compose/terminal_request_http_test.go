package compose

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The actual composed router and database persist the request. An unresolved
// guest inspection tests instant admission independently of root approval.
type requestHTTPRuntime struct {
	workspaceapi.WorkspaceRuntime
	entered, release chan struct{}
	once             sync.Once
	registry         machined.Registry
}

func (r *requestHTTPRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{Terminal: true}
}
func (r *requestHTTPRuntime) MachinedRegistry() *machined.Registry { return &r.registry }
func (r *requestHTTPRuntime) InspectWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
		return workspaceapi.Workspace{}, errors.New("supplemental guest refusal")
	case <-ctx.Done():
		return workspaceapi.Workspace{}, ctx.Err()
	}
}
func TestTerminalRequestThroughComposedInstallHTTP(t *testing.T) {
	testTerminalRequestHTTP(t, false)
}

// This host receipt proves HTTP validation before the asynchronous launch door.
// Real broker uid/drop, descriptors and token-path races require the mini.
func TestTerminalRootInputsValidatedBeforeUse(t *testing.T) {
	testTerminalRequestHTTP(t, true)
}

func testTerminalRequestHTTP(t *testing.T, rootInputs bool) {
	t.Helper()
	f := presenceInstall(t)
	q := db.New(f.pool)
	owner, err := q.GetBranchMachineOwner(t.Context())
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.row.RepositoryID, UserID: owner, Name: "terminal", TargetBookmark: "scratch/presence-owner/terminal", Status: "running", Kind: "vm"})
	require.NoError(t, err)
	runtime := &requestHTTPRuntime{entered: make(chan struct{}), release: make(chan struct{})}
	service := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)))
	service.BindBranchTerminalHost(func(context.Context, db.Workspace, int64) error { return nil })
	service.BindOwnerTerminalOpen(func(ctx context.Context, id, branch string, repo, member int64) error {
		_, err := runtime.InspectWorkspace(ctx, branch)
		return err
	})
	released := false
	defer func() {
		if !released {
			close(runtime.release)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		require.NoError(t, service.WaitForProvisioning(ctx))
	}()
	cfg := testConfigAllFlagsOn()
	// Keep this validation matrix below the fixture rate budget.
	cfg.RateLimit.TerminalOpenPerMin = 100
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	handler := &routes.WorkspaceTerminalHandler{Service: service, AllowedOrigins: cfg.Server.AllowedOrigins}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q}, conformanceServices{pool: f.pool, terminal: handler})
	request := uuid.NewString()
	call := func(body string, authenticated bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, cfg.Server.PublicURL+"/api/terminals", strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Idempotency-Key", request)
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		if authenticated {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: f.cookie})
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	if rootInputs {
		for _, field := range []string{
			`"owner":0`, `"member":0`, `"uid":0`, `"gid":0`,
			`"login":"root"`, `"session":"foreign-session"`,
			`"argv":["/workspace/root-canary"]`, `"shell":"/workspace/root-canary"`,
			`"environment":{"LD_PRELOAD":"/workspace/root-canary.so"}`,
			`"cwd":"/root"`, `"token_file":"/run/smithers/20002/token/sessions/foreign/token"`,
			`"cols":0`, `"rows":0`, `"run":"foreign-run"`,
		} {
			t.Run(field, func(t *testing.T) {
				out := call(`{"branch":"`+branch.ID+`",`+field+`}`, true)
				require.Equal(t, 400, out.Code, out.Body.String())
			})
		}
		for _, body := range []string{
			`{}`, `{"branch":null}`, `{"branch":0}`, `{"branch":""}`,
			`{"branch":"` + branch.ID + `"} {"uid":0}`,
			`{"branch":"` + strings.Repeat("b", 4096) + `"}`,
		} {
			out := call(body, true)
			require.Equal(t, 400, out.Code, out.Body.String())
		}
		select {
		case <-runtime.entered:
			t.Fatal("invalid root inputs reached the launch provider")
		default:
		}
		var tokens int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens`).Scan(&tokens))
		require.Zero(t, tokens)
	}

	body := `{"branch":"` + branch.ID + `"}`
	require.Equal(t, 401, call(body, false).Code)
	require.Equal(t, 400, call(`{"branch":"`+branch.ID+`","owner":0}`, true).Code)
	first := call(body, true)
	require.Equal(t, 202, first.Code, first.Body.String())
	var receipt services.WorkspaceSessionResponse
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &receipt))
	require.Equal(t, branch.ID, receipt.WorkspaceID)
	select {
	case <-runtime.entered:
	case <-time.After(time.Second):
		t.Fatal("guest effect did not start")
	}
	second := call(body, true)
	require.Equal(t, 202, second.Code, second.Body.String())
	var duplicate services.WorkspaceSessionResponse
	require.NoError(t, json.Unmarshal(second.Body.Bytes(), &duplicate))
	require.Equal(t, receipt.ID, duplicate.ID)
	require.Equal(t, f.user.ID, receipt.UserID)
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_sessions WHERE workspace_id=$1`, branch.ID).Scan(&count))
	require.Zero(t, count, "owner terminals do not create workspace session rows")
	close(runtime.release)
	released = true
	require.NoError(t, service.WaitForProvisioning(t.Context()))
	failed := call(body, true)
	require.Equal(t, 202, failed.Code, failed.Body.String())
	var failure services.WorkspaceSessionResponse
	require.NoError(t, json.Unmarshal(failed.Body.Bytes(), &failure))
	require.Equal(t, receipt.ID, failure.ID)
	require.Equal(t, "failed", failure.Status, "launch failure remains visible on the durable receipt")
	request = uuid.NewString()
	retry := call(body, true)
	require.Equal(t, 202, retry.Code, retry.Body.String())
	var retried services.WorkspaceSessionResponse
	require.NoError(t, json.Unmarshal(retry.Body.Bytes(), &retried))
	require.NotEqual(t, receipt.ID, retried.ID)
	require.NoError(t, service.WaitForProvisioning(t.Context()))
}
