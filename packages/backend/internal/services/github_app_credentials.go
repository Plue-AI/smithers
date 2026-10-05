package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

var (
	ErrGitHubAppNotConfigured        = errors.New("GitHub App is not configured")
	ErrGitHubAppAlreadyConfigured    = errors.New("GitHub App is already configured")
	ErrGitHubAppInstallationConflict = errors.New("GitHub App installation cannot be replaced")
)

// GitHubAppCredentials is host-only material. Secrets never serialize into
// API responses; callers must request the individual credential they need.
type GitHubAppCredentials struct {
	ID             int64  `json:"id"`
	Slug           string `json:"slug"`
	OwnerLogin     string `json:"owner_login"`
	OwnerKind      string `json:"owner_kind"`
	ClientID       string `json:"client_id"`
	PEM            string `json:"-"`
	WebhookSecret  string `json:"-"`
	ClientSecret   string `json:"-"`
	InstallationID int64  `json:"installation_id"`
}

type githubAppCredentialQuerier interface {
	GetGithubApp(context.Context) (db.GithubApp, error)
	CreateGithubApp(context.Context, db.CreateGithubAppParams) (int64, error)
	SetGithubAppInstallation(context.Context, int64) (int64, error)
	GetInstallSetting(context.Context, string) (db.InstallSetting, error)
	UpsertInstallSetting(context.Context, db.UpsertInstallSettingParams) error
}

// GitHubAppCredentialStore is the single credential source for App callers.
// Every read loads PostgreSQL again so changes take effect without restarting.
type GitHubAppCredentialStore struct {
	q     githubAppCredentialQuerier
	codec webhook.SecretCodec
}

func NewGitHubAppCredentialStore(pool *pgxpool.Pool, codec webhook.SecretCodec) *GitHubAppCredentialStore {
	store := &GitHubAppCredentialStore{codec: codec}
	if pool != nil {
		store.q = db.New(pool)
	}
	return store
}

func (s *GitHubAppCredentialStore) ready() error {
	if s == nil || s.q == nil || s.codec == nil {
		return errors.New("GitHub App credential store requires a database and secret codec")
	}
	return nil
}

// Save seals all secrets before issuing the one atomic insert. The database's
// singleton constraint refuses a second App even across concurrent processes.
func (s *GitHubAppCredentialStore) Save(ctx context.Context, credentials GitHubAppCredentials) error {
	if err := s.ready(); err != nil {
		return err
	}
	if err := validateGitHubAppCredentials(credentials); err != nil {
		return err
	}
	pemSealed, err := s.codec.EncryptString(credentials.PEM)
	if err != nil {
		return fmt.Errorf("seal GitHub App private key: %w", err)
	}
	webhookSealed, err := s.codec.EncryptString(credentials.WebhookSecret)
	if err != nil {
		return fmt.Errorf("seal GitHub App webhook secret: %w", err)
	}
	clientSealed, err := s.codec.EncryptString(credentials.ClientSecret)
	if err != nil {
		return fmt.Errorf("seal GitHub App client secret: %w", err)
	}
	count, err := s.q.CreateGithubApp(ctx, db.CreateGithubAppParams{
		ID: credentials.ID, Slug: credentials.Slug, OwnerLogin: credentials.OwnerLogin,
		OwnerKind: credentials.OwnerKind, ClientID: credentials.ClientID,
		PemSealed: pemSealed, WebhookSecretSealed: webhookSealed, ClientSecretSealed: clientSealed,
		InstallationID: pgtype.Int8{Int64: credentials.InstallationID, Valid: credentials.InstallationID != 0},
	})
	if err != nil {
		return fmt.Errorf("store GitHub App: %w", err)
	}
	if count == 0 {
		return ErrGitHubAppAlreadyConfigured
	}
	return nil
}

