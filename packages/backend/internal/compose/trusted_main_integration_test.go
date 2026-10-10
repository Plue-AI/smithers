package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Linux cannot qualify a real VM. Only the machine allocation/verification
// port is replaced; admission, identity, stored predicate, splitter and router
// use production code and a real PostgreSQL database.
type trustedMainMachineFixture struct {
	creates             int
	retires             int
	retired             string
	failRetire          bool
	workspace, revision string
}

func (m *trustedMainMachineFixture) CreateWorkspace(context.Context, services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
	return services.WorkspaceResponse{}, fmt.Errorf("test refuses branch reuse")
}
func (m *trustedMainMachineFixture) PrepareMainMachine(_ context.Context, id string, _, _ int64, revision string) error {
	m.creates++
	m.workspace = id
	m.revision = revision
	return nil
}
func (m *trustedMainMachineFixture) RetireMainMachine(_ context.Context, id string) error {
	m.retires++
	m.retired = id
	if m.failRetire {
		m.failRetire = false
		return fmt.Errorf("delete reply lost")
	}
	return nil
}

func TestTrustedMainManualFlowThroughInstallRouter(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "trig-owner", LowerUsername: "trig-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo := ciTestRepo(t, pool, owner.ID, "app")
	setting := []byte(fmt.Sprintf(`{"owner_login":"trig-owner","repository_name":"app","repository_id":%d}`, repo))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: setting}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(string(setting[:len(setting)-1]) + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`)}))
	codec, err := webhook.NewSecretCodec("trusted-main-test-key")
	require.NoError(t, err)
	secretService := services.NewSecretService(q, codec)
	yes := true
	_, err = secretService.SetSecret(ctx, &owner, owner.Username, "app", "DEPLOY_KEY", "main-sentinel", &yes, nil, nil)
	require.NoError(t, err)
	_, err = secretService.SetSecret(ctx, &owner, owner.Username, "app", "CANARY_TOKEN", "all-sentinel", nil, nil, nil)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatch, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, fmt.Errorf("VM unavailable in Linux test")
	})})
	require.NoError(t, err)
	machine := &trustedMainMachineFixture{}
	invoked := services.NewInvokedFlowService(pool, services.NewRepositoryJobService(q, nil, pool), machine)
	invoked.SetFlowSourceReader(invokeTestSources{})
	invoked.SetFlowDispatcher(dispatch)
	invoked.SetSecretInjector(services.NewSecretInjector(q, codec))
	api := services.NewWorkflowAPIService(q, services.NewWorkflowRunService(q), services.WithWorkflowAPIFlowInvoker(invoked))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := buildWorkflowTriggerRouter(q, pool, &routes.WorkflowHandler{Service: api}, cfg)
	cookie := "trusted-main-owner-cookie"
	sum := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	req := httptest.NewRequest("POST", "http://example.com/api/repos/trig-owner/app/invoke", strings.NewReader(`{"flow":"ci","input":{"trigger":"schedule","mainTrusted":true}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://example.com")
	req.Header.Set("X-CSRF-Token", "csrf")
	req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
	out := httptest.NewRecorder()
	router.ServeHTTP(out, req)
	require.Equal(t, 201, out.Code, out.Body.String())
	require.Zero(t, machine.creates, "admission must precede VM work")
	var response struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(out.Body.Bytes(), &response))
	require.Positive(t, response.ID)
	target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID), BindingKind: "workflow-invoke", BindingID: fmt.Sprint(response.ID)}
	authority, err := invoked.ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err)
	require.Equal(t, machine.workspace, authority.WorkspaceID)
	require.Equal(t, strings.Repeat("c", 40), authority.SourceRevision)
	env, err := invoked.FlowHostEnvironment(ctx, authority)
	require.NoError(t, err)
	require.Equal(t, "main-sentinel", env["DEPLOY_KEY"])
	require.Equal(t, "all-sentinel", env["CANARY_TOKEN"])
	require.NotContains(t, out.Body.String(), "main-sentinel")
	require.NotContains(t, out.Body.String(), "all-sentinel")
	var sealed string
	require.NoError(t, pool.QueryRow(ctx, `SELECT launch_redaction FROM workflow_run_flow_invocations WHERE workflow_run_id=$1`, response.ID).Scan(&sealed))
	require.NotEmpty(t, sealed)
	require.NotContains(t, sealed, "main-sentinel")
	for _, mutation := range []string{"wrong source", "shares", "item", "expired session", "suspended owner", "agent", "push", "schedule", "empty ref", "scratch", "member"} {
		t.Run(mutation, func(t *testing.T) {
			switch mutation {
			case "wrong source":
				_, err = pool.Exec(ctx, `UPDATE workflow_run_flow_invocations SET source_revision=$2 WHERE workflow_run_id=$1`, response.ID, strings.Repeat("d", 40))
				defer pool.Exec(ctx, `UPDATE workflow_run_flow_invocations SET source_revision=$2 WHERE workflow_run_id=$1`, response.ID, strings.Repeat("c", 40))
			case "expired session":
				_, err = pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1`, owner.ID)
				defer pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE user_id=$1`, owner.ID)
			case "suspended owner":
				_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, owner.ID)
				defer pool.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, owner.ID)
			case "agent", "push", "schedule":
				_, err = pool.Exec(ctx, `UPDATE workflow_runs SET trigger_event=$2 WHERE id=$1`, response.ID, mutation)
				defer pool.Exec(ctx, `UPDATE workflow_runs SET trigger_event='invoke' WHERE id=$1`, response.ID)
			case "empty ref", "scratch":
				ref := ""
				if mutation == "scratch" {
					ref = "scratch/alice/work"
				}
				_, err = pool.Exec(ctx, `UPDATE workflow_runs SET trigger_ref=$2 WHERE id=$1`, response.ID, ref)
				defer pool.Exec(ctx, `UPDATE workflow_runs SET trigger_ref='main' WHERE id=$1`, response.ID)
			case "shares": // A read share is also refused for a background machine.
				_, err = pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$2,'read')`, authority.WorkspaceID, owner.ID)
				defer pool.Exec(ctx, `DELETE FROM workspace_shares WHERE workspace_id=$1`, authority.WorkspaceID)
			case "item":
				_, err = pool.Exec(ctx, `UPDATE workflow_run_flow_invocations SET background_workspace_id=NULL WHERE workflow_run_id=$1`, response.ID)
				defer pool.Exec(ctx, `UPDATE workflow_run_flow_invocations SET background_workspace_id=$2::uuid WHERE workflow_run_id=$1`, response.ID, authority.WorkspaceID)
			case "member":
				_, err = pool.Exec(ctx, `DELETE FROM self_host_owners WHERE user_id=$1`, owner.ID)
				defer pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
			}
			require.NoError(t, err)
			trusted, err := services.TrustedMainMachine(ctx, pool, q, authority.WorkspaceID)
			require.NoError(t, err)
			require.False(t, trusted)
			env, err := invoked.FlowHostEnvironment(ctx, authority)
			require.NoError(t, err)
			require.NotContains(t, env, "DEPLOY_KEY")
		})
	}

	t.Run("background launch has no landing authority", func(t *testing.T) {
		transport := &trustedMainLaunchTransport{revision: strings.Repeat("c", 40)}
		// A nil box preparer makes any accidental landing-credential path fail.
		launcher := &boxHostLauncher{Launcher: transport, SourceResolver: transport, targets: invoked}
		_, err := launcher.StartFlowHost(ctx, flowhost.HostLaunch{Authority: authority})
		require.NoError(t, err)
		require.Equal(t, 1, transport.starts)
		require.Equal(t, map[string]string{"CANARY_TOKEN": "all-sentinel", "DEPLOY_KEY": "main-sentinel"}, transport.environment)
		transport.revision = strings.Repeat("d", 40)
		_, err = launcher.StartFlowHost(ctx, flowhost.HostLaunch{Authority: authority})
		require.ErrorContains(t, err, "source changed")
		require.Equal(t, 1, transport.starts)
		other := authority
		other.RepositoryID = repo + 100
		_, err = invoked.FlowHostEnvironment(ctx, other)
		require.Error(t, err)
	})
	ownerWorkspace := authority.WorkspaceID
	for _, cell := range []struct {
		name, permission string
		trusted          bool
	}{{"maintainer", "admin", true}, {"member", "write", false}} {
		t.Run("HTTP "+cell.name, func(t *testing.T) {
			person, err := q.CreateUser(ctx, db.CreateUserParams{Username: cell.name, LowerUsername: cell.name, DisplayName: cell.name})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo, person.ID, cell.permission)
			require.NoError(t, err)
			cookie := "trusted-main-" + cell.name
			sum := sha256.Sum256([]byte(cookie))
			_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.ID, Username: person.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			req := httptest.NewRequest("POST", "http://example.com/api/repos/trig-owner/app/invoke", strings.NewReader(`{"flow":"ci"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://example.com")
			req.Header.Set("X-CSRF-Token", "csrf")
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			before := machine.creates
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, 201, out.Code, out.Body.String())
			require.Equal(t, before, machine.creates)
			var response struct {
				ID int64 `json:"id"`
			}
			require.NoError(t, json.Unmarshal(out.Body.Bytes(), &response))
			var manual bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT manual_credential IS NOT NULL FROM workflow_run_flow_invocations WHERE workflow_run_id=$1`, response.ID).Scan(&manual))
			require.Equal(t, cell.trusted, manual)
			if cell.trusted {
				target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", person.ID), BindingKind: "workflow-invoke", BindingID: fmt.Sprint(response.ID)}
				authority, err := invoked.ResolveFlowHostTarget(ctx, target)
				require.NoError(t, err)
				require.NotEqual(t, authority.WorkspaceID, ownerWorkspace)
				env, err := invoked.FlowHostEnvironment(ctx, authority)
				require.NoError(t, err)
				require.Equal(t, "main-sentinel", env["DEPLOY_KEY"])
			}
		})
	}

	t.Run("main logs redact rotated values and retirement retries", func(t *testing.T) {
		_, err := secretService.SetSecret(ctx, &owner, owner.Username, "app", "DEPLOY_KEY", "rotated-main-sentinel", nil, nil, nil)
		require.NoError(t, err)
		var operation string
		require.NoError(t, pool.QueryRow(ctx, `SELECT operation_id FROM workflow_run_flow_invocations WHERE workflow_run_id=$1`, response.ID).Scan(&operation))
		projection := []byte(fmt.Sprintf(`{"kind":"workflow-invoke","workflowRunId":%d}`, response.ID))
		update := flowdispatch.ProjectionUpdate{OperationID: operation, Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: "ci", Projection: projection, Cursor: "one"}, Events: []flowruntime.FlowRuntimeEvent{{Kind: "log", Payload: []byte(`{"text":"main-sentinel all-sentinel rotated-main-sentinel"}`)}}}
		require.NoError(t, invoked.ProjectFlowRuntime(ctx, update))
		logs, err := api.ListWorkflowLogsSince(ctx, response.ID, 0, 100)
		require.NoError(t, err)
		require.NotEmpty(t, logs)
		for _, log := range logs {
			require.NotContains(t, log.Entry, "main-sentinel")
			require.NotContains(t, log.Entry, "all-sentinel")
		}
		update.Events = nil
		update.State = jobs.StateCancelled
		machine.failRetire = true
		require.ErrorContains(t, invoked.ProjectFlowRuntime(ctx, update), "delete reply lost")
		require.Equal(t, 1, machine.retires)
		require.Equal(t, ownerWorkspace, machine.retired)
		require.NoError(t, invoked.ProjectFlowRuntime(ctx, update))
		require.Equal(t, 2, machine.retires)
		creates := machine.creates
		_, err = invoked.ResolveFlowHostTarget(ctx, target)
		require.Error(t, err)
		require.Equal(t, creates, machine.creates, "terminal replay must not allocate")
	})

}

type trustedMainLaunchTransport struct {
	revision    string
	starts      int
	environment map[string]string
}

func (l *trustedMainLaunchTransport) InspectFlowHost(context.Context, flowhost.HostLaunch) (flowhost.Connection, error) {
	return flowhost.Connection{}, flowhost.ErrHostNotRunning
}
func (l *trustedMainLaunchTransport) ResolveFlowHostSource(context.Context, flowhost.Authority) (string, error) {
	return l.revision, nil
}
func (l *trustedMainLaunchTransport) ReleaseFailedFlowHostMachine(context.Context, flowhost.Binding) error {
	return nil
}
func (l *trustedMainLaunchTransport) StartFlowHost(_ context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	l.starts++
	l.environment = launch.Environment
	return flowhost.Connection{Endpoint: "http://fixture"}, nil
}
