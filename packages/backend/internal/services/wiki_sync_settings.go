package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// InstallObsidianSettings is the install-only source; hosted configuration never
// supplies its authority or its folder. The original person session is rechecked
// along with the current owner and repository binding on every pass.
type InstallObsidianSettings struct {
	Queries        *db.Queries
	StateDirectory string
	CheckOwner     func(context.Context, db.User) error
}
type installObsidianSetting struct {
	RepositoryOwner string     `json:"repository_owner"`
	RepositoryName  string     `json:"repository_name"`
	Path            string     `json:"path"`
	Identity        string     `json:"identity"`
	Session         string     `json:"session"`
	OwnerID         int64      `json:"owner_id"`
	LastSyncAt      *time.Time `json:"last_sync_at,omitempty"`
	Error           string     `json:"error,omitempty"`
}

func (s *InstallObsidianSettings) Set(ctx context.Context, path string) error {
	if s == nil || s.Queries == nil {
		return wikiUnavailable("install Obsidian settings unavailable")
	}
	decision, err := Authorize(ctx, s.Queries, "settings.obsidian")
	if err != nil {
		return err
	}
	canonical, identity, err := ValidateInstallObsidianFolder(path, s.StateDirectory)
	if err != nil {
		return &InstallReadinessError{Code: "folder_refused", Class: "user", Message: "Obsidian folder refused"}
	}
	setting := installObsidianSetting{Path: canonical, Identity: identity, OwnerID: decision.UserID, Session: middleware.AuthInfoFromContext(ctx).SessionHash}
	folder, err := s.authorizedFolder(ctx, setting)
	if err != nil {
		return err
	}
	setting.RepositoryOwner, setting.RepositoryName = folder.Owner, folder.Repo
	raw, err := json.Marshal(setting)
	if err != nil {
		return err
	}
	return s.Queries.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "wiki_sync.obsidian", Value: raw})
}

func (s *InstallObsidianSettings) authorizedFolder(ctx context.Context, setting installObsidianSetting) (*InstallWikiFolder, error) {
	session, err := s.Queries.GetAuthSessionBySessionKey(ctx, setting.Session)
	if err != nil || session.UserID != setting.OwnerID || !session.ExpiresAt.After(time.Now()) {
		return nil, api.Forbidden("Obsidian owner session unavailable")
	}
	owner, err := s.Queries.GetSelfHostOwner(ctx)
	if err != nil || owner.ID != setting.OwnerID || owner.ProhibitLogin {
		return nil, api.Forbidden("Obsidian owner unavailable")
	}
	person := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: setting.Session})
	if _, err = Authorize(person, s.Queries, "settings.obsidian"); err != nil {
		return nil, err
	}
	if s.CheckOwner == nil {
		return nil, wikiUnavailable("Obsidian owner authority unavailable")
	}
	if err = s.CheckOwner(ctx, owner); err != nil {
		return nil, err
	}
	repo, err := s.Queries.ReadInstallRepositoryBinding(ctx)
	if err != nil || repo.ID <= 0 || !gitHubAppComponent.MatchString(repo.Owner) || !gitHubAppComponent.MatchString(repo.Name) {
		return nil, wikiUnavailable("install Obsidian repository unavailable")
	}
	if setting.RepositoryOwner != "" && (setting.RepositoryOwner != repo.Owner || setting.RepositoryName != repo.Name) {
		return nil, api.Conflict("Obsidian repository changed")
	}
	return &InstallWikiFolder{WikiFolderSync: WikiFolderSync{Owner: repo.Owner, Repo: repo.Name, Login: owner.Username, Visibility: "public", Connection: fmt.Sprintf("install-obsidian:%s", setting.Identity), Folder: setting.Path}, StateDirectory: s.StateDirectory, Identity: setting.Identity}, nil
}

func (s *InstallObsidianSettings) LoadAuthorizedWikiFolder(ctx context.Context) (*InstallWikiFolder, error) {
	if s == nil || s.Queries == nil {
		return nil, wikiUnavailable("install Obsidian settings unavailable")
	}
	row, err := s.Queries.GetInstallSetting(ctx, "wiki_sync.obsidian")
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var setting installObsidianSetting
	if err = json.Unmarshal(row.Value, &setting); err != nil {
		return nil, err
	}
	if setting.RepositoryOwner == "" || setting.RepositoryName == "" {
		return nil, wikiUnavailable("Obsidian repository binding unavailable")
	}
	folder, err := s.authorizedFolder(ctx, setting)
	if err != nil {
		err = errors.Join(err, s.Queries.UpdateInstallObsidianReceipt(ctx, setting.Path, setting.Identity, "Obsidian sync failed", time.Now().UTC()))
	}
	return folder, err
}

func (s *InstallObsidianSettings) Snapshot(ctx context.Context) (map[string]any, error) {
	row, err := s.Queries.GetInstallSetting(ctx, "wiki_sync.obsidian")
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	var setting installObsidianSetting
	if err = json.Unmarshal(row.Value, &setting); err != nil {
		return nil, err
	}
	value := map[string]any{"path": setting.Path}
	if setting.LastSyncAt != nil {
		value["last_sync_at"] = setting.LastSyncAt
	}
	if setting.Error != "" {
		value["error"] = setting.Error
	}
	return map[string]any{"obsidian": value}, nil
}

func (s *InstallObsidianSettings) RecordWikiFolderSync(ctx context.Context, folder *InstallWikiFolder, failure error) error {
	message := ""
	if failure != nil {
		message = "Obsidian sync failed"
	}
	return s.Queries.UpdateInstallObsidianReceipt(ctx, folder.Folder, folder.Identity, message, time.Now().UTC())
}
