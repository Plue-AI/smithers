//go:build integration
// +build integration

package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

const (
	routesIntegrationApprovalDecidePerMin = 10
)

type routesIntegrationServerOptions struct {
	includeUserWorkspaces     bool
	includeUserRepos          bool
	includeDevtools           bool
	approvalService           ApprovalRouteService
	workflowService           WorkflowRouteService
	agentSessionStreamService AgentSessionStreamService
	agentSessionStreamPool    *pgxpool.Pool
	agentSessionStreamBroker  *sse.Broker
}

type routesIntegrationUser struct {
	ID       int64
	Username string
}

type routesIntegrationRepo struct {
	ID    int64
	Owner string
	Name  string
}

func setupRoutesIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	return pool
}

func setupRoutesIntegrationServer(t *testing.T, queries *db.Queries, opts routesIntegrationServerOptions) (*httptest.Server, *http.Client) {
	t.Helper()

	r := chi.NewRouter()
	r.Use(middleware.AuthLoader(queries, config.AuthConfig{}))

	r.Route("/api", func(r chi.Router) {
		if opts.includeUserWorkspaces {
			handler := &WorkspaceHandler{Service: services.NewWorkspaceService(queries)}
			r.With(
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeReadRepository),
			).Get("/user/workspaces", handler.GetUserWorkspaces)
		}
		if opts.includeUserRepos {
			r.With(
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeReadRepository),
			).Get("/user/repos", NewUserReposHandler(queries).ListUserRepos)
		}

		r.Route("/repos/{owner}/{repo}", func(r chi.Router) {
			r.Use(middleware.LoadRepoContext(queries))

			readRepo := []func(http.Handler) http.Handler{
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeReadRepository),
				middleware.RequireRepoPermission(middleware.PermissionRead),
			}
			writeRepo := []func(http.Handler) http.Handler{
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeWriteRepository),
				middleware.RequireRepoPermission(middleware.PermissionWrite),
			}

			if opts.includeDevtools {
				RegisterDevtoolsSnapshotRoutes(r, queries, readRepo, writeRepo, true)
			}

			if opts.approvalService != nil {
				handler := &ApprovalsHandler{
					Service: opts.approvalService,
					Enabled: true,
				}

				r.With(readRepo...).Get("/approvals", handler.ListApprovals)
				r.With(readRepo...).Get("/approvals/{id}", handler.GetApproval)

				approvalDecideRoute := append([]func(http.Handler) http.Handler{}, writeRepo...)
				approvalDecideRoute = append(
					approvalDecideRoute,
					middleware.ApprovalDecideRateLimit(queries, routesIntegrationApprovalDecidePerMin),
				)
				r.With(approvalDecideRoute...).Post("/approvals/{id}/decide", handler.DecideApproval)
			}

			if opts.workflowService != nil {
				handler := &WorkflowHandler{Service: opts.workflowService}
				r.With(writeRepo...).Post("/workflows/runs/{id}/cancel", handler.CancelWorkflowRun)
				r.With(writeRepo...).Post("/workflows/runs/{id}/rerun", handler.RerunWorkflowRun)
				r.With(writeRepo...).Post("/workflows/runs/{id}/resume", handler.ResumeWorkflowRun)
				r.With(writeRepo...).Post("/runs/{id}/cancel", handler.CancelWorkflowRun)
				r.With(writeRepo...).Post("/runs/{id}/rerun", handler.RerunWorkflowRun)
				r.With(writeRepo...).Post("/runs/{id}/resume", handler.ResumeWorkflowRun)
			}

			if opts.agentSessionStreamService != nil {
				broker := opts.agentSessionStreamBroker
				if broker == nil && opts.agentSessionStreamPool != nil {
					broker = sse.NewBroker(opts.agentSessionStreamPool)
					require.NoError(t, broker.Start(context.Background()))
					t.Cleanup(broker.Stop)
				}
				handler := &AgentSessionStreamHandler{
					Service: opts.agentSessionStreamService,
					Broker:  broker,
				}
				r.With(readRepo...).Get("/agent/sessions/{id}/stream", handler.AgentSessionStream)
			}
		})
	})

	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	client := server.Client()
	return server, client
}

func routesIntegrationAuthenticatedClient(t *testing.T, server *httptest.Server, sessionCookie *http.Cookie) *http.Client {
	t.Helper()

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)

	baseURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	jar.SetCookies(baseURL, []*http.Cookie{sessionCookie})

	// Server.Client returns a shared pointer. Copy it before adding cookies so
	// authenticating one caller cannot authenticate anonymous or other callers.
	client := *server.Client()
	client.Jar = jar
	return &client
}

