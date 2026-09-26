package services

import (
	"context"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
	"time"
)

func factoryFixture(t *testing.T) FactoryProjection {
	t.Helper()
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal([]byte(`{"flows":[{"id":"assistant","kind":"mdx","capabilities":["memory:read:global-team"],"flows":[],"budget":{"tokens":2400000,"milliseconds":21600000}}],"on":[{"event":"issue_comment","flow":"assistant"},{"event":"schedule:0 9 * * 1-5","flow":"assistant"},{"event":"issue.opened","flow":"not-discovered"}]}`), &projection))
	return projection
}

func TestFactoryRules(t *testing.T) {
	projection := factoryFixture(t)
	rules, err := factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	require.Len(t, rules, 2)
	require.Equal(t, "issue_comment", rules[0].input.Events[0].Type)
	require.Equal(t, "0 9 * * 1-5", rules[1].input.Schedule)
	require.NotEqual(t, rules[0].job, rules[1].job)
	input := rules[0].input
	input.WorkspaceID = repositoryJobTestInput().WorkspaceID
	input.Revision = 1
	_, err = validateRepositoryJob(rules[0].job, input, time.Now())
	require.NoError(t, err)
	again, err := factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	require.Equal(t, rules, again)
	projection.On = append(projection.On, projection.On[0])
	_, err = factoryRegistrations(projection, strings.Repeat("a", 40))
	require.ErrorContains(t, err, "duplicate")
	projection = factoryFixture(t)
	projection.Flows[0].Budget = nil
	rules, err = factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	require.Empty(t, rules)
}

func TestFactoryReconcileRestartAndRetirement(t *testing.T) {
	pool, q, service, gateway, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := gateway.target.RepositoryID
	revision := strings.Repeat("a", 40)
	projection := factoryFixture(t)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, revision, projection))
	first, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, first, 2)
	// A fresh service sees the same rows; unchanged main cannot reenable a pause.
	_, err = q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repo, Job: first[0].Job})
	require.NoError(t, err)
	restarted := NewRepositoryJobService(q, gateway, pool)
	require.NoError(t, restarted.ReconcileFactoryRules(ctx, repo, revision, projection))
	second, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, first[0].Revision, second[0].Revision)
	require.False(t, second[0].Enabled)
	require.NoError(t, restarted.ReconcileFactoryRules(ctx, repo, strings.Repeat("b", 40), projection))
	third, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, first[0].Revision+1, third[0].Revision)
	require.NoError(t, restarted.ReconcileFactoryRules(ctx, repo, strings.Repeat("c", 40), FactoryProjection{}))
	retired, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	for _, row := range retired {
		require.False(t, row.Enabled)
	}
}
