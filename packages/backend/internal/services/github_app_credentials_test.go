package services

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// A querier stub isolates encryption and signing failures from PostgreSQL;
// singleton races and restart behavior use real PostgreSQL in integration tests.
type githubAppCredentialTestQueries struct {
	row               db.GithubApp
	err               error
	reads             int
	created           *db.CreateGithubAppParams
	createCount       int64
	installationCount int64
	setting           db.InstallSetting
	settingError      error
	savedSetting      *db.UpsertInstallSettingParams
}

func (q *githubAppCredentialTestQueries) GetInstallSetting(context.Context, string) (db.InstallSetting, error) {
	return q.setting, q.settingError
}

func (q *githubAppCredentialTestQueries) UpsertInstallSetting(_ context.Context, arg db.UpsertInstallSettingParams) error {
	q.savedSetting = &arg
	if q.settingError != nil {
		return q.settingError
	}
	q.setting = db.InstallSetting{Key: arg.Key, Value: arg.Value, Sealed: arg.Sealed, UpdatedBy: arg.UpdatedBy}
	return nil
}

func (q *githubAppCredentialTestQueries) GetGithubApp(context.Context) (db.GithubApp, error) {
	q.reads++
	return q.row, q.err
}

func (q *githubAppCredentialTestQueries) CreateGithubApp(_ context.Context, arg db.CreateGithubAppParams) (int64, error) {
	q.created = &arg
	return q.createCount, q.err
}

func (q *githubAppCredentialTestQueries) SetGithubAppInstallation(context.Context, int64) (int64, error) {
	return q.installationCount, q.err
}

func githubAppTestCredentials(t *testing.T) GitHubAppCredentials {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return GitHubAppCredentials{ID: 42, Slug: "smithers-test", OwnerLogin: "smithersai", OwnerKind: "org", ClientID: "client-id", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), WebhookSecret: "webhook-secret", ClientSecret: "client-secret"}
}

func githubAppTestStore(t *testing.T, credentials GitHubAppCredentials) (*GitHubAppCredentialStore, *githubAppCredentialTestQueries) {
	t.Helper()
	codec, err := webhook.NewSecretCodec("test-install-key")
	require.NoError(t, err)
	queries := &githubAppCredentialTestQueries{createCount: 1}
	store := &GitHubAppCredentialStore{q: queries, codec: codec}
	require.NoError(t, store.Save(context.Background(), credentials))
	arg := queries.created
	queries.row = db.GithubApp{ID: arg.ID, Slug: arg.Slug, OwnerLogin: arg.OwnerLogin, OwnerKind: arg.OwnerKind, ClientID: arg.ClientID, PemSealed: arg.PemSealed, WebhookSecretSealed: arg.WebhookSecretSealed, ClientSecretSealed: arg.ClientSecretSealed, InstallationID: arg.InstallationID}
	return store, queries
}

func TestGitHubAppCredentialStoreSealsAndLoadsFresh(t *testing.T) {
	want := githubAppTestCredentials(t)
	store, q := githubAppTestStore(t, want)
	require.NotContains(t, q.row.PemSealed, "PRIVATE KEY")
	require.NotContains(t, q.row.ClientSecretSealed, want.ClientSecret)
	require.NotContains(t, q.row.WebhookSecretSealed, want.WebhookSecret)
	got, err := store.Load(context.Background())
	require.NoError(t, err)
	require.Equal(t, want, got)
	q.row.Slug = "changed-app"
	slug, err := store.Slug(context.Background())
	require.NoError(t, err)
	require.Equal(t, "changed-app", slug)
	url, err := store.InstallURL(context.Background())
	require.NoError(t, err)
	require.Equal(t, "https://github.com/apps/changed-app/installations/new", url)
	secret, err := store.WebhookSecret(context.Background())
	require.NoError(t, err)
	require.Equal(t, want.WebhookSecret, secret)
	id, secret, err := store.OAuthClient(context.Background())
	require.NoError(t, err)
	require.Equal(t, want.ClientID, id)
	require.Equal(t, want.ClientSecret, secret)
	require.Equal(t, 5, q.reads)
	encoded, err := json.Marshal(got)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), want.ClientSecret)
	require.NotContains(t, string(encoded), "PRIVATE KEY")
}

