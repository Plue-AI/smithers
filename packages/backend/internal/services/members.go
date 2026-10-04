package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Members retains the singleton owner; the roster extension uses this seam.
type Members struct {
	Pool        *pgxpool.Pool
	Credentials GitHubAppCredentialReader
}

// VerifyOwner discovers the installation using the App JWT, then checks push
// permission with an installation token. Caller-supplied installation ids never enter.
func (m *Members) VerifyOwner(ctx context.Context, user db.User) error {
	q := db.New(m.Pool)
	owner, err := q.GetSelfHostOwner(ctx)
	if err != nil {
		return err
	}
	if owner.ID != user.ID {
		return pkgerrors.Forbidden("not a member")
	}
	setting, err := q.GetInstallSetting(ctx, "github.repository")
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var repo struct {
		Owner string `json:"owner_login"`
		Name  string `json:"repository_name"`
		ID    int64  `json:"repository_id"`
	}
	if err = json.Unmarshal(setting.Value, &repo); err != nil {
		return err
	}
	if !gitHubAppComponent.MatchString(repo.Owner) || !gitHubAppComponent.MatchString(repo.Name) {
		return pkgerrors.BadRequest("invalid GitHub repository")
	}
	if m.Credentials == nil {
		return ErrGitHubAppNotConfigured
	}
	jwt, err := m.Credentials.AppJWT(ctx)
	if err != nil {
		return err
	}
	api := &landingGitHubAPI{client: &http.Client{Timeout: 30 * time.Second}, baseURL: func() string {
		if base := os.Getenv(envGitHubAppAPIBaseURL); base != "" {
			return base
		}
		return defaultGitHubAPIBaseURL
	}}
	var installation struct {
		ID int64 `json:"id"`
	}
	status, err := api.request(ctx, jwt, http.MethodGet, landingGitHubRepoPath(repo.Owner, repo.Name)+"/installation", nil, &installation)
	if err != nil {
		return err
	}
	if status != 200 || installation.ID <= 0 {
		return pkgerrors.Forbidden("GitHub App is not installed on the repository")
	}
	var access struct {
		Token string `json:"token"`
	}
	status, err = api.request(ctx, jwt, http.MethodPost, fmt.Sprintf("/app/installations/%d/access_tokens", installation.ID), nil, &access)
	if err != nil {
		return err
	}
	if status != 201 || access.Token == "" {
		return pkgerrors.Forbidden("GitHub installation token unavailable")
	}
	permission, role, err := api.repositoryPermission(ctx, access.Token, repo.Owner, repo.Name, user.Username)
	if err != nil {
		return err
	}
	if permission != "write" && permission != "admin" && role != "maintain" {
		return pkgerrors.Forbidden("needs access on GitHub ↗")
	}
	tx, err := m.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Use the exact configured product repository; never grant on unrelated repos.
	if repo.ID > 0 {
		if _, err = tx.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin') ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET permission='admin'`, repo.ID, user.ID); err != nil {
			return err
		}
	}
	value, _ := json.Marshal(map[string]any{"last_access_check_at": time.Now().UTC(), "installation_id": installation.ID, "repository_id": repo.ID, "owner_login": repo.Owner, "repository_name": repo.Name})
	if err = db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: value}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// BindRepository fences the previous verification before checking a new selection.
func (m *Members) BindRepository(ctx context.Context, user db.User, owner, name string, repositoryID int64) error {
	value, _ := json.Marshal(map[string]any{"owner_login": owner, "repository_name": name, "repository_id": repositoryID})
	if err := db.New(m.Pool).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: value}); err != nil {
		return err
	}
	return m.VerifyOwner(ctx, user)
}
