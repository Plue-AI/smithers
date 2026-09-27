package services

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

func zIssueBaseQuerier(overrides ...func(*mockIssueQuerier)) *mockIssueQuerier {
	repo := issueRepo(nil)
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		countLabelsForIssueFn: func(context.Context, int64) (int64, error) {
			return 0, nil
		},
	}
	for _, override := range overrides {
		override(q)
	}
	return q
}

func zIssueComment(id, issueID int64) db.IssueComment {
	return db.IssueComment{
		ID:        id,
		IssueID:   issueID,
		UserID:    pgtype.Int8{Int64: 1, Valid: true},
		Commenter: "alice",
		Body:      "comment",
		Type:      "comment",
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
}

func TestIssue_Z_OptionsCursorsAndListBranches(t *testing.T) {
	mentionSvc := NewMentionService(&mockMentionQuerier{}, nil)
	notifSvc := NewNotificationService(&mockNotificationQuerier{})
	svc := NewIssueService(nil, WithIssueMentionService(mentionSvc), WithIssueNotificationService(notifSvc), nil)
	require.Same(t, mentionSvc, svc.mentionSvc)
	require.Same(t, notifSvc, svc.notifSvc)

	require.Equal(t, int64(12), decodeIssueNumberCursor("12"))
	require.Zero(t, decodeIssueNumberCursor("x"))
	require.Zero(t, decodeIssueNumberCursor(base64.RawURLEncoding.EncodeToString([]byte("-2"))))

	_, _, _, err := NewIssueService(&mockIssueQuerier{}).ListIssues(context.Background(), nil, "alice", "demo", 0, 1, "open")
	require.Equal(t, 404, issueAPIStatus(t, err))

	_, _, _, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.countIssuesByRepoFilteredFn = func(context.Context, db.CountIssuesByRepoFilteredParams) (int64, error) {
			return 0, errors.New("boom")
		}
	})).ListIssues(context.Background(), nil, "alice", "demo", 0, 1, "open")
	require.Equal(t, 500, issueAPIStatus(t, err))

	_, _, _, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.listIssuesByRepoFilteredKeysetFn = func(context.Context, db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error) {
			return nil, errors.New("boom")
		}
	})).ListIssues(context.Background(), nil, "alice", "demo", 0, 1, "open")
	require.Equal(t, 500, issueAPIStatus(t, err))

	_, _, _, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("boom")
		}
	})).ListIssues(context.Background(), nil, "alice", "demo", 0, 1, "open")
	require.Equal(t, 500, issueAPIStatus(t, err))

	rows := make([]db.Issue, maxPerPage)
	for i := range rows {
		rows[i] = issueDBRecord(int64(i+1), 77, int64(maxPerPage-i), 1, nil)
	}
	items, next, total, err := NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.countIssuesByRepoFilteredFn = func(context.Context, db.CountIssuesByRepoFilteredParams) (int64, error) {
			return int64(len(rows)), nil
		}
		q.listIssuesByRepoFilteredKeysetFn = func(context.Context, db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error) {
			return rows, nil
		}
	})).ListIssues(context.Background(), nil, "alice", "demo", 0, maxPerPage+1, "all")
	require.NoError(t, err)
	require.Len(t, items, maxPerPage)
	require.NotEmpty(t, next)
	require.Equal(t, int64(maxPerPage), total)

	_, _, _, err = NewIssueService(zIssueBaseQuerier()).ListIssues(context.Background(), nil, "alice", "demo", 0, 0, "open")
	require.NoError(t, err)
}