func validateGitHubAppCredentials(c GitHubAppCredentials) error {
	if c.ID <= 0 {
		return errors.New("GitHub App id must be positive")
	}
	if strings.TrimSpace(c.Slug) == "" || strings.ContainsAny(c.Slug, "/?#\\") {
		return errors.New("GitHub App slug is invalid")
	}
	if strings.TrimSpace(c.OwnerLogin) == "" {
		return errors.New("GitHub App owner is required")
	}
	if c.OwnerKind != "user" && c.OwnerKind != "org" {
		return errors.New("GitHub App owner kind is invalid")
	}
	if strings.TrimSpace(c.ClientID) == "" || strings.TrimSpace(c.ClientSecret) == "" || strings.TrimSpace(c.WebhookSecret) == "" {
		return errors.New("GitHub App client and webhook credentials are required")
	}
	if _, err := parseGitHubAppPrivateKey(c.PEM); err != nil {
		return errors.New("GitHub App private key is invalid")
	}
	if c.InstallationID < 0 {
		return errors.New("GitHub App installation id must be positive")
	}
	return nil
}

func (s *GitHubAppCredentialStore) Load(ctx context.Context) (GitHubAppCredentials, error) {
	if err := s.ready(); err != nil {
		return GitHubAppCredentials{}, err
	}
	row, err := s.q.GetGithubApp(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return GitHubAppCredentials{}, ErrGitHubAppNotConfigured
	}
	if err != nil {
		return GitHubAppCredentials{}, fmt.Errorf("load GitHub App: %w", err)
	}
	credentials := GitHubAppCredentials{ID: row.ID, Slug: row.Slug, OwnerLogin: row.OwnerLogin, OwnerKind: row.OwnerKind, ClientID: row.ClientID}
	if row.InstallationID.Valid {
		credentials.InstallationID = row.InstallationID.Int64
	}
	credentials.PEM, err = s.codec.DecryptString(row.PemSealed)
	if err != nil {
		return GitHubAppCredentials{}, fmt.Errorf("unseal GitHub App private key: %w", err)
	}
	credentials.WebhookSecret, err = s.codec.DecryptString(row.WebhookSecretSealed)
	if err != nil {
		return GitHubAppCredentials{}, fmt.Errorf("unseal GitHub App webhook secret: %w", err)
	}
	credentials.ClientSecret, err = s.codec.DecryptString(row.ClientSecretSealed)
	if err != nil {
		return GitHubAppCredentials{}, fmt.Errorf("unseal GitHub App client secret: %w", err)
	}
	return credentials, nil
}

func (s *GitHubAppCredentialStore) Slug(ctx context.Context) (string, error) {
	c, err := s.Load(ctx)
	return c.Slug, err
}

func (s *GitHubAppCredentialStore) InstallURL(ctx context.Context) (string, error) {
	slug, err := s.Slug(ctx)
	if err != nil {
		return "", err
	}
	return "https://github.com/apps/" + url.PathEscape(slug) + "/installations/new", nil
}

func (s *GitHubAppCredentialStore) AppJWT(ctx context.Context) (string, error) {
	c, err := s.Load(ctx)
	if err != nil {
		return "", err
	}
	key, err := parseGitHubAppPrivateKey(c.PEM)
	if err != nil {
		return "", fmt.Errorf("parse GitHub App private key: %w", err)
	}
	return createGitHubAppJWT(c.ID, key, time.Now())
}

func (s *GitHubAppCredentialStore) WebhookSecret(ctx context.Context) (string, error) {
	c, err := s.Load(ctx)
	return c.WebhookSecret, err
}

func (s *GitHubAppCredentialStore) OAuthClient(ctx context.Context) (string, string, error) {
	c, err := s.Load(ctx)
	return c.ClientID, c.ClientSecret, err
}

// SetInstallation records the installation after App-authenticated discovery
// verifies the persisted owner/repository binding, including reinstallation.
func (s *GitHubAppCredentialStore) SetInstallation(ctx context.Context, id int64) error {
	if err := s.ready(); err != nil {
		return err
	}
	if id <= 0 {
		return errors.New("GitHub App installation id must be positive")
	}
	count, err := s.q.SetGithubAppInstallation(ctx, id)
	if err != nil {
		return fmt.Errorf("store GitHub App installation: %w", err)
	}
	if count == 0 {
		return ErrGitHubAppInstallationConflict
	}
	return nil
}

type GitHubAppCallbackFix struct {
	SettingsURL string `json:"settings_url"`
	AddURL      string `json:"add_url"`
}

const gitHubAppCallbackURLsSetting = "github.callback_urls"

