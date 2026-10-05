package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A repository with no Smithers declarations still runs TODOs (mvp.md J1.4):
// its policy has the default daily budget, and every field a partial github
// block declares keeps its declared value.
func TestFactoryGitHubPolicyDefaultsEachOmittedField(t *testing.T) {
	t.Parallel()
	require.EqualValues(t, 600_000_000, defaultDailyTokens, "ten runs at the 60M per-run reserve")
	for _, tc := range []struct {
		name, projection string
		daily            int64
		maintainers      []string
	}{
		{"no projection", "", 600_000_000, nil},
		{"no github block", `{"on":[]}`, 600_000_000, nil},
		{"empty github block", `{"github":{}}`, 600_000_000, nil},
		{"null budget", `{"github":{"dailyTokens":null}}`, 600_000_000, nil},
		{"maintainers only", `{"github":{"maintainers":["alice"]}}`, 600_000_000, []string{"alice"}},
		{"declared budget", `{"github":{"maintainers":["alice"],"dailyTokens":1000}}`, 1000, []string{"alice"}},
		{"declared zero", `{"github":{"dailyTokens":0}}`, 0, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy, err := parseFactoryGitHubPolicy([]byte(tc.projection))
			require.NoError(t, err)
			require.EqualValues(t, tc.daily, policy.DailyTokens)
			require.Equal(t, tc.maintainers, policy.Maintainers)
		})
	}
	_, err := parseFactoryGitHubPolicy([]byte(`{"github":{"dailyTokens":-1}}`))
	require.EqualError(t, err, ".smithers/factory.json dailyTokens is negative")
	_, err = parseFactoryGitHubPolicy([]byte(`{"github":`))
	require.EqualError(t, err, ".smithers/factory.json is not valid JSON")
}

// The rehearsal's repository commits no .smithers/: main has no projection.
func TestReadRepositoryPolicyWithoutProjectionHasTheDefaultBudget(t *testing.T) {
	t.Parallel()
	policy, err := readRepositoryPolicy(context.Background(), policyTestHost{}, "owner", "repo", "main")
	require.NoError(t, err)
	require.EqualValues(t, 600_000_000, policy.DailyTokens)
	require.False(t, policy.namesMaintainers())
}

// launchable admits a TODO of a repository with no .smithers/, holding
// mythicalRunTokenReserve of the default budget for each other run in flight.
func TestMythicalLaunchableAcceptsARepositoryWithoutDeclarations(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	o.service.SetPolicyReader(policyTestHost{})
	step := func(inFlight int) *mythicalItemStep {
		running := map[[16]byte]bool{}
		for i := 0; i < inFlight; i++ {
			running[[16]byte{byte(i + 1)}] = true
		}
		return &mythicalItemStep{s: o.service, r: &mythicalRun{row: db.MythicalStack{RepositoryID: o.repoID}}, now: time.Now(), inFlight: running}
	}
	item := db.MythicalItem{ID: pgtype.UUID{Bytes: [16]byte{0xff}, Valid: true}, State: "queued"}
	require.Nil(t, step(0).launchable(ctx, item))
	// 9 x 60M reserved < 600M: a tenth run still launches.
	require.Nil(t, step(9).launchable(ctx, item))
	held := step(10).launchable(ctx, item)
	require.NotNil(t, held)
	require.Equal(t, "the factory's daily token budget is reserved for the runs in flight; work resumes as they settle", held.Reason)
	// Spend recorded today counts against the same default.
	o.spend("", 600_000_000)
	spent := step(0).launchable(ctx, item)
	require.NotNil(t, spent)
	require.Equal(t, "the factory's daily token budget is spent; work resumes at 00:00 UTC", spent.Reason)
}

// The owner-paid model proxy holds each call to the budget launchable reads.
func TestDailyTokenBudgetIsTheLaunchBudget(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	o.service.SetPolicyReader(policyTestHost{})
	budget, err := o.service.DailyTokenBudget(ctx, o.repoID)
	require.NoError(t, err)
	require.EqualValues(t, defaultDailyTokens, budget)
	_, err = o.service.DailyTokenBudget(ctx, o.repoID+1_000_000)
	require.Error(t, err, "an unknown repository has no budget, never a default")
}
