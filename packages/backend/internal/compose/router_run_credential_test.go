package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A service spy is sufficient here: the boundary under test is whether the
// assembled HTTP router lets a credential reach the cancellation service.
func TestServerRouter_RunControlRequiresPerson(t *testing.T) {
	credentials := []struct {
		name    string
		auth    *middleware.AuthInfo
		allowed bool
	}{
		{"run credential", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "user"}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository,repo:200", Scopes: middleware.ParseTokenScopes("write:repository,repo:200")}, false},
		{"bot account", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "bot"}, IsTokenAuth: true, RawScopes: "write:repository", Scopes: middleware.ParseTokenScopes("write:repository")}, false},
		{"service account", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "service"}, IsTokenAuth: true, RawScopes: "write:repository", Scopes: middleware.ParseTokenScopes("write:repository")}, false},
		{"person", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "user"}, IsTokenAuth: true, RawScopes: "write:repository", Scopes: middleware.ParseTokenScopes("write:repository")}, true},
		{"person session", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "user"}}, true},
	}
	paths := []string{
		"/api/repos/owner/repo/workflows/runs/42/cancel",
		"/api/repos/owner/repo/actions/runs/42/cancel",
		"/api/repos/owner/repo/runs/42/cancel",
	}
	for _, path := range paths {
		for _, credential := range credentials {
			t.Run(path+"/"+credential.name, func(t *testing.T) {
				calls := 0
				workflow := &mockRouterWorkflowService{cancelWorkflowRunFn: func(_ context.Context, repoID, runID int64) error {
					calls++
					require.Equal(t, int64(200), repoID)
					require.Equal(t, int64(42), runID)
					return nil
				}}
				router := buildWorkflowTriggerRouter(nil, nil, &routes.WorkflowHandler{Service: workflow})
				request := httptest.NewRequest(http.MethodPost, path, nil)
				if !credential.auth.IsTokenAuth {
					request.Header.Set("X-CSRF-Token", "test-csrf-token")
					request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "test-csrf-token"})
				}
				request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), credential.auth))
				request = routerRepoContext(request, "owner", "repo")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if credential.allowed {
					require.Equal(t, http.StatusNoContent, response.Code, response.Body.String())
					require.Equal(t, 1, calls)
					return
				}
				require.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
				require.Contains(t, response.Body.String(), "cannot use this endpoint")
				require.Zero(t, calls, "non-person credential reached the cancellation service")
			})
		}
	}
}

type pauseRepositoryJobSpy struct {
	routes.RepositoryJobRouteService
	calls int
}

func (spy *pauseRepositoryJobSpy) Pause(_ context.Context, repoID, userID int64, job string) ([]db.RepositoryJobRegistration, error) {
	spy.calls++
	if repoID != 200 || userID != 17 || job != "ci" {
		return nil, fmt.Errorf("unexpected pause target: repo=%d user=%d job=%s", repoID, userID, job)
	}
	return []db.RepositoryJobRegistration{}, nil
}

func TestServerRouter_RepositoryJobPauseRequiresPerson(t *testing.T) {
	for _, credential := range []struct {
		name    string
		auth    *middleware.AuthInfo
		allowed bool
	}{
		{"run credential", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "user"}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository,repo:200", Scopes: middleware.ParseTokenScopes("write:repository,repo:200")}, false},
		{"bot account", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "bot"}, IsTokenAuth: true, RawScopes: "write:repository", Scopes: middleware.ParseTokenScopes("write:repository")}, false},
		{"service account", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "service"}, IsTokenAuth: true, RawScopes: "write:repository", Scopes: middleware.ParseTokenScopes("write:repository")}, false},
		{"person", &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "user"}, IsTokenAuth: true, RawScopes: "write:repository", Scopes: middleware.ParseTokenScopes("write:repository")}, true},
	} {
		t.Run(credential.name, func(t *testing.T) {
			spy := &pauseRepositoryJobSpy{}
			router := buildRouter(
				testConfigAllFlagsOn(), nil, nil,
				&routes.RepoHandler{}, nil, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, nil,
				&routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{},
				nil, nil, nil, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
				nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
				nil, nil, // notifications, pair sessions
				nil, nil, nil, nil, nil, // admin routes
				nil, nil, nil, nil, nil, nil, nil, nil, // webhook through LFS
				nil, // JJVCS
				&routes.AgentInternalHandler{}, nil, nil, nil, nil, nil,
				nil, nil, nil, nil, nil, nil,
				&routes.RepositoryJobHandler{RepositoryJobs: spy},
				nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
			)
			request := httptest.NewRequest(http.MethodPost, "/api/repos/owner/repo/repository-jobs/ci/pause", nil)
			request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), credential.auth))
			request = routerRepoContext(request, "owner", "repo")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if credential.allowed {
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				require.Equal(t, 1, spy.calls)
				return
			}
			assert.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
			assert.Contains(t, response.Body.String(), "cannot use this endpoint")
			assert.Zero(t, spy.calls, "non-person credential reached repository job pause")
		})
	}
}

