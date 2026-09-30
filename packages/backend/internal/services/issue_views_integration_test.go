package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A saved view filters in PostgreSQL before the count and the keyset page:
// an issue qualifies only with every label the view names (case-folded),
// pages continue from the last number without skipping or repeating, and a
// private conversation stays its author's through every view.
func TestIssueViewsFilterCountAndPageInPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	owner, repo := issueCovSeedUserRepo(t, pool)
	other, _ := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	repoID := issueTxRepoID(t, pool, repo)
	_, err := pool.Exec(ctx, `UPDATE repositories SET default_bookmark = 'main' WHERE id = $1`, repoID)
	require.NoError(t, err)
	for _, name := range []string{"Bug", "p1", "docs"} {
		_, err := q.CreateLabel(ctx, db.CreateLabelParams{RepositoryID: repoID, Name: name, Color: "#000000"})
		require.NoError(t, err)
	}
	host := &issueViewHost{factory: `{"issueViews":[
		{"id":"urgent-bugs","title":"Urgent bugs","state":"open","labels":["bug","P1"]},
		{"id":"closed-bugs","title":"Closed bugs","state":"closed","labels":["BUG"]},
		{"id":"everything","title":"Everything","state":"all"}]}`}
	svc := NewIssueService(q, WithIssueFactoryReader(host))
	create := func(title string, labels ...string) int64 {
		issue, err := svc.CreateIssue(ctx, &owner, owner.Username, repo, CreateIssueInput{Title: title, Labels: labels})
		require.NoError(t, err)
		return issue.Number
	}
	urgent := []int64{create("u1", "Bug", "p1"), create("u2", "p1", "Bug", "docs"), create("u3", "Bug", "p1")}
	create("bug only", "Bug")
	create("p1 only", "p1")
	create("nothing")
	closed := create("closed bug", "Bug")
	state := "closed"
	_, err = svc.UpdateIssue(ctx, &owner, owner.Username, repo, closed, UpdateIssueInput{State: &state})
	require.NoError(t, err)
	chat, err := svc.CreateIssue(ctx, &owner, owner.Username, repo, CreateIssueInput{Title: "private", Kind: "chat"})
	require.NoError(t, err)

	numbers := func(items []IssueResponse) []int64 {
		result := make([]int64, 0, len(items))
		for _, item := range items {
			result = append(result, item.Number)
		}
		return result
	}

	first, cursor, total, err := svc.ListIssuesInView(ctx, &owner, owner.Username, repo, "urgent-bugs", 0, 2)
	require.NoError(t, err)
	require.Equal(t, int64(3), total)
	require.Equal(t, []int64{urgent[2], urgent[1]}, numbers(first))
	require.NotEmpty(t, cursor)
	second, cursor, total, err := svc.ListIssuesInView(ctx, &owner, owner.Username, repo, "urgent-bugs", decodeIssueNumberCursor(cursor), 2)
	require.NoError(t, err)
	require.Equal(t, int64(3), total)
	require.Equal(t, []int64{urgent[0]}, numbers(second))
	require.Empty(t, cursor)

	rows, _, total, err := svc.ListIssuesInView(ctx, &owner, owner.Username, repo, "closed-bugs", 0, 30)
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	require.Equal(t, []int64{closed}, numbers(rows))

	rows, _, total, err = svc.ListIssuesInView(ctx, &owner, owner.Username, repo, "everything", 0, 30)
	require.NoError(t, err)
	require.Equal(t, int64(8), total, "the author sees their conversation")
	require.Contains(t, numbers(rows), chat.Number)
	for _, viewer := range []*db.User{nil, &other} {
		rows, _, total, err = svc.ListIssuesInView(ctx, viewer, owner.Username, repo, "everything", 0, 30)
		require.NoError(t, err)
		require.Equal(t, int64(7), total)
		require.NotContains(t, numbers(rows), chat.Number)
	}

	plain, _, total, err := svc.ListIssues(ctx, &owner, owner.Username, repo, 0, 30, "open")
	require.NoError(t, err)
	require.Equal(t, int64(7), total, "the plain list keeps every label")
	require.Len(t, plain, 7)
}