func TestIssue_Z_CreateIssueBranches(t *testing.T) {
	actor := issueTestUser(1, "alice")
	boom := errors.New("boom")

	for _, req := range []CreateIssueInput{
		{Title: "bad\x00title"},
		{Title: "title", Body: "bad\x00body"},
	} {
		_, err := NewIssueService(zIssueBaseQuerier()).CreateIssue(context.Background(), actor, "alice", "demo", req)
		require.Equal(t, 422, issueAPIStatus(t, err))
	}

	_, err := NewIssueService(&mockIssueQuerier{}).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "title"})
	require.Equal(t, 404, issueAPIStatus(t, err))

	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := issueRepo(nil)
			repo.UserID = pgtype.Int8{Int64: 2, Valid: true}
			return repo, nil
		}
	})).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "title"})
	require.Equal(t, 403, issueAPIStatus(t, err))

	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.createIssueFn = func(context.Context, db.CreateIssueParams) (db.Issue, error) {
			return db.Issue{}, boom
		}
	})).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "title"})
	require.Equal(t, 500, issueAPIStatus(t, err))

	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getUserByLowerUsernameFn = func(context.Context, string) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		}
	})).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "title", Assignees: []string{"nobody"}})
	require.Equal(t, 422, issueAPIStatus(t, err))

	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
			return db.User{}, boom
		}
	})).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "title"})
	require.Equal(t, 500, issueAPIStatus(t, err))

	dispatcher := &mockIssueDispatcher{dispatchFn: func(context.Context, int64, webhooks.EventType, any) error {
		return boom
	}}
	_, err = NewIssueService(zIssueBaseQuerier(), WithIssueWebhookDispatcher(dispatcher)).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "title"})
	require.Equal(t, 500, issueAPIStatus(t, err))

	_, err = NewIssueService(
		zIssueBaseQuerier(),
		WithIssueMentionService(NewMentionService(&mockMentionQuerier{}, nil)),
		WithIssueNotificationService(NewNotificationService(&mockNotificationQuerier{})),
	).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "title", Body: "plain body"})
	require.NoError(t, err)
}

func TestIssue_Z_UpdateIssueBranches(t *testing.T) {
	actor := issueTestUser(1, "alice")
	boom := errors.New("boom")
	title := "next"
	empty := "  "
	tooLong := strings.Repeat("x", maxIssueTitleLen+1)
	unsafe := "bad\x00text"
	body := "bad\x00body"
	badState := "merged"
	closed := "closed"
	open := "open"

	_, err := NewIssueService(zIssueBaseQuerier()).UpdateIssue(context.Background(), nil, "alice", "demo", 1, UpdateIssueInput{})
	require.Equal(t, 401, issueAPIStatus(t, err))
	_, err = NewIssueService(&mockIssueQuerier{}).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{})
	require.Equal(t, 404, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := issueRepo(nil)
			repo.UserID = pgtype.Int8{Int64: 2, Valid: true}
			return repo, nil
		}
	})).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{})
	require.Equal(t, 403, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueByNumberFn = func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{}, pgx.ErrNoRows
		}
	})).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{})
	require.Equal(t, 404, issueAPIStatus(t, err))

	for _, req := range []UpdateIssueInput{
		{Title: &empty},
		{Title: &tooLong},
		{Title: &unsafe},
		{Body: &body},
		{State: &badState},
	} {
		_, err := NewIssueService(zIssueBaseQuerier()).UpdateIssue(context.Background(), actor, "alice", "demo", 1, req)
		require.Equal(t, 422, issueAPIStatus(t, err))
	}

	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.updateIssueFn = func(context.Context, db.UpdateIssueParams) (db.Issue, error) {
			return db.Issue{}, boom
		}
	})).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{Title: &title})
	require.Equal(t, 500, issueAPIStatus(t, err))

	// num_closed_issues maintenance moved into database triggers
	// (trg_issues_repo_counts_upd); close and reopen transitions have no
	// service-side counter error branch anymore.
	_, err = NewIssueService(zIssueBaseQuerier()).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{State: &closed})
	require.NoError(t, err)

	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueByNumberFn = func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return issueDBRecord(1, 77, 1, 1, func(i *db.Issue) {
				i.State = "closed"
				i.ClosedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			}), nil
		}
	})).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{State: &open})
	require.NoError(t, err)

	labels := []string{"missing"}
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.listLabelsByNamesFn = func(context.Context, db.ListLabelsByNamesParams) ([]db.Label, error) {
			return nil, nil
		}
	})).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{Labels: &labels})
	require.Equal(t, 422, issueAPIStatus(t, err))

	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
			return db.User{}, boom
		}
	})).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{Title: &title})
	require.Equal(t, 500, issueAPIStatus(t, err))

	dispatcher := &mockIssueDispatcher{dispatchFn: func(context.Context, int64, webhooks.EventType, any) error {
		return boom
	}}
	_, err = NewIssueService(zIssueBaseQuerier(), WithIssueWebhookDispatcher(dispatcher)).UpdateIssue(context.Background(), actor, "alice", "demo", 1, UpdateIssueInput{Title: &title})
	require.Equal(t, 500, issueAPIStatus(t, err))
}