// SaveCallbackURLs records callbacks confirmed on GitHub. Changing configured
// origins never calls this method: the original registration remains truthful.
func (s *GitHubAppCredentialStore) SaveCallbackURLs(ctx context.Context, urls []string) error {
	if err := s.ready(); err != nil {
		return err
	}
	callbacks, err := validateGitHubAppCallbackURLs(urls)
	if err != nil {
		return err
	}
	value, _ := json.Marshal(callbacks) // []string always encodes as JSON.
	if err := s.q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: gitHubAppCallbackURLsSetting, Value: value, Sealed: false}); err != nil {
		return fmt.Errorf("store GitHub App callback URLs: %w", err)
	}
	return nil
}

func (s *GitHubAppCredentialStore) CallbackURLs(ctx context.Context) ([]string, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	setting, err := s.q.GetInstallSetting(ctx, gitHubAppCallbackURLsSetting)
	if err != nil {
		return nil, fmt.Errorf("load GitHub App callback URLs: %w", err)
	}
	if setting.Sealed {
		return nil, errors.New("GitHub App callback URLs must be public JSON")
	}
	var urls []string
	if err := json.Unmarshal(setting.Value, &urls); err != nil {
		return nil, fmt.Errorf("decode GitHub App callback URLs: %w", err)
	}
	return validateGitHubAppCallbackURLs(urls)
}

func validateGitHubAppCallbackURLs(urls []string) ([]string, error) {
	if urls == nil || len(urls) > 10 {
		return nil, errors.New("GitHub App callback URL snapshot is invalid")
	}
	callbacks := make([]string, 0, len(urls))
	seen := map[string]bool{}
	for _, callback := range urls {
		u, err := url.Parse(callback)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "/api/auth/github/callback" || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("GitHub App callback URL snapshot contains an invalid origin")
		}
		canonical := u.Scheme + "://" + strings.ToLower(u.Host) + "/api/auth/github/callback"
		if !seen[canonical] {
			seen[canonical] = true
			callbacks = append(callbacks, canonical)
		}
	}
	return callbacks, nil
}

// CallbackFixes returns the exact setting and value to add for every newly
// configured origin, without claiming an API update or changing the snapshot.
func (s *GitHubAppCredentialStore) CallbackFixes(ctx context.Context, origins []string) ([]GitHubAppCallbackFix, error) {
	configured, err := normalizedGitHubAppOrigins(origins)
	if err != nil {
		return nil, err
	}
	registered, err := s.CallbackURLs(ctx)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(registered))
	for _, callback := range registered {
		seen[callback] = true
	}
	fixes := make([]GitHubAppCallbackFix, 0)
	for _, origin := range configured {
		origin += "/api/auth/github/callback"
		if !seen[origin] {
			fixes = append(fixes, GitHubAppCallbackFix{AddURL: origin})
		}
	}
	if len(fixes) == 0 {
		return fixes, nil
	}
	credentials, err := s.Load(ctx)
	if err != nil {
		return nil, err
	}
	settingsURL := "https://github.com/settings/apps/" + url.PathEscape(credentials.Slug)
	if credentials.OwnerKind == "org" {
		settingsURL = "https://github.com/organizations/" + url.PathEscape(credentials.OwnerLogin) + "/settings/apps/" + url.PathEscape(credentials.Slug)
	}
	for i := range fixes {
		fixes[i].SettingsURL = settingsURL
	}
	return fixes, nil
}

// GitHubAppCredentialSource is the one host-selected credential interface.
// Self-hosted composition supplies the sealed store; Plue explicitly selects env.
type GitHubAppCredentialSource interface {
	GitHubAppCredentialReader
	Slug(context.Context) (string, error)
	WebhookSecret(context.Context) (string, error)
	OAuthClient(context.Context) (string, string, error)
}

type EnvGitHubAppCredentials struct {
	mu                                        sync.Mutex
	validatedID                               int64
	validatedPEM, slug, ownerLogin, ownerKind string
}