func TestGitHubAppCredentialStoreSignsJWT(t *testing.T) {
	want := githubAppTestCredentials(t)
	store, _ := githubAppTestStore(t, want)
	token, err := store.AppJWT(context.Background())
	require.NoError(t, err)
	parts := strings.Split(token, ".")
	require.Len(t, parts, 3)
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(t, err)
	var claims struct {
		Iss int64 `json:"iss"`
		Iat int64 `json:"iat"`
		Exp int64 `json:"exp"`
	}
	require.NoError(t, json.Unmarshal(payload, &claims))
	require.Equal(t, want.ID, claims.Iss)
	require.EqualValues(t, 570, claims.Exp-claims.Iat)
	key, err := parseGitHubAppPrivateKey(want.PEM)
	require.NoError(t, err)
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	require.NoError(t, err)
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	require.NoError(t, rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature))
}

func TestGitHubAppCredentialStoreReadFailures(t *testing.T) {
	store, q := githubAppTestStore(t, githubAppTestCredentials(t))
	q.err = pgx.ErrNoRows
	_, err := store.Load(context.Background())
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
	q.err = errors.New("database unavailable")
	_, err = store.Load(context.Background())
	require.ErrorContains(t, err, "load GitHub App")
	q.err = nil
	q.row.PemSealed = "corrupted ciphertext"
	_, err = store.Load(context.Background())
	require.ErrorContains(t, err, "unseal GitHub App")
}

type githubAppFailingCodec struct {
	webhook.SecretCodec
	encryptCall, encryptFailAt int
}

func (c *githubAppFailingCodec) EncryptString(value string) (string, error) {
	c.encryptCall++
	if c.encryptCall == c.encryptFailAt {
		return "", errors.New("encryption unavailable")
	}
	return c.SecretCodec.EncryptString(value)
}

func TestGitHubAppCredentialStoreSaveFailures(t *testing.T) {
	valid := githubAppTestCredentials(t)
	for _, test := range []struct {
		name   string
		change func(*GitHubAppCredentials)
	}{
		{"zero id", func(c *GitHubAppCredentials) { c.ID = 0 }},
		{"negative id", func(c *GitHubAppCredentials) { c.ID = -1 }},
		{"blank slug", func(c *GitHubAppCredentials) { c.Slug = " " }},
		{"slug path", func(c *GitHubAppCredentials) { c.Slug = "app/other" }},
		{"blank owner", func(c *GitHubAppCredentials) { c.OwnerLogin = " " }},
		{"owner kind", func(c *GitHubAppCredentials) { c.OwnerKind = "Organization" }},
		{"blank client id", func(c *GitHubAppCredentials) { c.ClientID = " " }},
		{"blank client secret", func(c *GitHubAppCredentials) { c.ClientSecret = " " }},
		{"blank webhook secret", func(c *GitHubAppCredentials) { c.WebhookSecret = " " }},
		{"invalid pem", func(c *GitHubAppCredentials) { c.PEM = "not-a-key" }},
		{"negative installation", func(c *GitHubAppCredentials) { c.InstallationID = -1 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			q := &githubAppCredentialTestQueries{createCount: 1}
			codec, err := webhook.NewSecretCodec("install-key")
			require.NoError(t, err)
			store := &GitHubAppCredentialStore{q: q, codec: codec}
			credentials := valid
			test.change(&credentials)
			require.Error(t, store.Save(context.Background(), credentials))
			require.Nil(t, q.created, "invalid credentials must never reach the database")
		})
	}
	for _, failAt := range []int{1, 2, 3} {
		t.Run("encryption failure "+string(rune('0'+failAt)), func(t *testing.T) {
			q := &githubAppCredentialTestQueries{createCount: 1}
			codec, err := webhook.NewSecretCodec("install-key")
			require.NoError(t, err)
			store := &GitHubAppCredentialStore{q: q, codec: &githubAppFailingCodec{SecretCodec: codec, encryptFailAt: failAt}}
			require.ErrorContains(t, store.Save(context.Background(), valid), "seal GitHub App")
			require.Nil(t, q.created, "partial encryption must never write credentials")
		})
	}
	store, q := githubAppTestStore(t, valid)
	q.createCount = 0
	require.ErrorIs(t, store.Save(context.Background(), valid), ErrGitHubAppAlreadyConfigured)
	q.err = context.Canceled
	require.ErrorIs(t, store.Save(context.Background(), valid), context.Canceled)
}

