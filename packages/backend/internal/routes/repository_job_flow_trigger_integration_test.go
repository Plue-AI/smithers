//go:build integration
// +build integration

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// Register a rule (#1888): the app's approval, the coding host's
// repository/trigger write and the scheduler, all through their HTTP routes
// and the real Postgres store, end in one live schedule that fires its
// registered flow once per occurrence.
func TestRepositoryFlowTriggerRegistrationIsLive(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	owner := routesIntegrationCreateUser(t, pool, "triggerowner")
	repo := routesIntegrationCreateRepo(t, pool, owner, "triggerrepo", false)
	workspace := routesIntegrationCreateWorkspace(t, queries, pool, repo, owner, "gateway", time.Now())

	service := services.NewRepositoryJobService(queries, repositoryJobApprovalHost{target: services.BoxHostTarget{
		HostID: "gateway", RepositoryID: repo.ID, UserID: owner.ID, WorkspaceID: workspace.ID}}, pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	// The real admission path. Admission persists the launch and never
	// resolves a runtime host, so a resolver call is a failure.
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: service,
		Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Fatal("admitting a scheduled fire must not start a runtime")
			return nil, nil
		})})
	require.NoError(t, err)
	service.SetFlowDispatcher(dispatcher)

	server := repositoryJobApprovalServer(t, queries, service)
	ownerClient := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, owner))
	base := server.URL + "/api/repos/" + repo.Owner + "/" + repo.Name + "/repository-jobs"

	envelope := json.RawMessage(`{"capabilities":["read"],"flows":["nightly-lint"],"budget":{"tokens":12000,"milliseconds":600000}}`)
	planDigest := strings.Repeat("2", 64)
	status, body := repositoryJobApprovalDo(t, ownerClient, http.MethodPost, base+"/flow:nightly-lint/approvals", "",
		map[string]any{"plan_id": "plan-01", "plan_digest": planDigest, "flow_id": "nightly-lint", "envelope": envelope})
	require.Equal(t, http.StatusOK, status, body)

	// The body flows/repository/triggers.ts Activate sends.
	registration := map[string]any{"repo": strings.ToLower(repo.Owner) + "/" + strings.ToLower(repo.Name),
		"workspace_id": workspace.ID, "flow_id": "nightly-lint", "revision": 1, "digest": strings.Repeat("a", 64),
		"source_revision": strings.Repeat("b", 40), "execution_digest": strings.Repeat("c", 64), "envelope": envelope,
		"mode": "enabled", "events": []any{}, "schedule": "0 3 * * *", "input": map[string]any{"label": "nightly"},
		"approved_plan_id": "plan-01", "approved_plan_digest": planDigest}
	register := func() map[string]any {
		t.Helper()
		status, body := repositoryJobApprovalDo(t, server.Client(), http.MethodPut,
			server.URL+"/api/gateways/gateway/repository-jobs/flow:nightly-lint", repositoryJobApprovalBearer, registration)
		require.Equal(t, http.StatusOK, status, body)
		var receipt map[string]any
		require.NoError(t, json.Unmarshal([]byte(body), &receipt))
		return receipt
	}
	first := register()
	require.Equal(t, true, first["enabled"])
	require.Equal(t, "0 3 * * *", first["schedule"])
	require.Equal(t, "UTC", first["timezone"])
	nextFire, err := time.Parse(time.RFC3339Nano, first["next_fire_at"].(string))
	require.NoError(t, err)
	require.True(t, nextFire.After(time.Now()), "a live schedule names its next fire")
	require.Equal(t, 3, nextFire.UTC().Hour())

	// A duplicate apply of the same reviewed revision is the same registration.
	second := register()
	require.Equal(t, first["registration_id"], second["registration_id"])
	require.Equal(t, first["next_fire_at"], second["next_fire_at"])

	listed := func() []db.RepositoryJobRegistration {
		t.Helper()
		status, body := repositoryJobApprovalDo(t, ownerClient, http.MethodGet, base, "", nil)
		require.Equal(t, http.StatusOK, status, body)
		var rows []db.RepositoryJobRegistration
		require.NoError(t, json.Unmarshal([]byte(body), &rows))
		return rows
	}
	rows := listed()
	require.Len(t, rows, 1)
	require.Equal(t, first["registration_id"], rows[0].ID)
	require.Equal(t, "flow:nightly-lint", rows[0].Job)
	require.True(t, rows[0].Enabled)
	require.True(t, rows[0].NextFireAt.Valid)

	dispatches := func() []services.RepositoryJobDispatchReceipt {
		t.Helper()
		status, body := repositoryJobApprovalDo(t, ownerClient, http.MethodGet, base+"/flow:nightly-lint/dispatches", "", nil)
		require.Equal(t, http.StatusOK, status, body)
		var rows []services.RepositoryJobDispatchReceipt
		require.NoError(t, json.Unmarshal([]byte(body), &rows))
		return rows
	}
	require.NoError(t, service.PollOnce(ctx))
	require.Empty(t, dispatches(), "a schedule fires only when its occurrence is due")

	// The occurrence comes due: the scheduler fires it once.
	_, err = pool.Exec(ctx, `UPDATE repository_job_registrations SET next_fire_at=now()-interval '1 second' WHERE id=$1`, rows[0].ID)
	require.NoError(t, err)
	require.NoError(t, service.PollOnce(ctx))
	fired := dispatches()
	require.Len(t, fired, 1)
	require.Equal(t, "schedule", fired[0].Source)
	require.Equal(t, "waiting", fired[0].Status, fired[0].Error)
	require.Equal(t, rows[0].ID, fired[0].RegistrationID)
	var receipt jobs.RequestReceipt
	require.NoError(t, json.Unmarshal(fired[0].Receipt, &receipt))
	require.Equal(t, "repository-job:"+fired[0].ID, receipt.RequestID)

	var launch struct {
		FlowID  string          `json:"flowId"`
		Payload json.RawMessage `json:"payload"`
	}
	var raw []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE request_id=$1`, receipt.RequestID).Scan(&raw))
	require.NoError(t, json.Unmarshal(raw, &launch))
	require.Equal(t, "nightly-lint", launch.FlowID)
	require.JSONEq(t, `{"label":"nightly"}`, string(launch.Payload))

	// The schedule advanced past the fired occurrence; polling again fires nothing more.
	require.NoError(t, service.PollOnce(ctx))
	require.Len(t, dispatches(), 1)
	rows = listed()
	require.Len(t, rows, 1)
	require.True(t, rows[0].NextFireAt.Time.After(time.Now()))
	var launches int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE request_id LIKE 'repository-job:%'`).Scan(&launches))
	require.Equal(t, 1, launches)
}
