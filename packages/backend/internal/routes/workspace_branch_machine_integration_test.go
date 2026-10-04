//go:build integration

package routes

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The runtime is only a write sentinel: provider absence must refuse before
// reaching it. PostgreSQL, session authentication, repository permission and
// the production create/fork handlers are real. This is refusal evidence,
// not the microVM working-copy acceptance check.
func TestBranchMachineUnavailableProvidersHTTP(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	q := db.New(pool)
	user := routesIntegrationCreateUser(t, pool, "branch_dark")
	repo := routesIntegrationCreateRepo(t, pool, user, "branch_dark", false)
	complete := services.BranchMachineProviders{
		Membership:  func(context.Context, pgx.Tx, int64, int64) error { return nil },
		Authorize:   func(context.Context, pgx.Tx, string, int64, string, int64) error { return nil },
		LaneBinding: func(context.Context, pgx.Tx, int64, string) error { return nil },
		MicroVM:     func(context.Context) error { return nil }, SessionIdentity: func(context.Context) error { return nil },
	}
	for _, missing := range []string{"membership", "authorizer", "lane", "microvm", "identity", "transaction"} {
		t.Run(missing, func(t *testing.T) {
			providers := complete
			switch missing {
			case "membership":
				providers.Membership = nil
			case "authorizer":
				providers.Authorize = nil
			case "lane":
				providers.LaneBinding = nil
			case "microvm":
				providers.MicroVM = nil
			case "identity":
				providers.SessionIdentity = nil
			}
			sentinel := &sizingSandbox{}
			options := []services.WorkspaceServiceOption{services.WithWorkspaceSandboxClient(sentinel), services.WithBranchMachineProviders(providers)}
			if missing != "transaction" {
				options = append(options, services.WithWorkspaceTransactions(pool))
			}
			handler := &WorkspaceHandler{Service: services.NewWorkspaceService(q, options...)}
			router := chi.NewRouter()
			router.Use(middleware.AuthLoader(q, config.AuthConfig{}))
			router.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
				r.Use(middleware.LoadRepoContext(q))
				r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), middleware.RequireRepoPermission(middleware.PermissionWrite))
				r.Post("/workspaces", handler.CreateWorkspace)
				r.Post("/workspaces/{id}/fork", handler.ForkWorkspace)
			})
			server := httptest.NewServer(router)
			defer server.Close()
			client := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, q, user))
			for _, suffix := range []string{"", "/11111111-1111-4111-8111-111111111111/fork"} {
				url := server.URL + fmt.Sprintf("/api/repos/%s/%s/workspaces", repo.Owner, repo.Name) + suffix
				response, err := client.Post(url, "application/json", strings.NewReader(`{"name":"scratch/member/shared"}`))
				require.NoError(t, err)
				body, err := io.ReadAll(response.Body)
				response.Body.Close()
				require.NoError(t, err)
				require.Equal(t, http.StatusServiceUnavailable, response.StatusCode, string(body))
			}
			var count int
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM workspaces WHERE repository_id=$1`, repo.ID).Scan(&count))
			require.Equal(t, 0, count)
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_shares`).Scan(&count))
			require.Equal(t, 0, count)
			creates, forks := sentinel.requests()
			require.Empty(t, creates)
			require.Empty(t, forks)
		})
	}
}
