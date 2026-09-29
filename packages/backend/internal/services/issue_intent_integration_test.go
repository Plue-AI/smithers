package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func intentPatch[T any](value T) *IssuePatch[T] { return &IssuePatch[T]{Value: &value} }

func requireIssueFieldError(t *testing.T, err error, field, code string) {
	t.Helper()
	require.Equal(t, 422, issueAPIStatus(t, err))
	apiErr := err.(*pkgerrors.APIError)
	require.Len(t, apiErr.Errors, 1)
	assert.Equal(t, field, apiErr.Errors[0].Field)
	assert.Equal(t, code, apiErr.Errors[0].Code)
}

// #2186: owner, due date, priority and parent are stored, validated and
// carried on the issue DTO.
func TestIssueIntent_Integration_StoresValidatesAndClears(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repoName := issueCovSeedUserRepo(t, pool)
	queries := db.New(pool)
	svc := NewIssueService(queries)
	create := func(title string) IssueResponse {
		t.Helper()
		issue, err := svc.CreateIssue(ctx, &actor, actor.Username, repoName, CreateIssueInput{Title: title})
		require.NoError(t, err)
		return issue
	}
	update := func(number int64, req UpdateIssueInput) (IssueResponse, error) {
		return svc.UpdateIssue(ctx, &actor, actor.Username, repoName, number, req)
	}
	parent := create("parent")
	child := create("child")
	assert.Nil(t, child.Owner)
	assert.Nil(t, child.Due)
	assert.Nil(t, child.Priority)
	assert.Nil(t, child.Parent)

	set, err := update(child.Number, UpdateIssueInput{
		Owner:    intentPatch(" " + actor.Username + " "),
		Due:      intentPatch("2026-10-01"),
		Priority: intentPatch(int64(0)),
		Parent:   intentPatch(parent.Number),
	})
	require.NoError(t, err)
	require.NotNil(t, set.Owner)
	assert.Equal(t, actor.ID, set.Owner.ID)
	assert.Equal(t, "2026-10-01", *set.Due)
	assert.Equal(t, int16(0), *set.Priority)
	assert.Equal(t, &IssueParentSummary{Number: parent.Number, Title: "parent"}, set.Parent)

	// Another write leaves them alone, and a read returns them.
	_, err = update(child.Number, UpdateIssueInput{Title: intentPatch("renamed").Value})
	require.NoError(t, err)
	read, err := svc.GetIssue(ctx, &actor, actor.Username, repoName, child.Number)
	require.NoError(t, err)
	assert.Equal(t, set.Owner, read.Owner)
	assert.Equal(t, set.Due, read.Due)
	assert.Equal(t, set.Priority, read.Priority)
	assert.Equal(t, set.Parent, read.Parent)

	// Boundaries: priority 3 is the last accepted value.
	three, err := update(child.Number, UpdateIssueInput{Priority: intentPatch(int64(3))})
	require.NoError(t, err)
	assert.Equal(t, int16(3), *three.Priority)

	for name, tc := range map[string]struct {
		req   UpdateIssueInput
		field string
		code  string
	}{
		"unknown owner":       {UpdateIssueInput{Owner: intentPatch("nobody-" + fmt.Sprint(time.Now().UnixNano()))}, "owner", "invalid"},
		"blank owner":         {UpdateIssueInput{Owner: intentPatch("  ")}, "owner", "invalid"},
		"timestamp due":       {UpdateIssueInput{Due: intentPatch("2026-10-01T00:00:00Z")}, "due", "invalid"},
		"impossible due":      {UpdateIssueInput{Due: intentPatch("2026-02-30")}, "due", "invalid"},
		"priority above 3":    {UpdateIssueInput{Priority: intentPatch(int64(4))}, "priority", "invalid"},
		"priority below 0":    {UpdateIssueInput{Priority: intentPatch(int64(-1))}, "priority", "invalid"},
		"unknown parent":      {UpdateIssueInput{Parent: intentPatch(int64(9999))}, "parent", "invalid"},
		"zero parent":         {UpdateIssueInput{Parent: intentPatch(int64(0))}, "parent", "invalid"},
		"self parent":         {UpdateIssueInput{Parent: intentPatch(child.Number)}, "parent", "cycle"},
		"parent forms cycle":  {UpdateIssueInput{Parent: intentPatch(child.Number)}, "parent", "cycle"},
		"refused with others": {UpdateIssueInput{Title: intentPatch("ignored").Value, Priority: intentPatch(int64(9))}, "priority", "invalid"},
	} {
		t.Run(name, func(t *testing.T) {
			number := child.Number
			if name == "parent forms cycle" {
				number = parent.Number
			}
			_, err := update(number, tc.req)
			requireIssueFieldError(t, err, tc.field, tc.code)
		})
	}
	// A refused update wrote nothing.
	after, err := svc.GetIssue(ctx, &actor, actor.Username, repoName, child.Number)
	require.NoError(t, err)
	assert.Equal(t, "renamed", after.Title)
	assert.Equal(t, int16(3), *after.Priority)
	assert.Equal(t, set.Parent, after.Parent)

	// A longer chain: grandchild -> child -> parent; parent -> grandchild loops.
	grandchild := create("grandchild")
	_, err = update(grandchild.Number, UpdateIssueInput{Parent: intentPatch(child.Number)})
	require.NoError(t, err)
	_, err = update(parent.Number, UpdateIssueInput{Parent: intentPatch(grandchild.Number)})
	requireIssueFieldError(t, err, "parent", "cycle")

	cleared, err := update(child.Number, UpdateIssueInput{Owner: &IssuePatch[string]{}, Due: &IssuePatch[string]{}, Priority: &IssuePatch[int64]{}, Parent: &IssuePatch[int64]{}})
	require.NoError(t, err)
	assert.Nil(t, cleared.Owner)
	assert.Nil(t, cleared.Due)
	assert.Nil(t, cleared.Priority)
	assert.Nil(t, cleared.Parent)
	// Once the chain is broken, the former loop is allowed.
	_, err = update(parent.Number, UpdateIssueInput{Parent: intentPatch(grandchild.Number)})
	require.NoError(t, err)
}

