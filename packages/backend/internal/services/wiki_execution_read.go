package services

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type installWikiReadStore struct{ queries *db.Queries }

func WithWikiInstallAuthorization(q *db.Queries) WikiServiceOption {
	return func(s *WikiService) { s.install = &installWikiReadStore{queries: q} }
}

// The coding-readable public page/history doors in Appendix B are distinct
// from the person's private space, global listings and collaboration document.
func InstallExecutionWikiSubject(ctx context.Context, q *db.Queries, repository int64, resource, source string) (InstallSubject, error) {
	subject, err := ResolveInstallExecutionSubject(ctx, q, repository)
	if err != nil {
		return InstallSubject{RepositoryID: repository}, err
	}
	item, err := q.GetMythicalItemByNumber(ctx, repository, subject.TodoNumber)
	if err != nil {
		return subject, err
	}
	subject.Attempt, subject.RunID = item.Attempt, item.RequestRunID
	subject.Resource, subject.Source = resource, source
	switch resource {
	case "wiki.public-page", "wiki.public-history":
		subject.Source, err = normalizeWikiSlug(source)
	case "wiki.public-history-id":
		var id int64
		id, err = strconv.ParseInt(source, 10, 64)
		if id <= 0 {
			subject.Resource = ""
		}
		subject.Source = strconv.FormatInt(id, 10)
	case "wiki.public-revision":
		parts := strings.Split(source, ":")
		if len(parts) != 2 {
			subject.Resource = ""
			break
		}
		var id, revision int64
		id, err = strconv.ParseInt(parts[0], 10, 64)
		if err == nil {
			revision, err = strconv.ParseInt(parts[1], 10, 64)
		}
		if id <= 0 || revision <= 0 {
			subject.Resource = ""
		}
		subject.Source = strconv.FormatInt(id, 10) + ":" + strconv.FormatInt(revision, 10)
	case "wiki.public-selection":
		if source != "" {
			subject.Resource = ""
		}
	default:
		subject.Resource = ""
	}
	if err != nil {
		subject.Resource = ""
	}
	return subject, err
}

func authorizeExecutionWikiRead(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	decision, err := authorizeExecutionTodoRead(ctx, q, subject)
	if err != nil {
		return InstallAuthorization{}, err
	}
	switch subject.Resource {
	case "wiki.public-page", "wiki.public-history", "wiki.public-history-id", "wiki.public-revision":
		if subject.Source == "" {
			return InstallAuthorization{}, confirmationPermission()
		}
	case "wiki.public-selection":
		if subject.Source != "" {
			return InstallAuthorization{}, confirmationPermission()
		}
	default:
		return InstallAuthorization{}, confirmationPermission()
	}
	item, err := q.GetMythicalItemByNumber(ctx, subject.RepositoryID, subject.TodoNumber)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if subject.Attempt <= 0 || subject.RunID == "" || item.Attempt != subject.Attempt || item.RequestRunID != subject.RunID {
		return InstallAuthorization{}, confirmationPermission()
	}
	lane, err := q.GetMythicalLane(ctx, subject.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return InstallAuthorization{}, confirmationPermission()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if lane.RetiredAt.Valid || lane.RepositoryID != subject.RepositoryID || lane.ItemID != item.ID {
		return InstallAuthorization{}, confirmationPermission()
	}
	return decision, nil
}

// Revalidation reuses the one command decision but reloads the stored execution
// binding. The selector and blob readers may outlast the credential or attempt.
func RevalidateInstallWikiRead(ctx context.Context, q *db.Queries, subject InstallSubject) error {
	if _, err := Authorize(ctx, q, "wiki.read", subject); err != nil {
		return err
	}
	_, err := authorizeExecutionWikiRead(ctx, q, subject)
	return err
}

func (s *WikiService) admitExecutionWikiRead(ctx context.Context, viewer *db.User, repository int64, resource, source string) (context.Context, error) {
	if s.install == nil || !InstallExecutionCredential(ctx) {
		return ctx, nil
	}
	if s.install.queries == nil {
		return ctx, confirmationPermission()
	}
	// Selection may inspect public pages internally; it does not make the HTTP
	// global index or an arbitrary private space available to its credential.
	if bound, ok := ctx.Value(installAuthorizationKey{}).(boundInstallAuthorization); ok && bound.command == "wiki.read" && bound.subject.Resource == "wiki.public-selection" && (resource == "wiki.public-page" || resource == "wiki.index") {
		resource, source = "wiki.public-selection", ""
	}
	if wikiVisibility(ctx) != "public" {
		resource = ""
	}
	subject, lookup := InstallExecutionWikiSubject(ctx, s.install.queries, repository, resource, source)
	decision, err := Authorize(ctx, s.install.queries, "wiki.read", subject)
	if err != nil {
		return ctx, err
	}
	if lookup != nil {
		return ctx, lookup
	}
	if viewer == nil || viewer.ID != decision.UserID {
		return ctx, confirmationPermission()
	}
	return WithInstallAuthorization(ctx, "wiki.read", decision, subject), nil
}

func (s *WikiService) revalidateExecutionWikiRead(ctx context.Context, viewer *db.User, repository int64) error {
	if s.install == nil || !InstallExecutionCredential(ctx) {
		return nil
	}
	if s.install.queries == nil {
		return confirmationPermission()
	}
	bound, ok := ctx.Value(installAuthorizationKey{}).(boundInstallAuthorization)
	if !ok || bound.command != "wiki.read" || bound.subject.RepositoryID != repository || wikiVisibility(ctx) != "public" || viewer == nil || viewer.ID != bound.decision.UserID {
		return confirmationPermission()
	}
	return RevalidateInstallWikiRead(ctx, s.install.queries, bound.subject)
}