func TestGitHubAppCredentialStoreUnsealFailures(t *testing.T) {
	for _, field := range []string{"PEM", "webhook", "client"} {
		t.Run(field, func(t *testing.T) {
			store, q := githubAppTestStore(t, githubAppTestCredentials(t))
			switch field {
			case "PEM":
				q.row.PemSealed = "invalid"
			case "webhook":
				q.row.WebhookSecretSealed = "invalid"
			case "client":
				q.row.ClientSecretSealed = "invalid"
			}
			c, err := store.Load(context.Background())
			require.ErrorContains(t, err, "unseal GitHub App")
			require.Empty(t, c.PEM, "a failed read must not return partially unsealed material")
			require.Empty(t, c.ClientSecret)
			require.Empty(t, c.WebhookSecret)
		})
	}
	store, q := githubAppTestStore(t, githubAppTestCredentials(t))
	q.row.PemSealed, _ = store.codec.EncryptString("invalid key")
	token, err := store.AppJWT(context.Background())
	require.ErrorContains(t, err, "parse GitHub App private key")
	require.Empty(t, token)
}

func TestGitHubAppCredentialStoreReadersPropagateFailures(t *testing.T) {
	store, q := githubAppTestStore(t, githubAppTestCredentials(t))
	q.err = context.Canceled
	for _, read := range []func(context.Context) (string, error){store.Slug, store.InstallURL, store.AppJWT, store.WebhookSecret} {
		value, err := read(context.Background())
		require.ErrorIs(t, err, context.Canceled)
		require.Empty(t, value)
	}
	id, secret, err := store.OAuthClient(context.Background())
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, id)
	require.Empty(t, secret)
}

func TestGitHubAppCredentialStoreInstallation(t *testing.T) {
	credentials := githubAppTestCredentials(t)
	credentials.InstallationID = 123
	credentials.OwnerKind = "user"
	store, q := githubAppTestStore(t, credentials)
	require.Equal(t, pgtype.Int8{Int64: 123, Valid: true}, q.created.InstallationID)
	loaded, err := store.Load(context.Background())
	require.NoError(t, err)
	require.EqualValues(t, 123, loaded.InstallationID)
	for _, id := range []int64{0, -1} {
		require.Error(t, store.SetInstallation(context.Background(), id))
	}
	q.installationCount = 1
	require.NoError(t, store.SetInstallation(context.Background(), 123))
	q.installationCount = 0
	require.ErrorIs(t, store.SetInstallation(context.Background(), 124), ErrGitHubAppInstallationConflict)
	q.err = context.DeadlineExceeded
	require.ErrorIs(t, store.SetInstallation(context.Background(), 123), context.DeadlineExceeded)
}

func TestGitHubAppCredentialStoreFailsClosedWithoutDependencies(t *testing.T) {
	valid := githubAppTestCredentials(t)
	for _, store := range []*GitHubAppCredentialStore{nil, NewGitHubAppCredentialStore(nil, nil), {q: &githubAppCredentialTestQueries{}}, {codec: webhook.NoopSecretCodec{}}} {
		_, err := store.Load(context.Background())
		require.ErrorContains(t, err, "requires a database and secret codec")
		require.Error(t, store.Save(context.Background(), valid))
		require.Error(t, store.SetInstallation(context.Background(), 123))
	}
}

func TestGitHubAppCredentialSecretsParticipateInInstallKeyRotation(t *testing.T) {
	for _, name := range []string{"pem_sealed", "webhook_secret_sealed", "client_secret_sealed"} {
		found := false
		for _, column := range operatorKeyColumns {
			if column.table == "github_app" && column.column == name {
				found = true
				require.Equal(t, [][2]string{{"id", "bigint"}}, column.keys)
				require.False(t, column.bytea)
			}
		}
		require.True(t, found, "GitHub App %s must reseal before retiring the install key", name)
	}
}

