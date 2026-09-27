package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type issuesSQLHDB = chunk5SQLHDB
type issuesSQLHRows = chunk5SQLHRows

func TestIssuesSQL_H_ListWrappersRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	authorID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	assigneeID := mustCreateUser(t, pool, uniqueTestUsername(t))

	first := mustCreateIssue(t, q, repoID, authorID, "first issue h")
	second := mustCreateIssue(t, q, repoID, authorID, "second issue h")
	_, err := q.UpdateIssue(ctx, UpdateIssueParams{ID: second.ID, Title: second.Title, Body: second.Body, State: "closed", ClosedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}})
	require.NoError(t, err)

	_, err = q.AddIssueAssignee(ctx, AddIssueAssigneeParams{IssueID: first.ID, UserID: pgtype.Int8{Int64: assigneeID, Valid: true}})
	require.NoError(t, err)
	assignees, err := q.ListIssueAssignees(ctx, first.ID)
	require.NoError(t, err)
	require.Len(t, assignees, 1)
	assert.Equal(t, assigneeID, assignees[0].ID)
	emptyAssignees, err := q.ListIssueAssignees(ctx, second.ID)
	require.NoError(t, err)
	assert.Empty(t, emptyAssignees)

	comment1, err := q.CreateIssueComment(ctx, CreateIssueCommentParams{IssueID: first.ID, UserID: pgtype.Int8{Int64: authorID, Valid: true}, Body: "one", Commenter: "author"})
	require.NoError(t, err)
	comment2, err := q.CreateIssueComment(ctx, CreateIssueCommentParams{IssueID: first.ID, UserID: pgtype.Int8{Int64: assigneeID, Valid: true}, Body: "two", Commenter: "assignee"})
	require.NoError(t, err)
	comments, err := q.ListIssueComments(ctx, ListIssueCommentsParams{IssueID: first.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, comments, 2)
	keyset, err := q.ListIssueCommentsByIssueKeyset(ctx, ListIssueCommentsByIssueKeysetParams{IssueID: first.ID, AfterID: comment1.ID, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, keyset, 1)
	assert.Equal(t, comment2.ID, keyset[0].ID)

	event, err := q.CreateIssueEvent(ctx, CreateIssueEventParams{IssueID: first.ID, ActorID: pgtype.Int8{Int64: authorID, Valid: true}, EventType: "renamed", Payload: json.RawMessage(`{"after":"first"}`)})
	require.NoError(t, err)
	events, err := q.ListIssueEventsByIssue(ctx, ListIssueEventsByIssueParams{IssueID: first.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	// Migration 0039's trg_issue_message_event journals each comment insert as an issue event.
	require.Len(t, events, 3)
	assert.Equal(t, "comment.created", events[0].EventType)
	assert.Equal(t, "comment.created", events[1].EventType)
	assert.Equal(t, event.ID, events[2].ID)

	allIssues, err := q.ListIssuesByRepoFiltered(ctx, ListIssuesByRepoFilteredParams{RepositoryID: repoID, State: "", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, allIssues, 2)
	closed, err := q.ListIssuesByRepoFiltered(ctx, ListIssuesByRepoFilteredParams{RepositoryID: repoID, State: "closed", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, closed, 1)
	assert.Equal(t, second.ID, closed[0].ID)
	firstPage, err := q.ListIssuesByRepoFilteredKeyset(ctx, ListIssuesByRepoFilteredKeysetParams{RepositoryID: repoID, State: "", AfterNumber: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, firstPage, 2)
	nextPage, err := q.ListIssuesByRepoFilteredKeyset(ctx, ListIssuesByRepoFilteredKeysetParams{RepositoryID: repoID, State: "", AfterNumber: second.Number, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, nextPage, 1)
	assert.Equal(t, first.ID, nextPage[0].ID)
	empty, err := q.ListIssueEventsByIssue(ctx, ListIssueEventsByIssueParams{IssueID: second.ID, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, empty)
}

func TestIssuesSQL_H_ListErrorBranches(t *testing.T) {
	sentinel := errors.New("issues h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListIssueAssignees", func(q *Queries) error { _, err := q.ListIssueAssignees(context.Background(), 1); return err }},
		{"ListIssueComments", func(q *Queries) error {
			_, err := q.ListIssueComments(context.Background(), ListIssueCommentsParams{IssueID: 1, PageSize: 1})
			return err
		}},
		{"ListIssueCommentsByIssueKeyset", func(q *Queries) error {
			_, err := q.ListIssueCommentsByIssueKeyset(context.Background(), ListIssueCommentsByIssueKeysetParams{IssueID: 1, PageSize: 1})
			return err
		}},
		{"ListIssueEventsByIssue", func(q *Queries) error {
			_, err := q.ListIssueEventsByIssue(context.Background(), ListIssueEventsByIssueParams{IssueID: 1, PageSize: 1})
			return err
		}},
		{"ListIssuesByRepoFiltered", func(q *Queries) error {
			_, err := q.ListIssuesByRepoFiltered(context.Background(), ListIssuesByRepoFilteredParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListIssuesByRepoFilteredKeyset", func(q *Queries) error {
			_, err := q.ListIssuesByRepoFilteredKeyset(context.Background(), ListIssuesByRepoFilteredKeysetParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
	}
	for _, tc := range cases {
		require.ErrorIs(t, tc.call(New(issuesSQLHDB{queryErr: sentinel})), sentinel, tc.name+" query")
		require.ErrorIs(t, tc.call(New(issuesSQLHDB{rows: &issuesSQLHRows{next: true, scanErr: sentinel}})), sentinel, tc.name+" scan")
		require.ErrorIs(t, tc.call(New(issuesSQLHDB{rows: &issuesSQLHRows{err: sentinel}})), sentinel, tc.name+" rows")
	}
}