// This exercises the real auth loader, repository permission lookup, workflow
// service and database write through every public REST cancellation alias.
func TestServerRouter_RunCredentialCannotCancelWorkflowRunPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	queries := db.New(pool)
	owner, err := queries.CreateUser(ctx, db.CreateUserParams{Username: "cancel-owner", LowerUsername: "cancel-owner", DisplayName: "Cancel owner"})
	require.NoError(t, err)
	repoID := ciTestRepo(t, pool, owner.ID, "app")
	definitionID := ciTestDefinition(t, queries, repoID)

	issueToken := func(name string, systemIssued bool) string {
		token := "smithers_" + hex.EncodeToString([]byte(name + "-token-padding-bytes"))[:40]
		sum := sha256.Sum256([]byte(token))
		hash := hex.EncodeToString(sum[:])
		scopes := string(middleware.ScopeWriteRepository)
		if systemIssued {
			scopes += "," + middleware.RepositoryRestrictionScope(repoID) + "," + middleware.AgentSessionRestrictionScope("session-1")
		}
		_, err := queries.CreateAccessToken(ctx, db.CreateAccessTokenParams{
			UserID: owner.ID, Name: name, TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
			Scopes: scopes, SystemIssued: systemIssued,
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
		})
		require.NoError(t, err)
		return token
	}
	runToken := issueToken("cancel-run", true)
	personToken := issueToken("cancel-person", false)
	router := buildWorkflowTriggerRouter(queries, pool, &routes.WorkflowHandler{
		Service: services.NewWorkflowAPIService(queries, services.NewWorkflowRunService(queries)),
	})
	serve := func(token, path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/repos/cancel-owner/app"+path, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}

	for _, alias := range []string{"/workflows/runs/%d/cancel", "/actions/runs/%d/cancel", "/runs/%d/cancel"} {
		run, err := queries.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{
			RepositoryID: repoID, WorkflowDefinitionID: definitionID,
			Status: "queued", TriggerEvent: "workflow_dispatch", TriggerRef: "main",
			TriggerCommitSha: "abcdef", DispatchInputs: []byte(`{}`),
		})
		require.NoError(t, err)
		path := fmt.Sprintf(alias, run.ID)
		t.Run(path, func(t *testing.T) {
			for _, forbidden := range []struct {
				name, userType, token string
			}{
				{"run credential", "user", runToken},
				{"bot account", "bot", personToken},
				{"service account", "service", personToken},
			} {
				_, err := pool.Exec(ctx, `UPDATE users SET user_type = $1 WHERE id = $2`, forbidden.userType, owner.ID)
				require.NoError(t, err)
				blocked := serve(forbidden.token, path)
				assert.Equal(t, http.StatusForbidden, blocked.Code, "%s: %s", forbidden.name, blocked.Body.String())
				assert.Contains(t, blocked.Body.String(), "cannot use this endpoint", forbidden.name)
				stored, err := queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: run.ID, RepositoryID: repoID})
				require.NoError(t, err)
				assert.Equal(t, "queued", stored.Status, "%s canceled the run", forbidden.name)
			}
			if t.Failed() {
				return
			}
			_, err = pool.Exec(ctx, `UPDATE users SET user_type = 'user' WHERE id = $1`, owner.ID)
			require.NoError(t, err)

			allowed := serve(personToken, path)
			require.Equal(t, http.StatusNoContent, allowed.Code, allowed.Body.String())
			stored, err := queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: run.ID, RepositoryID: repoID})
			require.NoError(t, err)
			require.Equal(t, "cancelled", stored.Status)
		})
	}
}
