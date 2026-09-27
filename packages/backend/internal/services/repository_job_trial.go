package services

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type RepositoryJobTrialInput struct {
	Repo        string `json:"repo"`
	WorkspaceID string `json:"workspace_id"`
	Revision    int64  `json:"revision"`
	Digest      string `json:"digest"`
	Title       string `json:"title"`
	Body        string `json:"body"`
}

type RepositoryJobTrialResult struct {
	RequestID string `json:"request_id"`
	Source    string `json:"source"`
	Number    int64  `json:"number"`
	IssueID   int64  `json:"issue_id"`
	APIPath   string `json:"api_path"`
}

// CreateTrial makes the real native issue, outbox event and immutable request
// record atomic. A lost HTTP acknowledgement can never create a second issue.
func (s *RepositoryJobService) CreateTrial(ctx context.Context, hostID, bearer, job, requestID string, input RepositoryJobTrialInput) (RepositoryJobTrialResult, error) {
	var empty RepositoryJobTrialResult
	if !repositoryJobNames[job] || strings.TrimSpace(requestID) == "" || len(requestID) > 200 ||
		input.Revision <= 0 || !repositoryJobDigest.MatchString(input.Digest) || strings.TrimSpace(input.Title) == "" || utf8.RuneCountInString(input.Title) > maxIssueTitleLen || len(input.Body) > 500000 {
		return empty, pkgerrors.BadRequest("trial requires an exact request, candidate and issue title")
	}
	if err := validateSafeText("Issue", "title", input.Title); err != nil {
		return empty, err
	}
	if err := validateSafeText("Issue", "body", input.Body); err != nil {
		return empty, err
	}
	repo, target, err := s.authorizeHostCallback(ctx, hostID, bearer, input.Repo, input.WorkspaceID)
	if err != nil {
		return empty, err
	}
	if s.transactions == nil {
		return empty, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository trial transactions unavailable")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, repo.ID); err != nil {
		return empty, err
	}
	q := db.New(tx)
	fresh, err := (&RepositoryJobService{q: q}).authorizedRepo(ctx, repo.ID, target.UserID, true)
	if err != nil {
		return empty, err
	}
	if fresh.UserID != repo.UserID || fresh.OrgID != repo.OrgID || fresh.Name != repo.Name {
		return empty, pkgerrors.Conflict("repository ownership changed")
	}
	if err = q.LockRepositoryJobTrial(ctx, db.LockRepositoryJobTrialParams{RepositoryID: repo.ID, Job: job, RequestID: requestID}); err != nil {
		return empty, err
	}
	trial, err := q.GetRepositoryJobTrial(ctx, db.GetRepositoryJobTrialParams{RepositoryID: repo.ID, Job: job, RequestID: requestID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return empty, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// A person who pressed Trial for exactly this candidate and text (the
		// person-only setup route) files the issue as their own. Anything
		// else is the trial's agent filing: it starts no credentialed work
		// without a maintainer's trigger label or an agentIssueSources rule.
		pressed, err := q.PersonPressedRepositoryTrial(ctx, db.PersonPressedRepositoryTrialParams{RepositoryID: repo.ID, UserID: target.UserID,
			Job: job, RequestID: requestID, WorkspaceID: target.WorkspaceID, Revision: input.Revision, Digest: input.Digest, Title: input.Title, Body: input.Body})
		if err != nil {
			return empty, err
		}
		writer := db.SetIssueTextEditorParams{Source: "trial"}
		if pressed {
			writer = db.SetIssueTextEditorParams{Editor: strconv.FormatInt(target.UserID, 10)}
		}
		if err = q.SetIssueTextEditor(ctx, writer); err != nil {
			return empty, err
		}
		issue, err := q.CreateIssue(ctx, db.CreateIssueParams{RepositoryID: repo.ID, Title: input.Title, Body: input.Body, AuthorID: target.UserID})
		if err != nil {
			return empty, err
		}
		trial, err = q.CreateRepositoryJobTrial(ctx, db.CreateRepositoryJobTrialParams{RepositoryID: repo.ID, Job: job, RequestID: requestID, WorkspaceID: target.WorkspaceID, UserID: target.UserID,
			Revision: input.Revision, Digest: input.Digest, Title: input.Title, Body: input.Body, IssueID: pgtype.Int8{Int64: issue.ID, Valid: true}, IssueNumber: issue.Number})
		if err != nil {
			return empty, err
		}
	} else if trial.UserID != target.UserID || trial.WorkspaceID != target.WorkspaceID || trial.Revision != input.Revision || trial.Digest != input.Digest || trial.Title != input.Title || trial.Body != input.Body {
		return empty, pkgerrors.Conflict("trial request already belongs to a different candidate")
	}
	if !trial.IssueID.Valid {
		return empty, pkgerrors.NotFound("trial issue was deleted")
	}
	if err = tx.Commit(ctx); err != nil {
		return empty, err
	}
	return RepositoryJobTrialResult{RequestID: requestID, Source: "smithers-cloud", Number: trial.IssueNumber, IssueID: trial.IssueID.Int64,
		APIPath: fmt.Sprintf("/repos/%s/issues/%d", input.Repo, trial.IssueNumber)}, nil
}