func TestIssue_Z_GetAndListCommentBranches(t *testing.T) {
	viewer := issueTestUser(1, "alice")
	boom := errors.New("boom")

	_, err := NewIssueService(zIssueBaseQuerier()).GetIssue(context.Background(), viewer, "alice", "demo", 1)
	require.NoError(t, err)
	_, err = NewIssueService(&mockIssueQuerier{}).GetIssue(context.Background(), viewer, "alice", "demo", 1)
	require.Equal(t, 404, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return issueRepo(func(r *db.Repository) {
				r.IsPublic = false
			}), nil
		}
	})).GetIssue(context.Background(), nil, "alice", "demo", 1)
	require.Equal(t, 403, issueAPIStatus(t, err))

	_, err = NewIssueService(zIssueBaseQuerier()).GetIssueComment(context.Background(), viewer, "alice", "demo", 0)
	require.Equal(t, 400, issueAPIStatus(t, err))
	_, err = NewIssueService(&mockIssueQuerier{}).GetIssueComment(context.Background(), viewer, "alice", "demo", 1)
	require.Equal(t, 404, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return issueRepo(func(r *db.Repository) {
				r.IsPublic = false
			}), nil
		}
	})).GetIssueComment(context.Background(), nil, "alice", "demo", 1)
	require.Equal(t, 403, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueByCommentIDFn = func(context.Context, int64) (db.Issue, error) {
			return db.Issue{}, pgx.ErrNoRows
		}
	})).GetIssueComment(context.Background(), viewer, "alice", "demo", 1)
	require.Equal(t, 404, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueByCommentIDFn = func(context.Context, int64) (db.Issue, error) {
			return db.Issue{}, boom
		}
	})).GetIssueComment(context.Background(), viewer, "alice", "demo", 1)
	require.Equal(t, 500, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueCommentByIDFn = func(context.Context, int64) (db.IssueComment, error) {
			return db.IssueComment{}, pgx.ErrNoRows
		}
	})).GetIssueComment(context.Background(), viewer, "alice", "demo", 1)
	require.Equal(t, 404, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueCommentByIDFn = func(context.Context, int64) (db.IssueComment, error) {
			return db.IssueComment{}, boom
		}
	})).GetIssueComment(context.Background(), viewer, "alice", "demo", 1)
	require.Equal(t, 500, issueAPIStatus(t, err))

	_, _, _, err = NewIssueService(&mockIssueQuerier{}).ListIssueComments(context.Background(), viewer, "alice", "demo", 1, 0, 1)
	require.Equal(t, 404, issueAPIStatus(t, err))
	_, _, _, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.countIssueCommentsByIssueFn = func(context.Context, int64) (int64, error) {
			return 0, boom
		}
	})).ListIssueComments(context.Background(), viewer, "alice", "demo", 1, 0, 1)
	require.Equal(t, 500, issueAPIStatus(t, err))
	_, _, _, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.listIssueCommentsKeysetFn = func(context.Context, db.ListIssueCommentsByIssueKeysetParams) ([]db.IssueComment, error) {
			return nil, boom
		}
	})).ListIssueComments(context.Background(), viewer, "alice", "demo", 1, 0, 1)
	require.Equal(t, 500, issueAPIStatus(t, err))

	comments := make([]db.IssueComment, maxPerPage)
	for i := range comments {
		comments[i] = zIssueComment(int64(i+1), 1)
	}
	items, next, total, err := NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.countIssueCommentsByIssueFn = func(context.Context, int64) (int64, error) {
			return int64(len(comments)), nil
		}
		q.listIssueCommentsKeysetFn = func(context.Context, db.ListIssueCommentsByIssueKeysetParams) ([]db.IssueComment, error) {
			return comments, nil
		}
	})).ListIssueComments(context.Background(), viewer, "alice", "demo", 1, 0, maxPerPage+1)
	require.NoError(t, err)
	require.Len(t, items, maxPerPage)
	require.NotEmpty(t, next)
	require.Equal(t, int64(maxPerPage), total)

	_, _, _, err = NewIssueService(zIssueBaseQuerier()).ListIssueComments(context.Background(), viewer, "alice", "demo", 1, 0, 0)
	require.NoError(t, err)
}

