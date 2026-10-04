package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestTodoBranchSlugFromTitle(t *testing.T) {
	for _, tc := range []struct{ title, slug string }{
		{"Add a greeting to JOURNEY.md", "add-a-greeting-to-journey-md"},
		{"  Retry   webhooks!! ", "retry-webhooks"},
		{"v2.0 release/notes_draft", "v2-0-release-notes-draft"},
		{"ÉCOLE — naïve café", "ecole-naive-cafe"},
		{"Füge Grüße hinzu", "fuge-gru-e-hinzu"},
		{"ﬁle ligature", "file-ligature"},
		{"🚀 🚀", ""},
		{"", ""},
		{strings.Repeat("ab", 30), strings.Repeat("ab", 24)},
		{strings.Repeat("a", 47) + " bbbb", strings.Repeat("a", 47)},
		{strings.Repeat("a", 48) + " b", strings.Repeat("a", 48)},
	} {
		t.Run(tc.title, func(t *testing.T) {
			slug := mythicalTodoSlug(tc.title)
			assert.Equal(t, tc.slug, slug)
			assert.LessOrEqual(t, len(slug), 48)
			if slug != "" {
				assert.Regexp(t, mythicalPRSlug, slug)
			}
		})
	}
}

func TestTodoBranchIsUniqueInTheRepository(t *testing.T) {
	long := strings.Repeat("a", 44) + "-bbb"
	for _, tc := range []struct {
		name   string
		slug   string
		number int64
		taken  []string
		branch string
	}{
		{"free", "retry-webhooks", 7, nil, "smithers/retry-webhooks"},
		{"taken by another TODO", "retry-webhooks", 7, []string{"smithers/retry-webhooks"}, "smithers/retry-webhooks-7"},
		{"number taken too", "retry-webhooks", 7, []string{"smithers/retry-webhooks", "smithers/retry-webhooks-7"}, "smithers/retry-webhooks-7-2"},
		{"untitled", "", 7, nil, "smithers/todo-7"},
		{"untitled taken", "", 7, []string{"smithers/todo-7"}, "smithers/todo-7-7"},
		{"long slug keeps 48", long, 12, []string{"smithers/" + long}, "smithers/" + strings.Repeat("a", 44) + "-12"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			taken := map[string]bool{}
			for _, branch := range tc.taken {
				taken[branch] = true
			}
			branch := mythicalUniqueBranch(tc.slug, tc.number, taken)
			assert.Equal(t, tc.branch, branch)
			slug := strings.TrimPrefix(branch, "smithers/")
			assert.LessOrEqual(t, len(slug), 48)
			assert.Regexp(t, mythicalPRSlug, slug)
			assert.False(t, taken[branch])
		})
	}
}

func TestTodoPublicationNeverAuthorizesSystemMerge(t *testing.T) {
	person := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 1}, SessionHash: "browser"})
	run := mythicalRunContext(context.Background(), 1)
	token := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 1}, SessionHash: "browser", IsTokenAuth: true})
	bot := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 1, UserType: "bot"}, SessionHash: "browser"})
	unsigned := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 1}})
	landed := mythicalChecks{Land: &mythicalLand{By: "owner", Session: "browser", Head: strings.Repeat("a", 40)}}
	unsessioned := mythicalChecks{Land: &mythicalLand{By: "label", Head: strings.Repeat("a", 40)}}
	for _, tc := range []struct {
		name   string
		ctx    context.Context
		item   db.MythicalItem
		kind   string
		denied string
	}{
		{"todo push", context.Background(), db.MythicalItem{Source: "todo"}, "push", ""},
		{"issue open", context.Background(), db.MythicalItem{Source: "issue"}, "open", ""},
		{"todo body", context.Background(), db.MythicalItem{Source: "todo"}, "body", ""},
		{"chat push", context.Background(), db.MythicalItem{Source: "chat"}, "push", "only a TODO's own change"},
		{"close after drop", context.Background(), db.MythicalItem{Source: "todo", State: "dropped"}, "close", ""},
		{"system merge", context.Background(), db.MythicalItem{Source: "todo"}, "merge", "never merges on its own"},
		{"run credential merge", run, db.MythicalItem{Source: "todo"}, "merge", "never merges on its own"},
		{"personal token merge", token, db.MythicalItem{Source: "todo"}, "merge", "never merges on its own"},
		{"agent account session merge", bot, db.MythicalItem{Source: "todo"}, "merge", "never merges on its own"},
		{"no browser session merge", unsigned, db.MythicalItem{Source: "todo"}, "merge", "never merges on its own"},
		{"label land merge", context.Background(), db.MythicalItem{Source: "todo", Checks: unsessioned.encode()}, "merge", "never merges on its own"},
		{"person merge", person, db.MythicalItem{Source: "todo"}, "merge", ""},
		{"person's recorded land", context.Background(), db.MythicalItem{Source: "todo", Checks: landed.encode()}, "merge", ""},
		{"approve", person, db.MythicalItem{Source: "todo"}, "approve", "not authorized"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := mythicalCommandAuthorization(tc.ctx, tc.item, tc.kind)
			if tc.denied == "" {
				assert.NoError(t, err)
				return
			}
			assert.ErrorContains(t, err, tc.denied)
		})
	}
}

