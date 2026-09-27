package compose

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type browserReadDependencies struct {
	creates   int
	workspace db.Workspace
	err       error
	lookups   []db.GetActiveWorkspaceForUserRepoParams
	canWrite  bool
}

func (d *browserReadDependencies) GetRepoView(context.Context, *db.User, string, string) (services.RepoView, error) {
	return services.RepoView{Repository: db.Repository{ID: 23}, CanWrite: d.canWrite}, nil
}
func (d *browserReadDependencies) CreateWorkspace(context.Context, services.CreateWorkspaceInput) (services.WorkspaceResponse, error) {
	d.creates++
	return services.WorkspaceResponse{}, nil
}
func (d *browserReadDependencies) GetWorkspaceForUserRepo(context.Context, db.GetWorkspaceForUserRepoParams) (db.Workspace, error) {
	return d.workspace, d.err
}
func (d *browserReadDependencies) GetActiveWorkspaceForUserRepo(_ context.Context, params db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
	d.lookups = append(d.lookups, params)
	return d.workspace, d.err
}

func TestBrowserFlowReadDoesNotProvisionWorkspace(t *testing.T) {
	for _, procedure := range []string{"List", "Projection.Snapshot"} {
		for _, state := range []string{"missing", "suspended", "running"} {
			t.Run(procedure+"/"+state, func(t *testing.T) {
				deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: "11111111-1111-4111-8111-111111111111", Status: state}}
				if state == "missing" {
					deps.err = pgx.ErrNoRows
				}
				api := browserFlowAPI{repos: deps, workspaces: deps, queries: deps}
				request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(`{"repo":"owner/repo","procedure":"`+procedure+`","payload":{}}`))
				request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
				writer := httptest.NewRecorder()
				_, target, ok := api.prepare(writer, request, false)
				require.Equal(t, state == "running", ok)
				require.Zero(t, deps.creates)
				require.Equal(t, []db.GetActiveWorkspaceForUserRepoParams{{RepositoryID: 23, UserID: 17}}, deps.lookups)
				if ok {
					require.Equal(t, deps.workspace.ID, target.WorkspaceID)
				} else {
					require.Equal(t, 404, writer.Code)
				}
			})
		}
	}
}

func TestBrowserFlowUnknownProcedureCannotCreateWorkspace(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true}
	api := browserFlowAPI{repos: deps, workspaces: deps, queries: deps}
	request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(`{"repo":"owner/repo","procedure":"Unknown"}`))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
	writer := httptest.NewRecorder()
	api.rpc(writer, request)
	require.Equal(t, 400, writer.Code)
	require.Zero(t, deps.creates)
	require.Empty(t, deps.lookups)
}

// #2206: a running workspace built with a subscription token is not entered.
func TestBrowserFlowRefusesRebuildRequiredWorkspace(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	for _, body := range []string{
		`{"repo":"owner/repo","procedure":"List","payload":{}}`,
		`{"repo":"owner/repo","workspaceId":"` + id + `","procedure":"List","payload":{}}`,
	} {
		deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: id, Status: "running", RebuildRequiredAt: pgtype.Timestamptz{Valid: true}}}
		api := browserFlowAPI{repos: deps, workspaces: deps, queries: deps}
		request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
		writer := httptest.NewRecorder()
		_, _, ok := api.prepare(writer, request, false)
		require.False(t, ok, body)
		require.Equal(t, 409, writer.Code, body)
	}
}