func TestIssue_Z_CreateUpdateDeleteCommentBranches(t *testing.T) {
	actor := issueTestUser(1, "alice")
	boom := errors.New("boom")

	_, err := NewIssueService(zIssueBaseQuerier()).CreateIssueComment(context.Background(), nil, "alice", "demo", 1, CreateIssueCommentInput{Body: "body"})
	require.Equal(t, 401, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier()).CreateIssueComment(context.Background(), actor, "alice", "demo", 1, CreateIssueCommentInput{Body: "   "})
	require.Equal(t, 422, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier()).CreateIssueComment(context.Background(), actor, "alice", "demo", 1, CreateIssueCommentInput{Body: "bad\x00body"})
	require.Equal(t, 422, issueAPIStatus(t, err))
	_, err = NewIssueService(&mockIssueQuerier{}).CreateIssueComment(context.Background(), actor, "alice", "demo", 1, CreateIssueCommentInput{Body: "body"})
	require.Equal(t, 404, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.createIssueCommentFn = func(context.Context, db.CreateIssueCommentParams) (db.IssueComment, error) {
			return db.IssueComment{}, boom
		}
	})).CreateIssueComment(context.Background(), actor, "alice", "demo", 1, CreateIssueCommentInput{Body: "body"})
	require.Equal(t, 500, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(), WithIssueMentionService(NewMentionService(&mockMentionQuerier{}, nil))).CreateIssueComment(context.Background(), actor, "alice", "demo", 1, CreateIssueCommentInput{Body: "body"})
	require.NoError(t, err)

	_, err = NewIssueService(zIssueBaseQuerier()).UpdateIssueComment(context.Background(), nil, "alice", "demo", 1, UpdateIssueCommentInput{Body: "body"})
	require.Equal(t, 401, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier()).UpdateIssueComment(context.Background(), actor, "alice", "demo", 1, UpdateIssueCommentInput{Body: "  "})
	require.Equal(t, 422, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier()).UpdateIssueComment(context.Background(), actor, "alice", "demo", 1, UpdateIssueCommentInput{Body: "bad\x00body"})
	require.Equal(t, 422, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier()).UpdateIssueComment(context.Background(), actor, "alice", "demo", 0, UpdateIssueCommentInput{Body: "body"})
	require.Equal(t, 400, issueAPIStatus(t, err))
	_, err = NewIssueService(&mockIssueQuerier{}).UpdateIssueComment(context.Background(), actor, "alice", "demo", 1, UpdateIssueCommentInput{Body: "body"})
	require.Equal(t, 404, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := issueRepo(nil)
			repo.UserID = pgtype.Int8{Int64: 2, Valid: true}
			return repo, nil
		}
	})).UpdateIssueComment(context.Background(), actor, "alice", "demo", 1, UpdateIssueCommentInput{Body: "body"})
	require.Equal(t, 403, issueAPIStatus(t, err))
	for _, branchErr := range []error{pgx.ErrNoRows, boom} {
		_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
			q.getIssueByCommentIDFn = func(context.Context, int64) (db.Issue, error) {
				return db.Issue{}, branchErr
			}
		})).UpdateIssueComment(context.Background(), actor, "alice", "demo", 1, UpdateIssueCommentInput{Body: "body"})
		if errors.Is(branchErr, pgx.ErrNoRows) {
			require.Equal(t, 404, issueAPIStatus(t, err))
		} else {
			require.Equal(t, 500, issueAPIStatus(t, err))
		}
	}
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueByCommentIDFn = func(context.Context, int64) (db.Issue, error) {
			return issueDBRecord(1, 88, 1, 1, nil), nil
		}
	})).UpdateIssueComment(context.Background(), actor, "alice", "demo", 1, UpdateIssueCommentInput{Body: "body"})
	require.Equal(t, 404, issueAPIStatus(t, err))
	for _, branchErr := range []error{pgx.ErrNoRows, boom} {
		_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
			q.updateIssueCommentFn = func(context.Context, db.UpdateIssueCommentParams) (db.IssueComment, error) {
				return db.IssueComment{}, branchErr
			}
		})).UpdateIssueComment(context.Background(), actor, "alice", "demo", 1, UpdateIssueCommentInput{Body: "body"})
		if errors.Is(branchErr, pgx.ErrNoRows) {
			require.Equal(t, 404, issueAPIStatus(t, err))
		} else {
			require.Equal(t, 500, issueAPIStatus(t, err))
		}
	}

	require.Equal(t, 401, issueAPIStatus(t, NewIssueService(zIssueBaseQuerier()).DeleteIssueComment(context.Background(), nil, "alice", "demo", 1)))
	require.Equal(t, 400, issueAPIStatus(t, NewIssueService(zIssueBaseQuerier()).DeleteIssueComment(context.Background(), actor, "alice", "demo", 0)))
	require.Equal(t, 404, issueAPIStatus(t, NewIssueService(&mockIssueQuerier{}).DeleteIssueComment(context.Background(), actor, "alice", "demo", 1)))
	require.Equal(t, 403, issueAPIStatus(t, NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := issueRepo(nil)
			repo.UserID = pgtype.Int8{Int64: 2, Valid: true}
			return repo, nil
		}
	})).DeleteIssueComment(context.Background(), actor, "alice", "demo", 1)))
	for _, branchErr := range []error{pgx.ErrNoRows, boom} {
		err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
			q.getIssueByCommentIDFn = func(context.Context, int64) (db.Issue, error) {
				return db.Issue{}, branchErr
			}
		})).DeleteIssueComment(context.Background(), actor, "alice", "demo", 1)
		if errors.Is(branchErr, pgx.ErrNoRows) {
			require.Equal(t, 404, issueAPIStatus(t, err))
		} else {
			require.Equal(t, 500, issueAPIStatus(t, err))
		}
	}
	require.Equal(t, 404, issueAPIStatus(t, NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueByCommentIDFn = func(context.Context, int64) (db.Issue, error) {
			return issueDBRecord(1, 88, 1, 1, nil), nil
		}
	})).DeleteIssueComment(context.Background(), actor, "alice", "demo", 1)))
	require.Equal(t, 500, issueAPIStatus(t, NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueCommentByIDFn = func(context.Context, int64) (db.IssueComment, error) {
			return db.IssueComment{}, boom
		}
	})).DeleteIssueComment(context.Background(), actor, "alice", "demo", 1)))
	require.Equal(t, 500, issueAPIStatus(t, NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.deleteIssueCommentFn = func(context.Context, int64) error {
			return boom
		}
	})).DeleteIssueComment(context.Background(), actor, "alice", "demo", 1)))
	require.NoError(t, NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueCommentByIDFn = func(context.Context, int64) (db.IssueComment, error) {
			return db.IssueComment{}, pgx.ErrNoRows
		}
	})).DeleteIssueComment(context.Background(), actor, "alice", "demo", 1))
}