// The storage guards hold for any writer, not only the service.
func TestIssueIntent_Integration_StorageGuards(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repoName := issueCovSeedUserRepo(t, pool)
	other, otherRepo := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))
	mine, err := svc.CreateIssue(ctx, &actor, actor.Username, repoName, CreateIssueInput{Title: "mine"})
	require.NoError(t, err)
	theirs, err := svc.CreateIssue(ctx, &other, other.Username, otherRepo, CreateIssueInput{Title: "theirs"})
	require.NoError(t, err)

	constraint := func(err error) string {
		t.Helper()
		var pgErr *pgconn.PgError
		require.ErrorAs(t, err, &pgErr)
		assert.Equal(t, "23514", pgErr.Code)
		return pgErr.ConstraintName
	}
	_, err = pool.Exec(ctx, `UPDATE issues SET parent_id = $1 WHERE id = $2`, theirs.ID, mine.ID)
	assert.Equal(t, "issues_parent_repository", constraint(err))
	_, err = pool.Exec(ctx, `UPDATE issues SET parent_id = id WHERE id = $1`, mine.ID)
	assert.Equal(t, "issues_parent_cycle", constraint(err))
	_, err = pool.Exec(ctx, `UPDATE issues SET priority = 4 WHERE id = $1`, mine.ID)
	assert.Equal(t, "issues_priority_check", constraint(err))

	// Deleting the owner or the parent clears the reference.
	parent, err := svc.CreateIssue(ctx, &actor, actor.Username, repoName, CreateIssueInput{Title: "parent"})
	require.NoError(t, err)
	_, err = svc.UpdateIssue(ctx, &actor, actor.Username, repoName, mine.Number, UpdateIssueInput{Parent: intentPatch(parent.Number)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM issues WHERE id = $1`, parent.ID)
	require.NoError(t, err)
	read, err := svc.GetIssue(ctx, &actor, actor.Username, repoName, mine.Number)
	require.NoError(t, err)
	assert.Nil(t, read.Parent)
}
