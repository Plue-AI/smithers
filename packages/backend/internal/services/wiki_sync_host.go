package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
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
	return s.syncWikiFolderValidated(ctx, folder, nil)
}

func (s *WikiService) syncWikiFolderValidated(ctx context.Context, folder WikiFolderSync, validate func(*ObsidianSync) error) error {
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
	if validate != nil {
		if err := validate(adapter); err != nil {
			return err
		}
	}
	return s.SyncWiki(scoped, &actor, folder.Owner, folder.Repo, folder.Connection, adapter)
}

// RunWikiFolderSync passes over the configured folders until ctx ends. A pass
// that another replica holds reports a conflict and is retried next interval.
func RunWikiFolderSync(ctx context.Context, service *WikiService, folders []WikiFolderSync, interval time.Duration) {
	runWikiFolderSync(ctx, func(ctx context.Context) map[WikiFolderSync]error { return service.SyncWikiFolders(ctx, folders) }, interval)
}

func runWikiFolderSync(ctx context.Context, pass func(context.Context) map[WikiFolderSync]error, interval time.Duration) {
	for ctx.Err() == nil {
		for folder, err := range pass(ctx) {
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

// InstallWikiFolderSource supplies the persisted wiki_sync.obsidian setting and
// repository scope, checking owner-session authority and the person-only catalog
// descriptor on every read. A missing provider refuses before filesystem access.
// Host configuration must never implement this install port.
type InstallWikiFolderSource interface {
	LoadAuthorizedWikiFolder(context.Context) (*InstallWikiFolder, error)
}

type InstallWikiFolder struct {
	WikiFolderSync
	StateDirectory string
	// Identity is persisted with the validated path, so a replacement refuses.
	Identity string
}

// ValidateInstallObsidianFolder is shared by the install write and every pass.
// No existing adapter validates install-user ownership or the STATE boundary.
func ValidateInstallObsidianFolder(folder, state string) (string, string, error) {
	refuse := func() (string, string, error) { return "", "", api.Forbidden("Obsidian folder refused") }
	if !filepath.IsAbs(folder) || !filepath.IsAbs(state) {
		return refuse()
	}
	canonical, err := filepath.EvalSymlinks(folder)
	if err != nil {
		return refuse()
	}
	canonicalState, err := filepath.EvalSymlinks(state)
	if err != nil {
		return refuse()
	}
	relative, err := filepath.Rel(canonicalState, canonical)
	if err != nil || relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return refuse()
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() || syncFileNumber(info, "Uid") != uint64(os.Getuid()) {
		return refuse()
	}
	return canonical, fmt.Sprintf("%d:%d", syncFileNumber(info, "Dev"), syncFileNumber(info, "Ino")), nil
}

func (s *WikiService) SyncInstallWikiFolder(ctx context.Context, source InstallWikiFolderSource) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if source == nil {
		return wikiUnavailable("install Obsidian settings unavailable")
	}
	setting, err := source.LoadAuthorizedWikiFolder(ctx)
	if err != nil {
		return err
	}
	if setting == nil {
		return nil
	} // No configured folder, no filesystem effects.
	if setting.Owner == "" || setting.Repo == "" || setting.Login == "" || setting.Connection == "" || setting.Identity == "" {
		return wikiUnavailable("install Obsidian scope unavailable")
	}
	path, identity, err := ValidateInstallObsidianFolder(setting.Folder, setting.StateDirectory)
	if err != nil {
		return err
	}
	if path != setting.Folder || identity != setting.Identity {
		return api.Conflict("Obsidian folder changed")
	}
	return s.syncWikiFolderValidated(ctx, setting.WikiFolderSync, func(adapter *ObsidianSync) error {
		info, err := adapter.root.Stat(".")
		if err != nil || syncFileNumber(info, "Uid") != uint64(os.Getuid()) ||
			fmt.Sprintf("%d:%d", syncFileNumber(info, "Dev"), syncFileNumber(info, "Ino")) != setting.Identity {
			return api.Conflict("Obsidian folder changed")
		}
		return nil
	})
}

func RunInstallWikiFolderSync(ctx context.Context, service *WikiService, source InstallWikiFolderSource, interval time.Duration) {
	runWikiFolderSync(ctx, func(ctx context.Context) map[WikiFolderSync]error {
		if err := service.SyncInstallWikiFolder(ctx, source); err != nil {
			return map[WikiFolderSync]error{{}: err}
		}
		return nil
	}, interval)
}
