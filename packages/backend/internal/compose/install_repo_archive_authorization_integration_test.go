package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type archiveAdmissionProbe struct {
	routes.RepoRouteService
	before  func()
	replace string
	actor   *db.User
}

func (p *archiveAdmissionProbe) invoke(ctx context.Context, actor *db.User, owner, name string, archived bool) (db.Repository, error) {
	if p.before != nil {
		p.before()
	}
	if p.actor != nil {
		actor = p.actor
	}
	if p.replace == "repository" {
		name = "different"
	}
	if p.replace == "operation" {
		archived = !archived
	}
	if archived {
		return p.RepoRouteService.ArchiveRepo(ctx, actor, owner, name)
	}
	return p.RepoRouteService.UnarchiveRepo(ctx, actor, owner, name)
}
func (p *archiveAdmissionProbe) ArchiveRepo(ctx context.Context, actor *db.User, owner, name string) (db.Repository, error) {
	return p.invoke(ctx, actor, owner, name, true)
}
func (p *archiveAdmissionProbe) UnarchiveRepo(ctx context.Context, actor *db.User, owner, name string) (db.Repository, error) {
	return p.invoke(ctx, actor, owner, name, false)
}
func TestInstallRepoArchiveAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName, cfg.Auth.SessionRefreshWindow = "selfhost", "session", "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewProductRepoServiceWithPool(q, nil, pool, services.WithRepoInstallAuthorization(pool))
	probe := &archiveAdmissionProbe{RepoRouteService: service}
	router := buildRouterCompat(cfg, q, pool,
		&routes.RepoHandler{Service: probe}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{Service: services.NewIssueService(f.q)},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)

	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerHash := session(f.owner, "archive-owner")
	session(f.other, "archive-member")
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "archive-maintainer", LowerUsername: "archive-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "archive-maintainer")
	app := f.token(f.owner, "archive-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	external := f.token(f.owner, "archive-external", "write:repository,via:codex", true)
	run := f.token(f.owner, "archive-run", "write:repository", true)
	machine := f.token(f.owner, "archive-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	limited := f.token(f.owner, "archive-limited", "read:repository,via:codex", true)
	request := func(ctx context.Context, action, cookie, token string) *http.Request {
		req := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/repos/gate-owner/app/"+action, strings.NewReader(`{}`)).WithContext(ctx)
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "archive-csrf"})
			req.Header.Set("X-CSRF-Token", "archive-csrf")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return req
	}
	call := func(t *testing.T, action, cookie, token string, status int) *httptest.ResponseRecorder {
		t.Helper()
		commands := []string{}
		ctx := services.WithAuthorizationObserver(f.ctx, func(command string) { commands = append(commands, command) })
		out := httptest.NewRecorder()
		router.ServeHTTP(out, request(ctx, action, cookie, token))
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"repo." + action}, commands)
		return out
	}
	state := func(want bool) {
		row, err := q.GetRepoByID(f.ctx, f.repoID)
		require.NoError(t, err)
		require.Equal(t, want, row.IsArchived)
		require.Equal(t, want, row.ArchivedAt.Valid)
	}
	for _, action := range []string{"archive", "unarchive"} {
		t.Run(action, func(t *testing.T) {
			before := action == "unarchive"
			_, err = f.pool.Exec(f.ctx, `UPDATE repositories SET is_archived=$2,archived_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1`, f.repoID, before)
			require.NoError(t, err)
			for _, a := range []struct {
				name, cookie, token, code string
				status                    int
			}{
				{"member", "archive-member", "", "permission", 403}, {"maintainer", "archive-maintainer", "", "permission", 403}, {"app", "", app, "never", 403}, {"external", "", external, "never", 403}, {"run", "", run, "permission", 403}, {"machine", "", machine, "permission", 403}, {"scope", "", limited, "permission", 403}, {"anonymous", "", "", "unauthenticated", 401},
			} {
				t.Run(a.name, func(t *testing.T) {
					out := call(t, action, a.cookie, a.token, a.status)
					require.Contains(t, out.Body.String(), `"code":"`+a.code+`"`)
					state(before)
				})
			}
			for _, replace := range []string{"operation", "repository", "actor"} {
				t.Run(replace, func(t *testing.T) {
					probe.replace = replace
					if replace == "actor" {
						probe.actor = &f.other
					}
					defer func() { probe.replace = ""; probe.actor = nil }()
					call(t, action, "archive-owner", "", 403)
					state(before)
				})
			}
			t.Run("expiry after admission", func(t *testing.T) {
				probe.before = func() {
					_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
					require.NoError(t, err)
				}
				defer func() {
					probe.before = nil
					_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
					require.NoError(t, err)
				}()
				call(t, action, "archive-owner", "", 401)
				state(before)
			})
			t.Run("owner and replay", func(t *testing.T) {
				call(t, action, "archive-owner", "", 200)
				state(!before)
				first, err := q.GetRepoByID(f.ctx, f.repoID)
				require.NoError(t, err)
				call(t, action, "archive-owner", "", 200)
				after, err := q.GetRepoByID(f.ctx, f.repoID)
				require.NoError(t, err)
				require.Equal(t, first.ArchivedAt, after.ArchivedAt)
				require.Equal(t, first.UpdatedAt, after.UpdatedAt)
			})
		})
	}
	t.Run("expiry during write rolls back", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(f.ctx, 12*time.Second)
		defer cancel()
		_, err := f.pool.Exec(ctx, `CREATE FUNCTION delay_archive_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('fr4b_archive_expiry',0)); RETURN NEW; END $$`)
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `CREATE TRIGGER delay_archive_write BEFORE UPDATE OF is_archived ON repositories FOR EACH ROW EXECUTE FUNCTION delay_archive_write()`)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `DROP TRIGGER delay_archive_write ON repositories; DROP FUNCTION delay_archive_write()`)
			require.NoError(t, err)
		}()
		held, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer held.Rollback(context.Background())
		_, err = held.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('fr4b_archive_expiry',0))`)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, ownerHash, deadline)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		commands := []string{}
		req := request(services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) }), "archive", "archive-owner", "")
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out := httptest.NewRecorder(); router.ServeHTTP(out, req); done <- out }()
		require.Eventually(t, func() bool {
			var count int
			err := f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE repositories%'`).Scan(&count)
			return err == nil && count == 1
		}, 3*time.Second, 10*time.Millisecond)
		timer := time.NewTimer(time.Until(deadline) + 25*time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.NoError(t, held.Commit(ctx))
		select {
		case out := <-done:
			require.Equal(t, 401, out.Code, out.Body.String())
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.Equal(t, []string{"repo.archive"}, commands)
		state(false)
	})
	t.Run("direct service requires credential and authorizes once", func(t *testing.T) {
		_, err := service.ArchiveRepo(f.ctx, &f.owner, "gate-owner", "app")
		var access *services.AccessError
		require.ErrorAs(t, err, &access)
		require.Equal(t, 401, access.Status)
		state(false)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		result, err := service.ArchiveRepo(ctx, &f.owner, "gate-owner", "app")
		require.NoError(t, err)
		require.True(t, result.IsArchived)
		require.Equal(t, []string{"repo.archive"}, commands)
		result, err = service.UnarchiveRepo(ctx, &f.owner, "gate-owner", "app")
		require.NoError(t, err)
		require.False(t, result.IsArchived)
		require.Equal(t, []string{"repo.archive", "repo.unarchive"}, commands)
	})
	// GitHub's PATCH {"archived": …} is the archive command, never a
	// settings update a member's or an agent's credential may make.
	t.Run("patch archived is the archive command", func(t *testing.T) {
		for _, tc := range []struct {
			name, body, cookie, token, command, code string
			status                                   int
			archived                                 bool
		}{
			{"member", `{"archived":true}`, "archive-member", "", "repo.archive", "permission", 403, false},
			{"app", `{"archived":true}`, "", app, "repo.archive", "never", 403, false},
			{"owner archives", `{"archived":true}`, "archive-owner", "", "repo.archive", "", 200, true},
			{"maintainer", `{"archived":false}`, "archive-maintainer", "", "repo.unarchive", "permission", 403, true},
			{"owner unarchives", `{"archived":false}`, "archive-owner", "", "repo.unarchive", "", 200, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				commands := []string{}
				ctx := services.WithAuthorizationObserver(f.ctx, func(command string) { commands = append(commands, command) })
				req := request(ctx, "", tc.cookie, tc.token)
				patch := httptest.NewRequest(http.MethodPatch, cfg.Server.PublicURL+"/api/repos/gate-owner/app", strings.NewReader(tc.body)).WithContext(ctx)
				patch.Header = req.Header
				out := httptest.NewRecorder()
				router.ServeHTTP(out, patch)
				require.Equal(t, tc.status, out.Code, out.Body.String())
				if tc.code != "" {
					require.Contains(t, out.Body.String(), `"code":"`+tc.code+`"`)
				}
				require.Equal(t, []string{tc.command}, commands)
				state(tc.archived)
			})
		}
	})
}