// A composed install still holds publication while a person's push is
// unanswered: no fact, token or GitHub call is reached.
func TestTodoPublicationHeldByForeignHead(t *testing.T) {
	foreign := mythicalChecks{ForeignHead: strings.Repeat("a", 40)}
	waiting := mythicalChecks{Waits: []TodoWait{{ID: "w1", Kind: "foreign_push", Since: time.Unix(1, 0)}}}
	settled := time.Unix(2, 0)
	answered := mythicalChecks{Waits: []TodoWait{{ID: "w1", Kind: "foreign_push", Since: time.Unix(1, 0), SettledAt: &settled}}}
	for _, tc := range []struct {
		name   string
		checks mythicalChecks
		held   string
	}{
		{"foreign head", foreign, "someone else pushed aaaaaaaaaaaa"},
		{"open foreign push wait", waiting, "waits for a person"},
		{"answered wait", answered, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			s := &MythicalService{publication: &mythicalPublication{}, prFacts: func(context.Context, db.MythicalItem) (mythicalPRShape, error) {
				called = true
				return mythicalPRShape{}, context.Canceled
			}}
			st := &mythicalItemStep{s: s, now: time.Unix(100, 0)}
			item := db.MythicalItem{Source: "todo", State: "proposing", CandidateVerified: true, Checks: tc.checks.encode()}
			next, err := st.propose(context.Background(), item)
			if tc.held == "" {
				require.ErrorIs(t, err, context.Canceled, "an answered wait reaches the facts")
				assert.True(t, called)
				return
			}
			require.NoError(t, err)
			require.NotNil(t, next)
			assert.Contains(t, next.Reason, tc.held)
			assert.Equal(t, item.State, next.State)
			assert.Equal(t, item.Checks, next.Checks)
			assert.Equal(t, time.Unix(100, 0).Add(mythicalPullPollEvery), next.NextAttemptAt.Time)
			assert.False(t, called)
		})
	}
}

// Publication composes the guards and transport field by field: a merge
// readiness decision composed by the merge route's owner survives it.
func TestEnableTodoPublicationKeepsTheMergeDecision(t *testing.T) {
	decided := errors.New("decided by the merge owner")
	s := &MythicalService{}
	s.outbound.MergeDecision = func(context.Context, db.MythicalItem, MythicalOutboundOp) error { return decided }
	s.EnableTodoPublication(nil, nil, nil)
	require.NotNil(t, s.outbound.MergeDecision)
	require.ErrorIs(t, s.outbound.MergeDecision(context.Background(), db.MythicalItem{}, MythicalOutboundOp{}), decided)
	for name, bound := range map[string]bool{
		"canonical App": s.outbound.CanonicalApp != nil, "stack lease": s.outbound.StackLease != nil, "budget": s.outbound.Budget != nil,
		"membership": s.outbound.Membership != nil, "authorization": s.outbound.Authorization != nil, "accepted generation": s.outbound.AcceptedGeneration != nil,
		"lookup": s.outbound.Lookup != nil, "send": s.outbound.Send != nil, "settle": s.outbound.Settle != nil,
	} {
		assert.True(t, bound, name)
	}
}