func TestIssue_Z_HelperBranches(t *testing.T) {
	actor := issueTestUser(1, "alice")
	boom := errors.New("boom")
	svc := NewIssueService(zIssueBaseQuerier())

	_, _, err := svc.resolveReadableIssue(context.Background(), nil, "alice", "demo", 0)
	require.Equal(t, 400, issueAPIStatus(t, err))
	_, _, err = svc.resolveWritableIssue(context.Background(), actor, "alice", "demo", 0)
	require.Equal(t, 400, issueAPIStatus(t, err))
	_, _, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return issueRepo(func(r *db.Repository) {
				r.IsPublic = false
			}), nil
		}
	})).resolveReadableIssue(context.Background(), nil, "alice", "demo", 1)
	require.Equal(t, 403, issueAPIStatus(t, err))
	_, _, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return issueRepo(func(r *db.Repository) {
				r.UserID = pgtype.Int8{Int64: 2, Valid: true}
			}), nil
		}
	})).resolveWritableIssue(context.Background(), actor, "alice", "demo", 1)
	require.Equal(t, 403, issueAPIStatus(t, err))

	_, err = svc.getIssueByNumber(context.Background(), 77, 0)
	require.Equal(t, 400, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getIssueByNumberFn = func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{}, boom
		}
	})).getIssueByNumber(context.Background(), 77, 1)
	require.Equal(t, 500, issueAPIStatus(t, err))

	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.listIssueAssigneesFn = func(context.Context, int64) ([]db.ListIssueAssigneesRow, error) {
			return nil, boom
		}
	})).mapIssue(context.Background(), issueDBRecord(1, 77, 1, 1, nil))
	require.Equal(t, 500, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.countLabelsForIssueFn = func(context.Context, int64) (int64, error) {
			return 0, boom
		}
	})).mapIssue(context.Background(), issueDBRecord(1, 77, 1, 1, nil))
	require.Equal(t, 500, issueAPIStatus(t, err))

	dispatcher := &mockIssueDispatcher{dispatchFn: func(context.Context, int64, webhooks.EventType, any) error {
		return boom
	}}
	err = NewIssueService(zIssueBaseQuerier(), WithIssueWebhookDispatcher(dispatcher)).dispatchIssueEvent(context.Background(), "alice", issueRepo(nil), actor, "opened", IssueResponse{ID: 1, Number: 1})
	require.Equal(t, 500, issueAPIStatus(t, err))
	err = NewIssueService(zIssueBaseQuerier(), WithIssueWebhookDispatcher(dispatcher)).dispatchIssueCommentEvent(context.Background(), "alice", issueRepo(nil), actor, issueDBRecord(1, 77, 1, 1, nil), "created", IssueCommentResponse{ID: 1})
	require.Equal(t, 500, issueAPIStatus(t, err))

	payload := NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
			return db.User{}, boom
		}
	})).issuePayloadForDispatch(context.Background(), issueDBRecord(1, 77, 1, 1, nil))
	require.Equal(t, int64(1), payload.ID)
	require.Zero(t, issueSenderPayload(nil).ID)

	_, err = svc.resolveAssigneeUserIDs(context.Background(), []string{" "})
	require.Equal(t, 422, issueAPIStatus(t, err))
	assignees := []int64{99}
	err = replaceIssueAssociations(context.Background(), nonTxIssueWriteTx{q: zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.replaceIssueAssigneesFn = func(context.Context, db.ReplaceIssueAssigneesParams) error {
			return boom
		}
	})}, 1, 2, &assignees, nil)
	require.Equal(t, 500, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getUserByLowerUsernameFn = func(context.Context, string) (db.User, error) {
			return db.User{}, boom
		}
	})).resolveAssigneeUserIDs(context.Background(), []string{"bob"})
	require.Equal(t, 500, issueAPIStatus(t, err))
	labelSet := []int64{1}
	err = replaceIssueAssociations(context.Background(), nonTxIssueWriteTx{q: zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.replaceIssueLabelsFn = func(context.Context, db.ReplaceIssueLabelsParams) error {
			return boom
		}
	})}, 1, 2, nil, &labelSet)
	require.Equal(t, 500, issueAPIStatus(t, err))
	untouched := zIssueBaseQuerier()
	require.NoError(t, replaceIssueAssociations(context.Background(), nonTxIssueWriteTx{q: untouched}, 1, 2, nil, nil))
	require.Nil(t, untouched.lastReplaceAssigneesArg)
	require.Nil(t, untouched.lastReplaceLabelsArg)
	_, err = NewIssueService(zIssueBaseQuerier()).resolveLabelIDs(context.Background(), 77, []string{" "})
	require.Equal(t, 422, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.listLabelsByNamesFn = func(context.Context, db.ListLabelsByNamesParams) ([]db.Label, error) {
			return nil, boom
		}
	})).resolveLabelIDs(context.Background(), 77, []string{"bug"})
	require.Equal(t, 500, issueAPIStatus(t, err))

	labels, err := NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.countLabelsForIssueFn = func(context.Context, int64) (int64, error) {
			return 2, nil
		}
		q.listLabelsForIssueFn = func(context.Context, db.ListLabelsForIssueParams) ([]db.Label, error) {
			return nil, nil
		}
	})).listAllLabelsForIssue(context.Background(), 1)
	require.NoError(t, err)
	require.Empty(t, labels)
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.countLabelsForIssueFn = func(context.Context, int64) (int64, error) {
			return 2, nil
		}
		q.listLabelsForIssueFn = func(context.Context, db.ListLabelsForIssueParams) ([]db.Label, error) {
			return nil, boom
		}
	})).listAllLabelsForIssue(context.Background(), 1)
	require.Equal(t, 500, issueAPIStatus(t, err))

	milestone := int64(1)
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getMilestoneByIDFn = func(context.Context, db.GetMilestoneByIDParams) (db.Milestone, error) {
			return db.Milestone{}, boom
		}
	})).resolveIssueMilestone(context.Background(), 77, &milestone)
	require.Equal(t, 500, issueAPIStatus(t, err))

	_, err = svc.resolveRepoByOwnerAndName(context.Background(), "", "demo")
	require.Equal(t, 400, issueAPIStatus(t, err))
	_, err = svc.resolveRepoByOwnerAndName(context.Background(), "alice", "")
	require.Equal(t, 400, issueAPIStatus(t, err))
	_, err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, boom
		}
	})).resolveRepoByOwnerAndName(context.Background(), "alice", "demo")
	require.Equal(t, 500, issueAPIStatus(t, err))

	privateRepo := issueRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: 2, Valid: true}
	})
	err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getCollaboratorPermissionForRepoFn = func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", boom
		}
	})).requireReadAccess(context.Background(), privateRepo, actor)
	require.Equal(t, 500, issueAPIStatus(t, err))
	err = NewIssueService(zIssueBaseQuerier()).requireReadAccess(context.Background(), privateRepo, actor)
	require.Equal(t, 403, issueAPIStatus(t, err))
	err = NewIssueService(zIssueBaseQuerier(func(q *mockIssueQuerier) {
		q.getCollaboratorPermissionForRepoFn = func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", boom
		}
	})).requireWriteAccess(context.Background(), privateRepo, actor)
	require.Equal(t, 500, issueAPIStatus(t, err))
	err = NewIssueService(zIssueBaseQuerier()).requireWriteAccess(context.Background(), privateRepo, actor)
	require.Equal(t, 403, issueAPIStatus(t, err))
}
