package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// requestGitHubApp uses the same transport and response limits as landing.
func requestGitHubApp(ctx context.Context, client *http.Client, base, token, method, path string, out any) error {
	if base == "" {
		base = "https://api.github.com"
	}
	api := &landingGitHubAPI{maxResponseBytes: 4 << 20, client: client, baseURL: func() string { return base }}
	status, err := api.request(ctx, token, method, path, nil, out)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound && strings.HasPrefix(path, "/users/") {
		return pkgerrors.BadRequest("GitHub owner not found")
	}
	if status < 200 || status >= 300 {
		return landingGitHubStatusError(status, "", "", "App setup")
	}
	return nil
}

type GitHubAppManualRequest struct {
	AppID              int64    `json:"app_id"`
	Slug               string   `json:"slug"`
	PEM                string   `json:"pem"`
	ClientID           string   `json:"client_id"`
	ClientSecret       string   `json:"client_secret"`
	WebhookSecret      string   `json:"webhook_secret"`
	CallbacksConfirmed []string `json:"callbacks_confirmed"`
}

// ConfigureManual validates GitHub's authenticated identity before atomically
// sealing credentials, callbacks and the durable completion projection.
func (s *GitHubAppManifestService) ConfigureManual(ctx context.Context, input GitHubAppManualRequest) (GitHubAppManifestStart, error) {
	if s == nil || s.pool == nil || s.store == nil {
		return GitHubAppManifestStart{}, pkgerrors.Internal("GitHub App setup is unavailable")
	}
	session, err := setupSession(ctx)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	if input.AppID <= 0 {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("app_id required")
	}
	for _, field := range []struct{ name, value string }{{"slug", input.Slug}, {"pem", input.PEM}, {"client_id", input.ClientID}, {"client_secret", input.ClientSecret}, {"webhook_secret", input.WebhookSecret}} {
		if strings.TrimSpace(field.value) == "" {
			return GitHubAppManifestStart{}, pkgerrors.BadRequest(field.name + " required")
		}
	}
	origins, err := normalizedGitHubAppOrigins(s.knownOrigins())
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	expected := make(map[string]bool)
	allowed := false
	for _, origin := range origins {
		expected[origin+"/api/auth/github/callback"] = true
		allowed = allowed || origin == session.origin
	}
	if !allowed {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("GitHub App setup origin is not configured")
	}
	if len(input.CallbacksConfirmed) != len(expected) {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("callbacks_confirmed must include every configured callback")
	}
	for _, callback := range input.CallbacksConfirmed {
		if !expected[callback] {
			return GitHubAppManifestStart{}, pkgerrors.BadRequest("callbacks_confirmed must match configured callbacks")
		}
		delete(expected, callback)
	}
	key, err := parseGitHubAppPrivateKey(input.PEM)
	if err != nil {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("pem invalid")
	}
	jwt, err := createGitHubAppJWT(input.AppID, key, time.Now())
	if err != nil {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("pem invalid")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", gitHubAppConversionLock); err != nil {
		return GitHubAppManifestStart{}, err
	}
	store := *s.store
	store.q = db.New(tx)
	if _, err = store.Load(ctx); err == nil {
		return GitHubAppManifestStart{}, pkgerrors.Conflict("GitHub App is already configured")
	} else if !errors.Is(err, ErrGitHubAppNotConfigured) {
		return GitHubAppManifestStart{}, err
	}
	// Address confirmation is required even for a direct service caller.
	row, err := db.New(tx).GetInstallSetting(ctx, "setup.step.address")
	if errors.Is(err, pgx.ErrNoRows) {
		return GitHubAppManifestStart{}, pkgerrors.Conflict("Confirm Address first")
	}
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	var step InstallStep
	if json.Unmarshal(row.Value, &step) != nil || step.Status != InstallReady {
		return GitHubAppManifestStart{}, pkgerrors.Conflict("Confirm Address first")
	}
	var identity struct {
		ID    int64  `json:"id"`
		Slug  string `json:"slug"`
		Owner struct {
			Login string `json:"login"`
			Type  string `json:"type"`
		} `json:"owner"`
	}
	if err = requestGitHubApp(ctx, s.client, s.apiBaseURL, jwt, http.MethodGet, "/app", &identity); err != nil {
		return GitHubAppManifestStart{}, err
	}
	if identity.ID != input.AppID {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("app_id does not match GitHub")
	}
	if identity.Slug != input.Slug || !gitHubAppComponent.MatchString(identity.Slug) {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("slug does not match GitHub")
	}
	kind := "user"
	if identity.Owner.Type == "Organization" {
		kind = "org"
	} else if identity.Owner.Type != "User" {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("app_id has invalid owner")
	}
	if !gitHubAppComponent.MatchString(identity.Owner.Login) {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("app_id has invalid owner")
	}
	if err = store.Save(ctx, GitHubAppCredentials{ID: input.AppID, Slug: identity.Slug, OwnerLogin: identity.Owner.Login, OwnerKind: kind, PEM: input.PEM, ClientID: input.ClientID, ClientSecret: input.ClientSecret, WebhookSecret: input.WebhookSecret}); err != nil {
		return GitHubAppManifestStart{}, err
	}
	if err = store.SaveCallbackURLs(ctx, input.CallbacksConfirmed); err != nil {
		return GitHubAppManifestStart{}, err
	}
	repository, _ := json.Marshal(map[string]string{"owner_login": identity.Owner.Login, "owner_kind": kind, "repository_name": ""})
	if err = db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: repository}); err != nil {
		return GitHubAppManifestStart{}, err
	}
	for _, key := range []string{"setup.step.app_manifest", "setup.projection.app_manifest"} {
		if err = db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(`{"status":"done"}`)}); err != nil {
			return GitHubAppManifestStart{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return GitHubAppManifestStart{}, err
	}
	location, err := s.store.InstallURL(ctx)
	return GitHubAppManifestStart{InstallURL: location}, err
}
