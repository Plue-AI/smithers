package services

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// WikiFolderSync is one Obsidian folder the trusted host operator configured.
// Login names the account whose repository write access every pass requires.
type WikiFolderSync struct {
	Owner      string
	Repo       string
	Login      string
	Visibility string
	Connection string
	Folder     string
}

// SyncWikiFolders runs one reconciliation pass over host-configured folders.
// A failing folder never blocks the others; failures are keyed by folder.
func (s *WikiService) SyncWikiFolders(ctx context.Context, folders []WikiFolderSync) map[WikiFolderSync]error {
	failures := map[WikiFolderSync]error{}
	for _, folder := range folders {
		if err := s.syncWikiFolder(ctx, folder); err != nil {
			failures[folder] = err
		}
	}
	return failures
}

func (s *WikiService) syncWikiFolder(ctx context.Context, folder WikiFolderSync) error {
	q, ok := s.queries.(*db.Queries)
	if !ok {
		return wikiUnavailable("sync storage unavailable")
	}
	scoped, err := WithWikiVisibility(ctx, folder.Visibility)
	if err != nil {
		return err
	}
	// Resolve the account on every pass so deactivation and revoked access stop sync.
	actor, err := q.GetUserByLowerUsername(ctx, strings.ToLower(folder.Login))
	if errors.Is(err, pgx.ErrNoRows) || err == nil && actor.ProhibitLogin {
		return api.Forbidden("sync account unavailable")
	}
	if err != nil {
		return err
	}
	adapter, err := NewObsidianSync(folder.Folder)
	if err != nil {
		return err
	}
	defer adapter.Close()
	return s.SyncWiki(scoped, &actor, folder.Owner, folder.Repo, folder.Connection, adapter)
}

// RunWikiFolderSync passes over the configured folders until ctx ends. A pass
// that another replica holds reports a conflict and is retried next interval.
func RunWikiFolderSync(ctx context.Context, service *WikiService, folders []WikiFolderSync, interval time.Duration) {
	for {
		for folder, err := range service.SyncWikiFolders(ctx, folders) {
			if ctx.Err() == nil {
				slog.WarnContext(ctx, "wiki folder sync failed", "owner", folder.Owner, "repo", folder.Repo, "visibility", folder.Visibility, "connection", folder.Connection, "error", err)
			}
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
