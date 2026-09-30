package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

func TestKeysCommandValidatesBeforeOpeningDatabase(t *testing.T) {
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "")
	for _, args := range [][]string{{"keys"}, {"keys", "list"}, {"keys", "rotate", "now"}, {"keys", "reseal"}} {
		opens := 0
		var out bytes.Buffer
		handled, err := Dispatch(t.Context(), args, Config{OpenDatabase: func(context.Context) (*pgxpool.Pool, error) {
			opens++
			return nil, errors.New("database opened")
		}, Stdout: &out})
		require.True(t, handled, args)
		require.Error(t, err, args)
		require.Zero(t, opens, args)
		require.Empty(t, out.String(), args)
	}
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "new")
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS", "old,,older")
	_, err := Dispatch(t.Context(), []string{"keys", "reseal"}, Config{})
	require.ErrorContains(t, err, "previous secret encryption key is empty")
}

func keysTestDatabase(t *testing.T) (*pgxpool.Pool, Config, *bytes.Buffer) {
	t.Helper()
	if testdb.ServerURL() == "" {
		testdb.Unavailable(t, testdb.ErrNotConfigured)
	}
	pool, url := postgresfixture.NewProductDatabase(t)
	_, err := pool.Exec(t.Context(), `INSERT INTO users (id, username, lower_username) VALUES (101, 'alice', 'alice');
		INSERT INTO repositories (id, user_id, name, lower_name, default_bookmark) VALUES (201, 101, 'app', 'app', 'main')`)
	require.NoError(t, err)
	var out bytes.Buffer
	return pool, Config{OpenDatabase: func(ctx context.Context) (*pgxpool.Pool, error) { return postgresfixture.Open(ctx, url, 0) }, Stdout: &out}, &out
}

// provisionJournal gives a workspace a Flow journal role on pool's server whose
// password operatorKey derives, as a hosted backend does before a host starts.
func provisionJournal(t *testing.T, pool *pgxpool.Pool, operatorKey string) (string, flowhost.JournalDatabase) {
	t.Helper()
	journals, err := flowhost.NewPostgresJournals(t.Context(), pool, testdb.ServerURL(), flowhost.JournalKey(operatorKey))
	require.NoError(t, err)
	workspace := uuid.NewString()
	t.Cleanup(func() { _ = journals.Drop(context.Background(), workspace) })
	journal, err := journals.Provision(t.Context(), workspace)
	require.NoError(t, err)
	return workspace, journal
}

// requireJournalKey proves the journal role signs in only with the password
// operatorKey derives, and no longer with the replaced one.
func requireJournalKey(t *testing.T, pool *pgxpool.Pool, workspace string, replaced flowhost.JournalDatabase, operatorKey string) {
	t.Helper()
	_, err := pgx.Connect(t.Context(), replaced.URL)
	require.ErrorContains(t, err, "password authentication failed")
	journals, err := flowhost.NewPostgresJournals(t.Context(), pool, testdb.ServerURL(), flowhost.JournalKey(operatorKey))
	require.NoError(t, err)
	current, err := journals.Describe(workspace)
	require.NoError(t, err)
	conn, err := pgx.Connect(t.Context(), current.URL)
	require.NoError(t, err)
	require.NoError(t, conn.Close(t.Context()))
}