func TestGitHubAppEnvAdapterIsExplicitAndHasNoDefaultSlug(t *testing.T) {
	server, c := manifestFixture(t)
	for key, value := range map[string]string{"SMITHERS_GITHUB_APP_ID": "42", "SMITHERS_GITHUB_APP_SLUG": "plue-app", "SMITHERS_GITHUB_APP_PRIVATE_KEY": c.PEM, "SMITHERS_AUTH_GITHUB_CLIENT_ID": "plue-client", "SMITHERS_AUTH_GITHUB_CLIENT_SECRET": "plue-secret", "SMITHERS_WEBHOOK_GITHUB_APP_SECRET": "plue-webhook"} {
		t.Setenv(key, value)
	}
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", server.URL)
	e := &EnvGitHubAppCredentials{}
	ctx := context.Background()
	slug, err := e.Slug(ctx)
	require.NoError(t, err)
	require.Equal(t, "smithers-integration", slug)
	location, err := e.InstallURL(ctx)
	require.NoError(t, err)
	require.Equal(t, "https://github.com/apps/smithers-integration/installations/new", location)
	jwt, err := e.AppJWT(ctx)
	require.NoError(t, err)
	require.NotEmpty(t, jwt)
	id, secret, err := e.OAuthClient(ctx)
	require.NoError(t, err)
	require.Equal(t, "plue-client", id)
	require.Equal(t, "plue-secret", secret)
	webhook, err := e.WebhookSecret(ctx)
	require.NoError(t, err)
	require.Equal(t, "plue-webhook", webhook)
	t.Setenv("SMITHERS_GITHUB_APP_SLUG", "")
	_, err = e.Load(ctx)
	require.NoError(t, err)
	t.Setenv("SMITHERS_GITHUB_APP_SLUG", "plue-app")
	for _, id := range []string{"", "invalid", "0", "-1"} {
		t.Setenv("SMITHERS_GITHUB_APP_ID", id)
		_, err = e.Load(ctx)
		require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
	}
	t.Setenv("SMITHERS_GITHUB_APP_ID", "42")
	t.Setenv("SMITHERS_GITHUB_APP_PRIVATE_KEY", "invalid")
	_, err = e.Load(ctx)
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = e.Load(canceled)
	require.ErrorIs(t, err, context.Canceled)
}

func TestGitHubAppEnvIdentityValidationIsLazyFailClosedAndCachesOnlySuccess(t *testing.T) {
	// C-GH-01 canonical Plue identity fixture. The HTTP stub is deliberately used
	// to inject malformed identity responses; real githubfake verifies valid JWTs.
	_, credentials := manifestFixture(t)
	t.Setenv("SMITHERS_GITHUB_APP_ID", "42")
	t.Setenv("SMITHERS_GITHUB_APP_PRIVATE_KEY", credentials.PEM)
	t.Setenv("SMITHERS_GITHUB_APP_SLUG", "poisoned")
	calls := 0
	response := `{"id":42,"slug":"canonical","owner":{"login":"acme","type":"Organization"}}`
	status := 200
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "/app", r.URL.Path)
		require.Equal(t, "GET", r.Method)
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		require.Len(t, parts, 3)
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		require.NoError(t, err)
		var claims map[string]any
		require.NoError(t, json.Unmarshal(payload, &claims))
		require.EqualValues(t, 42, claims["iss"])
		w.WriteHeader(status)
		_, _ = w.Write([]byte(response))
	}))
	defer server.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", server.URL)
	adapter := &EnvGitHubAppCredentials{}
	require.Zero(t, calls, "constructing the composition needs no network")
	for _, bad := range []string{`{"id":99,"slug":"canonical","owner":{"login":"acme","type":"Organization"}}`, `{"id":42,"owner":{"login":"acme","type":"Organization"}}`, `{"id":42,"slug":"canonical"}`} {
		response = bad
		_, err := adapter.InstallURL(context.Background())
		require.Error(t, err)
	}
	status = 503
	_, err := adapter.AppJWT(context.Background())
	require.Error(t, err)
	require.Equal(t, 4, calls)
	status = 200
	response = `{"id":42,"slug":"canonical","owner":{"login":"acme","type":"Organization"}}`
	t.Setenv("SMITHERS_GITHUB_APP_SLUG", "")
	location, err := adapter.InstallURL(context.Background())
	require.NoError(t, err)
	require.Equal(t, "https://github.com/apps/canonical/installations/new", location)
	require.Equal(t, 5, calls)
	_, err = adapter.AppJWT(context.Background())
	require.NoError(t, err)
	require.Equal(t, 5, calls)
	_, err = (&EnvGitHubAppCredentials{}).InstallURL(context.Background())
	require.NoError(t, err)
	require.Equal(t, 6, calls, "restart validates at its first caller")
}

func TestGitHubAppSetupSessionUnavailableFailsClosed(t *testing.T) {
	for _, s := range []*InstallSetupSessions{nil, {}} {
		_, err := s.Exchange(context.Background(), "token")
		require.Error(t, err)
		require.Error(t, s.Validate(context.Background(), strings.Repeat("a", 64)))
	}
}