func routesIntegrationDoRequest(t *testing.T, client *http.Client, baseURL, method, path string, body []byte) *http.Response {
	t.Helper()

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}

	req, err := http.NewRequest(method, baseURL+path, reader)
	require.NoError(t, err)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := client.Do(req)
	require.NoError(t, err)
	return resp
}

func routesIntegrationReadBody(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return body
}

func routesIntegrationDecodeJSON(t *testing.T, resp *http.Response, target any) {
	t.Helper()
	defer resp.Body.Close()
	require.NoError(t, json.NewDecoder(resp.Body).Decode(target))
}

func routesIntegrationCreateUser(t *testing.T, pool *pgxpool.Pool, prefix string) routesIntegrationUser {
	t.Helper()

	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	username := fmt.Sprintf("%s_%s", strings.ToLower(prefix), unique)
	email := username + "@example.com"

	var userID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		username,
		username,
		email,
		email,
		username,
	).Scan(&userID)
	require.NoError(t, err)

	return routesIntegrationUser{
		ID:       userID,
		Username: username,
	}
}

func routesIntegrationCreateRepo(t *testing.T, pool *pgxpool.Pool, owner routesIntegrationUser, prefix string, isPublic bool) routesIntegrationRepo {
	t.Helper()

	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	name := fmt.Sprintf("%s_%s", strings.ToLower(prefix), unique)

	var repoID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (
			 user_id, name, lower_name, description, is_public,
			 default_bookmark, next_issue_number, next_landing_number
		 )
		 VALUES ($1, $2, $3, '', $4, 'main', 1, 1)
		 RETURNING id`,
		owner.ID,
		name,
		name,
		isPublic,
	).Scan(&repoID)
	require.NoError(t, err)

	return routesIntegrationRepo{
		ID:    repoID,
		Owner: owner.Username,
		Name:  name,
	}
}

func routesIntegrationCreateSessionCookie(t *testing.T, queries *db.Queries, user routesIntegrationUser) *http.Cookie {
	t.Helper()

	session, err := queries.CreateAuthSession(context.Background(), db.CreateAuthSessionParams{
		SessionKey: uuid.NewString(),
		UserID:     user.ID,
		Username:   user.Username,
		IsAdmin:    false,
		ExpiresAt:  time.Now().Add(24 * time.Hour),
	})
	require.NoError(t, err)

	return &http.Cookie{
		Name:  "smithers_session",
		Value: session.SessionKey,
		Path:  "/",
	}
}

func routesIntegrationCreateWorkspace(
	t *testing.T,
	queries *db.Queries,
	pool *pgxpool.Pool,
	repo routesIntegrationRepo,
	user routesIntegrationUser,
	name string,
	lastAccessedAt time.Time,
) db.Workspace {
	t.Helper()

	workspace, err := queries.CreateWorkspace(context.Background(), db.CreateWorkspaceParams{
		RepositoryID: repo.ID,
		UserID:       user.ID,
		Name:         name,
		Status:       "running",
	})
	require.NoError(t, err)

	_, err = pool.Exec(
		context.Background(),
		`UPDATE workspaces
		 SET last_accessed_at = $2, last_activity_at = $2
		 WHERE id = $1`,
		workspace.ID,
		lastAccessedAt.UTC(),
	)
	require.NoError(t, err)

	workspace.LastAccessedAt = pgtype.Timestamptz{Time: lastAccessedAt.UTC(), Valid: true}
	return workspace
}

func routesIntegrationCreateAgentSession(t *testing.T, queries *db.Queries, repo routesIntegrationRepo, user routesIntegrationUser) db.AgentSession {
	t.Helper()

	session, err := queries.CreateAgentSession(context.Background(), db.CreateAgentSessionParams{
		ID:           uuid.NewString(),
		RepositoryID: repo.ID,
		UserID:       user.ID,
		Title:        "Route integration session",
		Status:       "active",
	})
	require.NoError(t, err)
	return session
}

func routesIntegrationCreateApproval(t *testing.T, queries *db.Queries, session db.AgentSession, kind, title string) db.Approval {
	t.Helper()

	approval, err := queries.CreateApproval(context.Background(), db.CreateApprovalParams{
		ID:           uuid.NewString(),
		SessionID:    pgtype.Text{String: session.ID, Valid: true},
		RepositoryID: session.RepositoryID,
		Kind:         kind,
		Title:        title,
		Description:  pgtype.Text{String: title + " description", Valid: true},
		ExpiresAt:    pgtype.Timestamptz{Time: time.Now().Add(2 * time.Hour).UTC(), Valid: true},
		Payload:      json.RawMessage(`{"command":"echo integration"}`),
	})
	require.NoError(t, err)
	return approval
}
