package services

import (
	"context"
	"fmt"
	"path"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// BookmarkProtectionQuerier is the minimal query surface needed to evaluate
// protected-bookmark rules against a bookmark name.
type BookmarkProtectionQuerier interface {
	ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
}

// RequireBookmarkNotProtected rejects direct mutations (bookmark API
// create/delete, git push ref updates) of any bookmark matching a
// protected-bookmark pattern. Protected bookmarks may only move through the
// landing queue, where review/status-check policy is enforced; every other
// mutation path would bypass that policy.
func RequireBookmarkNotProtected(ctx context.Context, q BookmarkProtectionQuerier, repositoryID int64, bookmark string) error {
	if isMythicalBookmark(bookmark) {
		return errMythicalBookmarkOwned
	}
	rules, err := q.ListAllProtectedBookmarksByRepo(ctx, repositoryID)
	if err != nil {
		return pkgerrors.Internal("failed to list protected bookmarks").WithCause(err)
	}
	for _, rule := range rules {
		matches, err := bookmarkMatchesPattern(rule.Pattern, bookmark)
		if err != nil {
			return pkgerrors.Internal("invalid protected bookmark pattern").WithCause(err)
		}
		if matches {
			return pkgerrors.Forbidden(fmt.Sprintf("bookmark %q is protected; changes must go through a landing request", bookmark))
		}
	}
	return nil
}

// bookmarkMatchesPattern matches a protected-bookmark pattern the way refs
// are compared (repohost.RefKey): a case variant of a protected bookmark is
// that bookmark.
func bookmarkMatchesPattern(pattern, bookmark string) (bool, error) {
	return path.Match(repohost.RefKey(pattern), repohost.RefKey(bookmark))
}

// isMythicalBookmark reports whether bookmark names the mythical stack.
func isMythicalBookmark(bookmark string) bool {
	return repohost.SameRef(bookmark, MythicalBookmark)
}

// RequireAgentRunOffDefaultBookmark refuses an agent run's credential any
// direct write of the default bookmark: an agent's work reaches it only
// through a landing, the stack service or the GitHub main pull. A person's and
// the platform's sync credential are not affected; the mythical bookmark is
// refused to everyone by RequireBookmarkNotProtected.
func RequireAgentRunOffDefaultBookmark(kind middleware.CredentialKind, defaultBookmark, bookmark string) error {
	if kind == middleware.CredentialAgentRun && repohost.SameRef(bookmark, defaultBookmark) {
		return pkgerrors.Forbidden(fmt.Sprintf("an agent run cannot write the default bookmark %q; land its changes instead", bookmark))
	}
	return nil
}

// BookmarkNameFromRef maps a git ref to its bookmark name. It returns false
// for refs outside refs/heads/ (tags, notes, ...), which are not subject to
// bookmark protection.
func BookmarkNameFromRef(ref string) (string, bool) {
	const heads = "refs/heads/"
	ref = strings.TrimSpace(ref)
	// Without case, like every ref comparison (repohost.RefKey).
	if len(ref) <= len(heads) || !repohost.SameRef(ref[:len(heads)], heads) {
		return "", false
	}
	return ref[len(heads):], true
}

type UpsertProtectedBookmarkInput struct {
	Pattern                string   `json:"pattern"`
	RequireReview          bool     `json:"require_review"`
	RequireHumanApprovals  int64    `json:"require_human_approvals"`
	RequireAgentLGTM       bool     `json:"require_agent_lgtm"`
	RequireStatusChecks    bool     `json:"require_status_checks"`
	RequiredStatusContexts []string `json:"required_status_contexts"`
}

type ProtectedBookmarkResponse struct {
	ID                     int64    `json:"id"`
	Pattern                string   `json:"pattern"`
	RequireReview          bool     `json:"require_review"`
	RequireHumanApprovals  int64    `json:"require_human_approvals"`
	RequireAgentLGTM       bool     `json:"require_agent_lgtm"`
	RequireStatusChecks    bool     `json:"require_status_checks"`
	RequiredStatusContexts []string `json:"required_status_contexts"`
}

type ProtectedBookmarkQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	UpsertProtectedBookmark(ctx context.Context, arg db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error)
	ListProtectedBookmarksByRepo(ctx context.Context, arg db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error)
	DeleteProtectedBookmarkByPattern(ctx context.Context, arg db.DeleteProtectedBookmarkByPatternParams) (int64, error)
}

type ProtectedBookmarkService struct {
	queries ProtectedBookmarkQuerier
}

func NewProtectedBookmarkService(q ProtectedBookmarkQuerier) *ProtectedBookmarkService {
	return &ProtectedBookmarkService{queries: q}
}

