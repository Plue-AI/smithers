package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// memberStartRuntime runs during, once, at the point of a member's machine
// start where the real runtime has provisioned the roster and waits for the
// VM's daemon: the start's held transaction is open.
type memberStartRuntime struct {
	*admissionIdentityRuntime
	during  func(context.Context, string) error
	deleted []string
}

func (r *memberStartRuntime) EnsureMachined(ctx context.Context, id string) error {
	if during := r.during; during != nil {
		r.during = nil
		return during(ctx, id)
	}
	return nil
}

func (r *memberStartRuntime) DeleteWorkspace(_ context.Context, id string) error {
	r.deleted = append(r.deleted, id)
	return nil
}

// memberStart is a branch machine whose first start a member (the install
// owner, not the machine service) makes through the HTTP resume door, so the
// start runs on one held transaction (services.commitWorkspaceMutation).
type memberStart struct {
	f       *landingGateFixture
	bob     db.User
	row     db.Workspace
	runtime *memberStartRuntime
	start   func() *httptest.ResponseRecorder
}

func newMemberStart(t *testing.T) memberStart {
	t.Helper()
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	q := db.New(f.pool)
	ctx := t.Context()
	bob, err := q.CreateUser(ctx, db.CreateUserParams{Username: "bob-member", LowerUsername: "bob-member", DisplayName: "Bob"})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','bob',20102)`, f.repoID, bob.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE collaborators SET unix_login='m'||id::text,unix_uid=20200+id WHERE repository_id=$1 AND unix_login IS NULL`, f.repoID)
	require.NoError(t, err)

	runtime := &memberStartRuntime{admissionIdentityRuntime: &admissionIdentityRuntime{serviceControlRuntime: &serviceControlRuntime{rows: map[string]db.Workspace{}}}}
	svc := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(runtime), services.WithWorkspaceGitBaseURL("http://example.com"), services.WithWorkspaceInstallAuthorization(q), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)))
	var row db.Workspace
	pause := errors.New("start through HTTP")
	_, err = services.NewWorkspaceMythicalLanes(svc).Create(ctx, db.Repository{ID: f.repoID, Name: "app"}, f.owner.Username, f.owner.ID, "member-writes", services.MythicalPlacement{}, func(id string) error {
		var err error
		if row, err = q.GetWorkspace(ctx, id); err != nil {
			return err
		}
		runtime.rows[id] = row
		var item pgtype.UUID
		if err := f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,workspace_id,owner_id) VALUES($1,'todo','proposed',$2,$3) RETURNING id`, f.repoID, id, f.owner.ID).Scan(&item); err != nil {
			return err
		}
		if _, _, err := q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: id, RepositoryID: f.repoID, ItemID: item, Name: "member-writes"}); err != nil {
			return err
		}
		return pause
	})
	require.ErrorIs(t, err, pause)
	require.NoError(t, requireMachineAdmissionIsolation(runOptions{Options: Options{Workspace: runtime}}))

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	sum := sha256.Sum256([]byte("member-writes-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: svc})
	start := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", fmt.Sprintf("%s/api/repos/%s/app/workspaces/%s/resume", cfg.Server.PublicURL, f.owner.Username, row.ID), nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: "member-writes-cookie"})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out
	}
	return memberStart{f: f, bob: bob, row: row, runtime: runtime, start: start}
}

// within runs write with limit and returns its error.
func within(ctx context.Context, limit time.Duration, write func(context.Context) error) error {
	bounded, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	return write(bounded)
}

// #3759: a member's machine start holds one transaction across the VM boot.
// A member's view-state save and a sign-in's last-login write must not wait
// on it; removing a member and every roster change through the owner lock
// still wait. A suspension, demotion or sign-in refusal that lands during the
// start fails the start closed.
func TestMemberMachineStartLetsMemberWritesThroughPostgres(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change string
		code   int
	}{
		{"no roster change", "", http.StatusOK},
		{"member suspended during the start", `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, http.StatusConflict},
		{"member demoted during the start", `UPDATE collaborators SET permission='read' WHERE user_id=$1`, http.StatusConflict},
		{"member's sign-in refused during the start", `UPDATE users SET prohibit_login=true WHERE id=$1`, http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newMemberStart(t)
			ctx, pool := t.Context(), m.f.pool
			roster := machineRoster{pool: pool}
			var provisioned []microsandbox.MemberIdentity
			var viewState, lastLogin, removal, rosterChange, change error
			m.runtime.during = func(held context.Context, id string) error {
				// The roster as the real runtime provisions it, on the held start.
				if err := roster.withProvisioningRoster(held, id, func(_ context.Context, members []microsandbox.MemberIdentity) error {
					provisioned = members
					return nil
				}); err != nil {
					return err
				}
				viewState = within(ctx, time.Second, func(c context.Context) error {
					_, err := pool.Exec(c, `UPDATE collaborators SET view_state=jsonb_set(coalesce(view_state,'{}'::jsonb),'{main}','{"toasts_hidden":true}'::jsonb,true) WHERE repository_id=$1 AND user_id=$2`, m.f.repoID, m.bob.ID)
					return err
				})
				lastLogin = within(ctx, time.Second, func(c context.Context) error { return db.New(pool).UpdateUserLastLogin(c, m.bob.ID) })
				removal = within(ctx, 500*time.Millisecond, func(c context.Context) error {
					_, err := pool.Exec(c, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, m.f.repoID, m.bob.ID)
					return err
				})
				rosterChange = within(ctx, 500*time.Millisecond, func(c context.Context) error {
					_, err := pool.Exec(c, `SELECT user_id FROM self_host_owners FOR UPDATE`)
					return err
				})
				if tc.change != "" {
					change = within(ctx, time.Second, func(c context.Context) error {
						_, err := pool.Exec(c, tc.change, m.bob.ID)
						return err
					})
				}
				return nil
			}
			out := m.start()

			require.Contains(t, provisioned, microsandbox.MemberIdentity{Login: "bob", UID: 20102, Active: true})
			require.NoError(t, viewState, "a view-state save waited on the machine start")
			require.NoError(t, lastLogin, "a sign-in's last-login write waited on the machine start")
			require.ErrorIs(t, removal, context.DeadlineExceeded, "removing a member must wait for the start")
			require.ErrorIs(t, rosterChange, context.DeadlineExceeded, "a roster change through the owner lock must wait for the start")
			require.NoError(t, change, "the change itself does not wait for the start")
			require.Equal(t, tc.code, out.Code, out.Body.String())
			require.Empty(t, m.runtime.deleted)
		})
	}
}

// #3759: the start's status writes apply only to a live workspace row. A
// workspace soft-deleted while its start was admitted ends that start, and the
// start reclaims the VM it booted: nothing else owns it.
func TestMachineStartReclaimsAWorkspaceDeletedDuringAdmissionPostgres(t *testing.T) {
	m := newMemberStart(t)
	ctx, pool := t.Context(), m.f.pool
	var deleted error
	m.runtime.during = func(_ context.Context, id string) error {
		deleted = within(ctx, time.Second, func(c context.Context) error {
			_, err := pool.Exec(c, `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, id)
			return err
		})
		return nil
	}
	out := m.start()
	require.NoError(t, deleted, "the soft delete does not wait for the start")
	require.Equal(t, http.StatusNotFound, out.Code, out.Body.String())
	require.Equal(t, []string{m.row.ID}, m.runtime.deleted, "the start reclaims the VM of a deleted workspace")
	var status string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, m.row.ID).Scan(&status))
	require.NotEqual(t, "running", status)
}
