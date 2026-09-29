package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// This exercises the real product database admission and host-authority boundary.
// The dispatcher records launch requests; no model or workspace VM runs here.
func TestFactoryRepositoryIsolationThroughDispatch(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	owner := "factoryowner" + suffix
	var userID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		owner, suffix+"@example.invalid").Scan(&userID))

	type repository struct {
		id                      int64
		name, workspace, source string
		registration            db.RepositoryJobRegistration
		launch                  flowdispatch.LaunchRequest
	}
	repos := []repository{
		{name: "codea" + suffix, workspace: uuid.NewString(), source: strings.Repeat("a", 40)},
		{name: "codeb" + suffix, workspace: uuid.NewString(), source: strings.Repeat("b", 40)},
	}
	for i := range repos {
		repo := &repos[i]
		require.NoError(t, pool.QueryRow(ctx,
			`INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`,
			userID, repo.name).Scan(&repo.id))
		_, err := pool.Exec(ctx,
			`INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`,
			repo.workspace, repo.id, userID)
		require.NoError(t, err)
	}

	dispatcher := &repositoryJobTestGateway{t: t}
	service := NewRepositoryJobService(q, dispatcher, pool)
	dispatcher.service = service
	service.SetFlowDispatcher(dispatcher)
	projection := func(selector string) FactoryProjection {
		t.Helper()
		rule := `{"event":"issue.labeled:engineering","flow":"engineering"` + selector + `}`
		var value FactoryProjection
		require.NoError(t, json.Unmarshal([]byte(`{"flows":[{"id":"engineering","kind":"mdx","capabilities":["fs:read","fs:write"],"flows":[],"budget":{"tokens":12000,"milliseconds":600000}}],"on":[`+rule+`]}`), &value))
		return value
	}
	for i := range repos {
		repo := &repos[i]
		require.NoError(t, service.ReconcileFactoryRules(ctx, repo.id, repo.source, projection("")))
		rows, err := q.ListRepositoryJobRegistrations(ctx, repo.id)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		repo.registration = rows[0]
		require.Equal(t, "engineering", rows[0].FlowID)
		require.Equal(t, repo.workspace, rows[0].WorkspaceID)
		require.Equal(t, userID, rows[0].UserID)
		require.Equal(t, repo.source, rows[0].SourceRevision)
	}
	require.Equal(t, repos[0].registration.Job, repos[1].registration.Job, "the same rule key remains scoped by repository")

	admit := func(repo repository, delivery string) {
		t.Helper()
		payload := json.RawMessage(`{"action":"labeled","issue":{"number":7,"body":"change code","smithers_text_by_maintainer":true,"labels":[{"name":"engineering"}]},"label":{"name":"engineering","smithers_applied_by_maintainer":true}}`)
		require.NoError(t, service.AdmitGitHubEvent(ctx, repo.id,
			db.GithubWebhookJob{DeliveryID: delivery, Payload: payload}, TriggerEvent{Type: "issues", Action: "labeled"}))
		require.NoError(t, service.PollOnce(ctx))
	}
	admit(repos[0], "factory-a-"+suffix)
	require.Len(t, dispatcher.pendingLaunches, 1, "A's event cannot launch B's factory")
	require.Empty(t, dispatcher.pendingSignals)
	repos[0].launch = dispatcher.pendingLaunches[0]
	rows, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: repos[1].id, Job: repos[1].registration.Job})
	require.NoError(t, err)
	require.Empty(t, rows)

	admit(repos[1], "factory-b-"+suffix)
	require.Len(t, dispatcher.pendingLaunches, 2)
	repos[1].launch = dispatcher.pendingLaunches[1]
	resolver, err := NewRepositoryJobFlowHostTargetResolver(service)
	require.NoError(t, err)
	for i := range repos {
		repo := repos[i]
		request := repo.launch
		require.Equal(t, "engineering", request.FlowID)
		require.Equal(t, fmt.Sprintf("repository:%d", repo.id), request.Scope.TenantID)
		require.Equal(t, fmt.Sprintf("user:%d", userID), request.Scope.PrincipalID)
		require.Equal(t, repo.workspace, request.Target.WorkspaceID)
		target := request.Target
		target.TenantID, target.PrincipalID = request.Scope.TenantID, request.Scope.PrincipalID
		authority, err := resolver.ResolveFlowHostTarget(ctx, target)
		require.NoError(t, err)
		require.Equal(t, repo.id, authority.RepositoryID)
		require.Equal(t, userID, authority.UserID)
		require.Equal(t, repo.workspace, authority.WorkspaceID)
		require.Equal(t, repo.source, authority.SourceRevision)
		other := repos[1-i]
		wrongTenant := target
		wrongTenant.TenantID = fmt.Sprintf("repository:%d", other.id)
		_, err = resolver.ResolveFlowHostTarget(ctx, wrongTenant)
		require.Error(t, err)
		wrongWorkspace := target
		wrongWorkspace.WorkspaceID = other.workspace
		_, err = resolver.ResolveFlowHostTarget(ctx, wrongWorkspace)
		require.Error(t, err)
		wrongBinding := target
		wrongBinding.BindingID = other.launch.Target.BindingID
		_, err = resolver.ResolveFlowHostTarget(ctx, wrongBinding)
		require.Error(t, err)
	}

	// A malformed cross-repository declaration must leave both live rows alone.
	before := make([][]db.RepositoryJobRegistration, len(repos))
	for i, repo := range repos {
		before[i], err = q.ListRepositoryJobRegistrations(ctx, repo.id)
		require.NoError(t, err)
	}
	selector := fmt.Sprintf(`,"repository":%q`, owner+"/"+repos[1].name)
	err = service.ReconcileFactoryRules(ctx, repos[0].id, strings.Repeat("c", 40), projection(selector))
	require.ErrorContains(t, err, "declare the flow in the target repository's factory")
	for i, repo := range repos {
		after, err := q.ListRepositoryJobRegistrations(ctx, repo.id)
		require.NoError(t, err)
		require.Equal(t, before[i], after, "rejected selector cannot replace or retire a registration")
	}
}
