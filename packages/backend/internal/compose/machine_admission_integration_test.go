package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Only guest transport/checkout is simulated. The HTTP start, lifecycle writes,
// registry authentication and admission queries all use the real product paths.
type admissionIdentityRuntime struct {
	*serviceControlRuntime
	poolIdentity func(string) error
}

func (r *admissionIdentityRuntime) WorkspaceMachineIdentity(context.Context, string) (string, error) {
	return "machine", nil
}
func (r *admissionIdentityRuntime) CreateWorkspace(_ context.Context, spec workspace.WorkspaceSpec) (workspace.Workspace, error) {
	return workspace.Workspace{ID: spec.ID, State: workspace.WorkspaceStopped}, nil
}
func (r *admissionIdentityRuntime) StopService(context.Context, string, string) error { return nil }
func (r *admissionIdentityRuntime) EnsureMachined(_ context.Context, id string) error {
	return r.poolIdentity(id)
}

func TestBranchStartAdmitsMachineIdentityPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	q := db.New(f.pool)
	ctx := t.Context()
	runtime := &admissionIdentityRuntime{serviceControlRuntime: &serviceControlRuntime{rows: map[string]db.Workspace{}}}
	svc := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(runtime), services.WithWorkspaceGitBaseURL("http://example.com"), services.WithWorkspaceInstallAuthorization(q), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)))
	// Use the real lane creator's default recipe. Pause at its bind callback so
	// the user-facing HTTP door below performs the first start synchronously.
	var row db.Workspace
	pause := errors.New("start through HTTP")
	_, err := services.NewWorkspaceMythicalLanes(svc).Create(ctx, db.Repository{ID: f.repoID, Name: "app"}, f.owner.Username, f.owner.ID, "admission", services.MythicalPlacement{}, func(id string) error {
		var err error
		row, err = q.GetWorkspace(ctx, id)
		if err != nil {
			return err
		}
		runtime.rows[id] = row
		var item pgtype.UUID
		if err := f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,workspace_id,owner_id) VALUES($1,'todo','proposed',$2,$3) RETURNING id`, f.repoID, id, f.owner.ID).Scan(&item); err != nil {
			return err
		}
		if _, _, err := q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: id, RepositoryID: f.repoID, ItemID: item, Name: "admission"}); err != nil {
			return err
		}
		return pause
	})
	require.ErrorIs(t, err, pause)
	runtime.poolIdentity = func(id string) error {
		current, err := q.GetWorkspace(ctx, id)
		if err != nil {
			return err
		}
		if current.VmID != "machine" {
			return fmt.Errorf("daemon identity mismatch: %s", current.VmID)
		}
		return nil
	}
	require.NoError(t, requireMachineAdmissionIsolation(runOptions{Options: Options{Workspace: runtime}}))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	sum := sha256.Sum256([]byte("admission-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: svc})
	start := func() {
		req := httptest.NewRequest("POST", fmt.Sprintf("%s/api/repos/%s/app/workspaces/%s/resume", cfg.Server.PublicURL, f.owner.Username, row.ID), nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: "admission-cookie"})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 200, out.Code, out.Body.String())
	}
	start()
	row, err = q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "machine", row.VmID)
	require.Equal(t, "container", row.Kind)
	require.Equal(t, "running", row.Status)
	require.Equal(t, 1, runtime.starts)
	// An older install's workspace-id binding is repaired before daemon admission.
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET vm_id=id,status='starting' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	start()
	row, err = q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "machine", row.VmID)
	_, _ = presenceHostBinding(t, f.pool, row, f.owner.ID)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','maya',20001) ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET permission='admin',unix_login='maya',unix_uid=20001`, f.repoID, f.owner.ID)
	require.NoError(t, err)
	var binding string
	require.NoError(t, f.pool.QueryRow(ctx, `UPDATE flow_runtime_host_bindings SET state='starting' WHERE workspace_id=$1 RETURNING id`, row.ID).Scan(&binding))
	registry := new(machined.Registry)
	link, _ := presenceTestLink(t, registry, row.ID)
	host := newMachineHost(f.pool, nil)
	host.registry = registry
	roster := machineRoster{pool: f.pool}
	member := microsandbox.MemberIdentity{Login: "maya", UID: 20001, Active: true}
	for index, tc := range []struct {
		name, kind, machine string
		allowed             bool
	}{
		{"started container", row.Kind, row.VmID, true}, {"nixos", "vm", row.VmID, true},
		{"workspace identity", row.Kind, row.ID, false}, {"desktop", "desktop", row.VmID, false}, {"agent", "agent", row.VmID, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.pool.Exec(ctx, `UPDATE workspaces SET kind=$2,vm_id=$3 WHERE id=$1`, row.ID, tc.kind, tc.machine)
			require.NoError(t, err)
			check := func(err error) {
				if tc.allowed {
					require.NoError(t, err)
				} else {
					require.Error(t, err)
				}
			}
			_, err = host.commitAgentActor(ctx, row.ID, link.Machine(), binding)
			check(err)
			called := false
			err = host.admitAgent(ctx, row.ID, binding, func(context.Context) error { called = true; return nil })
			check(err)
			require.Equal(t, tc.allowed, called)
			check(host.Record(ctx, row.ID, link.BootID(), uint32(index+1), machined.SessionUser{Login: "agent", UID: 19999}, "agent:"+binding))
			_, err = roster.commitMemberActor(ctx, row.ID, link.Machine(), member, "terminal")
			check(err)
			tx, err := f.pool.Begin(ctx)
			require.NoError(t, err)
			_, err = machined.RecordActorInTx(ctx, tx, row.ID, link.Machine(), machined.ActorIdentity{Kind: "person", MemberID: f.owner.ID, Via: "web"})
			check(err)
			require.NoError(t, tx.Rollback(ctx))
		})
	}
}

func TestInstallMachineAdmissionIsolation(t *testing.T) {
	for _, level := range []workspace.IsolationLevel{workspace.IsolationSandboxed, workspace.IsolationTrustedProcess, "unknown"} {
		for _, allow := range []bool{false, true} {
			options := runOptions{Options: Options{Workspace: isolatedRuntime{isolation: level}}}
			options.FlowHostConfig.AllowTrustedProcessForTests = allow
			err := requireMachineAdmissionIsolation(options)
			if level == workspace.IsolationSandboxed || level == workspace.IsolationTrustedProcess && allow {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, "sandboxed")
			}
		}
	}
	require.Error(t, requireMachineAdmissionIsolation(runOptions{}))
	// Exercise the installed server composition, not just the predicate. Refusal
	// occurs even with no flow registry, before config/database/server startup.
	options := runOptions{Options: Options{Workspace: isolatedRuntime{isolation: workspace.IsolationTrustedProcess}, Machined: new(machined.Registry)}}
	require.ErrorContains(t, runWithOptions(t.Context(), nil, io.Discard, io.Discard, options), "machine admission requires a sandboxed")
}