func (s *ProtectedBookmarkService) UpsertProtectedBookmark(ctx context.Context, actor *db.User, owner, repo string, input UpsertProtectedBookmarkInput) (ProtectedBookmarkResponse, error) {
	if actor == nil {
		return ProtectedBookmarkResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	repository, err := s.resolveRepo(ctx, owner, repo)
	if err != nil {
		return ProtectedBookmarkResponse{}, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return ProtectedBookmarkResponse{}, err
	}

	pattern := strings.TrimSpace(input.Pattern)
	if pattern == "" {
		return ProtectedBookmarkResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "ProtectedBookmark", Field: "pattern", Code: "missing_field"})
	}
	// pattern is stored in protected_bookmarks.pattern VARCHAR(255); reject
	// over-length and NUL/invalid-UTF8 up front so an over-long or malformed value
	// does not fail the INSERT (SQLSTATE 22001/22021) as an opaque 500.
	if len(pattern) > 255 {
		return ProtectedBookmarkResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "ProtectedBookmark", Field: "pattern", Code: "invalid"})
	}
	if err := validateSafeText("ProtectedBookmark", "pattern", pattern); err != nil {
		return ProtectedBookmarkResponse{}, err
	}
	// RequireBookmarkNotProtected evaluates every stored pattern with
	// path.Match on each push and bookmark mutation, and a malformed glob fails
	// that check for the whole repository. Reject it here instead.
	if _, err := path.Match(pattern, ""); err != nil {
		return ProtectedBookmarkResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "ProtectedBookmark", Field: "pattern", Code: "invalid"})
	}
	if input.RequireHumanApprovals < 0 {
		return ProtectedBookmarkResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "ProtectedBookmark", Field: "require_human_approvals", Code: "invalid"})
	}

	contexts := input.RequiredStatusContexts
	if contexts == nil {
		contexts = []string{}
	}

	row, err := s.queries.UpsertProtectedBookmark(ctx, db.UpsertProtectedBookmarkParams{
		RepositoryID:           repository.ID,
		Pattern:                pattern,
		RequireReview:          input.RequireReview,
		RequireHumanApprovals:  input.RequireHumanApprovals,
		RequireAgentLgtm:       input.RequireAgentLGTM,
		RequireStatusChecks:    input.RequireStatusChecks,
		RequiredStatusContexts: contexts,
	})
	if err != nil {
		return ProtectedBookmarkResponse{}, pkgerrors.Internal("failed to upsert protected bookmark").WithCause(err)
	}

	return mapProtectedBookmark(row), nil
}

func (s *ProtectedBookmarkService) ListProtectedBookmarks(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]ProtectedBookmarkResponse, error) {
	repository, err := s.resolveRepo(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireAdminAccess(ctx, repository, viewer); err != nil {
		return nil, err
	}

	pageSize := int32(perPage)
	if pageSize <= 0 {
		pageSize = 30
	}
	pageOffset := int32((page - 1) * int(pageSize))
	if pageOffset < 0 {
		pageOffset = 0
	}

	rows, err := s.queries.ListProtectedBookmarksByRepo(ctx, db.ListProtectedBookmarksByRepoParams{
		RepositoryID: repository.ID,
		PageOffset:   pageOffset,
		PageSize:     pageSize,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list protected bookmarks").WithCause(err)
	}

	results := make([]ProtectedBookmarkResponse, 0, len(rows))
	for _, row := range rows {
		results = append(results, mapProtectedBookmark(row))
	}
	return results, nil
}

func (s *ProtectedBookmarkService) DeleteProtectedBookmark(ctx context.Context, actor *db.User, owner, repo, pattern string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	repository, err := s.resolveRepo(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return err
	}

	affected, err := s.queries.DeleteProtectedBookmarkByPattern(ctx, db.DeleteProtectedBookmarkByPatternParams{
		RepositoryID: repository.ID,
		// Upsert stores the trimmed pattern, so delete must match it the same way.
		Pattern: strings.TrimSpace(pattern),
	})
	if err != nil {
		return pkgerrors.Internal("failed to delete protected bookmark").WithCause(err)
	}
	if affected == 0 {
		return pkgerrors.NotFound("protected bookmark not found")
	}
	return nil
}

func (s *ProtectedBookmarkService) resolveRepo(ctx context.Context, owner, repo string) (db.Repository, error) {
	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     strings.ToLower(owner),
		LowerName: strings.ToLower(repo),
	})
	if err != nil {
		return db.Repository{}, pkgerrors.NotFound("repository not found")
	}
	return repository, nil
}

func (s *ProtectedBookmarkService) requireAdminAccess(ctx context.Context, repository db.Repository, user *db.User) error {
	if user == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if actsThroughRunCredential(ctx, user.ID) {
		return pkgerrors.Forbidden("admin access required")
	}
	if user.IsAdmin {
		return nil
	}
	isAdmin, err := canAdminRepo(ctx, s.queries, repository, user.ID)
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	return pkgerrors.Forbidden("admin access required")
}

func mapProtectedBookmark(row db.ProtectedBookmark) ProtectedBookmarkResponse {
	contexts := row.RequiredStatusContexts
	if contexts == nil {
		contexts = []string{}
	}
	return ProtectedBookmarkResponse{
		ID:                     row.ID,
		Pattern:                row.Pattern,
		RequireReview:          row.RequireReview,
		RequireHumanApprovals:  row.RequireHumanApprovals,
		RequireAgentLGTM:       row.RequireAgentLgtm,
		RequireStatusChecks:    row.RequireStatusChecks,
		RequiredStatusContexts: contexts,
	}
}