func (e *EnvGitHubAppCredentials) Load(ctx context.Context) (GitHubAppCredentials, error) {
	if err := ctx.Err(); err != nil {
		return GitHubAppCredentials{}, err
	}
	c, err := readGitHubAppCredentialsFromEnv()
	if err != nil {
		return c, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.validatedID != c.ID || e.validatedPEM != c.PEM {
		key, err := parseGitHubAppPrivateKey(c.PEM)
		if err != nil {
			return GitHubAppCredentials{}, err
		}
		jwt, err := createGitHubAppJWT(c.ID, key, time.Now())
		if err != nil {
			return GitHubAppCredentials{}, err
		}
		var identity struct {
			ID    int64  `json:"id"`
			Slug  string `json:"slug"`
			Owner struct {
				Login string `json:"login"`
				Type  string `json:"type"`
			} `json:"owner"`
		}
		api := os.Getenv("SMITHERS_GITHUB_APP_API_BASE_URL")
		if err := NewGitHubAppManifestService(nil, nil, api, nil).request(ctx, http.MethodGet, "/app", jwt, &identity); err != nil {
			return GitHubAppCredentials{}, err
		}
		if identity.ID != c.ID || !gitHubAppComponent.MatchString(identity.Slug) || !gitHubAppComponent.MatchString(identity.Owner.Login) || (identity.Owner.Type != "User" && identity.Owner.Type != "Organization") {
			return GitHubAppCredentials{}, errors.New("GitHub App identity validation failed")
		}
		e.validatedID, e.validatedPEM, e.slug, e.ownerLogin = c.ID, c.PEM, identity.Slug, identity.Owner.Login
		e.ownerKind = "user"
		if identity.Owner.Type == "Organization" {
			e.ownerKind = "org"
		}
	}
	c.Slug, c.OwnerLogin, c.OwnerKind = e.slug, e.ownerLogin, e.ownerKind
	return c, nil
}
func readGitHubAppCredentialsFromEnv() (GitHubAppCredentials, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(os.Getenv("SMITHERS_GITHUB_APP_ID")), 10, 64)
	if err != nil || id <= 0 {
		return GitHubAppCredentials{}, ErrGitHubAppNotConfigured
	}
	c := GitHubAppCredentials{ID: id, Slug: strings.TrimSpace(os.Getenv("SMITHERS_GITHUB_APP_SLUG")), PEM: strings.ReplaceAll(os.Getenv("SMITHERS_GITHUB_APP_PRIVATE_KEY"), `\n`, "\n"), ClientID: os.Getenv("SMITHERS_AUTH_GITHUB_CLIENT_ID"), ClientSecret: os.Getenv("SMITHERS_AUTH_GITHUB_CLIENT_SECRET"), WebhookSecret: os.Getenv("SMITHERS_WEBHOOK_GITHUB_APP_SECRET"), OwnerLogin: os.Getenv("SMITHERS_GITHUB_APP_OWNER"), OwnerKind: os.Getenv("SMITHERS_GITHUB_APP_OWNER_KIND")}
	if _, err := parseGitHubAppPrivateKey(c.PEM); err != nil {
		return GitHubAppCredentials{}, ErrGitHubAppNotConfigured
	}
	return c, nil
}
func (e *EnvGitHubAppCredentials) Slug(ctx context.Context) (string, error) {
	c, err := e.Load(ctx)
	return c.Slug, err
}
func (e *EnvGitHubAppCredentials) InstallURL(ctx context.Context) (string, error) {
	slug, err := e.Slug(ctx)
	if err != nil {
		return "", err
	}
	return "https://github.com/apps/" + url.PathEscape(slug) + "/installations/new", nil
}
func (e *EnvGitHubAppCredentials) AppJWT(ctx context.Context) (string, error) {
	c, err := e.Load(ctx)
	if err != nil {
		return "", err
	}
	key, err := parseGitHubAppPrivateKey(c.PEM)
	if err != nil {
		return "", err
	}
	return createGitHubAppJWT(c.ID, key, time.Now())
}
func (e *EnvGitHubAppCredentials) WebhookSecret(ctx context.Context) (string, error) {
	c, err := e.Load(ctx)
	return c.WebhookSecret, err
}
func (e *EnvGitHubAppCredentials) OAuthClient(ctx context.Context) (string, string, error) {
	c, err := e.Load(ctx)
	return c.ClientID, c.ClientSecret, err
}