func sealedSecret(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var sealed []byte
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT value_encrypted FROM repository_secrets WHERE name='API_KEY'`).Scan(&sealed))
	return string(sealed)
}

func TestKeysResealMovesSecretsToTheEnvironmentKeyThroughProductDatabase(t *testing.T) {
	pool, cfg, out := keysTestDatabase(t)
	old, err := webhook.NewSecretCodec("old-operator-key")
	require.NoError(t, err)
	sealed, err := old.EncryptString("repository-api-key")
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO repository_secrets (repository_id, name, value_encrypted) VALUES (201, 'API_KEY', $1)`, []byte(sealed))
	require.NoError(t, err)
	workspace, journal := provisionJournal(t, pool, "old-operator-key")

	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "new-operator-key")
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS", "old-operator-key")
	handled, err := Dispatch(t.Context(), []string{"keys", "reseal"}, cfg)
	require.True(t, handled)
	require.NoError(t, err)
	require.Contains(t, out.String(), "repository_secrets.value_encrypted resealed=1 current=1 raced=0\n")
	require.True(t, strings.HasSuffix(out.String(), "flow journal roles resealed=1\n"))
	require.NotContains(t, out.String(), "repository-api-key")
	requireJournalKey(t, pool, workspace, journal, "new-operator-key")
	current, err := webhook.NewSecretCodec("new-operator-key")
	require.NoError(t, err)
	value, err := current.DecryptString(sealedSecret(t, pool))
	require.NoError(t, err)
	require.Equal(t, "repository-api-key", value)

	// Without the previous key a value it sealed is refused, naming the row.
	stale, err := old.EncryptString("stale")
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO repository_secrets (repository_id, name, value_encrypted) VALUES (201, 'STALE', $1)`, []byte(stale))
	require.NoError(t, err)
	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS", "")
	out.Reset()
	_, err = Dispatch(t.Context(), []string{"keys", "reseal"}, cfg)
	require.ErrorContains(t, err, "reseal repository_secrets.value_encrypted row")
	require.Contains(t, out.String(), "repository_secrets.value_encrypted resealed=0 current=1 raced=0\n")
	require.NotContains(t, out.String(), "flow journal roles", "a failed reseal leaves the journal passwords alone")
}

func TestKeysRotateReplacesTheDataRootKeyThroughProductDatabase(t *testing.T) {
	pool, cfg, out := keysTestDatabase(t)
	root := t.TempDir()
	configDir := filepath.Join(root, "config")
	require.NoError(t, os.MkdirAll(configDir, 0o700))
	values := map[string]string{}
	for _, name := range []string{"SMITHERS_AUTH_SESSION_SECRET", "SMITHERS_LFS_SIGNING_SECRET", "SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY",
		"SMITHERS_REPO_HOST_AUTH_TOKEN", "SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "SMITHERS_AUTH_BOOTSTRAP_TOKEN"} {
		values[name] = "file-" + strings.ToLower(name)
	}
	encoded, err := json.Marshal(map[string]any{"version": 1, "values": values})
	require.NoError(t, err)
	secretsPath := filepath.Join(configDir, "secrets.json")
	require.NoError(t, os.WriteFile(secretsPath, encoded, 0o600))
	old, err := webhook.NewSecretCodec(values["SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"])
	require.NoError(t, err)
	sealed, err := old.EncryptString("repository-api-key")
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO repository_secrets (repository_id, name, value_encrypted) VALUES (201, 'API_KEY', $1)`, []byte(sealed))
	require.NoError(t, err)
	workspace, journal := provisionJournal(t, pool, values["SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"])

	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "")
	require.NoError(t, os.Unsetenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"))
	t.Setenv("SMITHERS_DATA_ROOT", root)
	handled, err := Dispatch(t.Context(), []string{"keys", "rotate"}, cfg)
	require.True(t, handled)
	require.NoError(t, err)
	require.Contains(t, out.String(), "repository_secrets.value_encrypted resealed=1 current=1 raced=0\n")
	require.True(t, strings.HasSuffix(out.String(), "operator key rotated\n"))

	var file struct {
		Values map[string]string `json:"values"`
	}
	raw, err := os.ReadFile(secretsPath)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &file))
	rotated := file.Values["SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"]
	require.NotEqual(t, values["SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"], rotated)
	require.NotContains(t, out.String(), rotated, "the new key is never printed")
	require.NotContains(t, file.Values, "SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS")
	current, err := webhook.NewSecretCodec(rotated)
	require.NoError(t, err)
	value, err := current.DecryptString(sealedSecret(t, pool))
	require.NoError(t, err)
	require.Equal(t, "repository-api-key", value)
	_, err = old.DecryptString(sealedSecret(t, pool))
	require.Error(t, err, "the replaced key no longer opens the secret")
	require.Contains(t, out.String(), "flow journal roles resealed=1\n")
	requireJournalKey(t, pool, workspace, journal, rotated)

	// An unreachable database leaves the rotation resumable.
	failing := Config{OpenDatabase: func(context.Context) (*pgxpool.Pool, error) { return nil, errors.New("database down") }, Stdout: out}
	_, err = Dispatch(t.Context(), []string{"keys", "rotate"}, failing)
	require.ErrorContains(t, err, "database down")
	raw, err = os.ReadFile(secretsPath)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &file))
	require.Equal(t, rotated, file.Values["SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS"])
	out.Reset()
	_, err = Dispatch(t.Context(), []string{"keys", "rotate"}, cfg)
	require.NoError(t, err)
	require.True(t, strings.HasSuffix(out.String(), "operator key rotation resumed and completed\n"))

	t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "environment-key")
	_, err = Dispatch(t.Context(), []string{"keys", "rotate"}, cfg)
	require.ErrorContains(t, err, "keys reseal")
}
