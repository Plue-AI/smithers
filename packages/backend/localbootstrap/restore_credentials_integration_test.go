//go:build darwin

package localbootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// restoreHarness backs an install state root up and restores it into another
// with the Mac backup and restore coordinators, the kernel clone and the
// PostgreSQL programs a bundle packages. Each state root owns its database
// under postgres/, as an install does.
type restoreHarness struct {
	t       *testing.T
	bin     string
	version hostbackup.Version
}

func newRestoreHarness(t *testing.T) restoreHarness {
	t.Helper()
	bin, major := testdb.Tools(t)
	if major != 18 {
		t.Fatalf("an install packages PostgreSQL 18, got %d", major)
	}
	schema, err := product.HeadVersion()
	if err != nil {
		t.Fatal(err)
	}
	return restoreHarness{t: t, bin: bin, version: hostbackup.Version{Release: "1.0.0-rc.1", Schema: schema, PostgresMajor: major}}
}

// start runs the state root's own database and opens a pool on it.
func (h restoreHarness) start(state string) (*postgres.Instance, *pgxpool.Pool) {
	h.t.Helper()
	database, err := postgres.Start(context.Background(), postgres.Config{BinDir: h.bin, StateDir: filepath.Join(state, "postgres"), Major: h.version.PostgresMajor, StartupTimeout: 20 * time.Second})
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := database.Stop(ctx); err != nil {
			h.t.Error(err)
		}
	})
	pool, err := postgresfixture.Open(context.Background(), database.ConnectionString, 0)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(pool.Close)
	return database, pool
}

// backup publishes one snapshot of state: the supervised database's dump and
// a clone of every tree beside it.
func (h restoreHarness) backup(state string, database *postgres.Instance) string {
	h.t.Helper()
	directory, err := hostbackup.Backup(h.t.Context(), hostbackup.BackupConfig{FreeSpaceFloor: 1 << 20, State: state, Version: h.version, Authority: restoreSource{database}, Cloner: hostbackup.APFSCloner{}})
	if err != nil {
		h.t.Fatal(err)
	}
	return directory
}

// restore publishes the backup into target, a state root no install holds.
func (h restoreHarness) restore(backup, target string) {
	h.t.Helper()
	authority := restoreTarget{postgres.Config{BinDir: h.bin, Major: h.version.PostgresMajor, StartupTimeout: 20 * time.Second}}
	if _, err := hostbackup.Restore(h.t.Context(), hostbackup.RestoreConfig{State: target, Backup: backup, Version: h.version, Authority: authority, Cloner: hostbackup.APFSCloner{}}); err != nil {
		h.t.Fatal(err)
	}
}

// restoreSource is the owner bridge's database half without its socket.
type restoreSource struct{ database *postgres.Instance }

func (restoreSource) Check(context.Context) error { return nil }
func (a restoreSource) DatabaseSize(ctx context.Context) (uint64, error) {
	return a.database.DatabaseSize(ctx)
}
func (restoreSource) Freeze(context.Context, string) (time.Time, error) {
	return time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC), nil
}
func (restoreSource) Renew(context.Context, string) error  { return nil }
func (restoreSource) Reopen(context.Context, string) error { return nil }
func (a restoreSource) Dump(ctx context.Context, target io.Writer) error {
	return a.database.Dump(ctx, target)
}
func (restoreSource) Summary(context.Context) (hostbackup.Manifest, error) {
	return hostbackup.Manifest{Stack: json.RawMessage(`[]`), BranchHeads: json.RawMessage(`{}`), MachineDisks: json.RawMessage(`[]`), RunJournals: json.RawMessage(`[]`)}, nil
}

// restoreTarget loads the dump as an install's restore does. The test starts
// the restored state itself, so the lifecycle steps have nothing to do.
type restoreTarget struct{ postgres postgres.Config }

func (restoreTarget) CheckStopped(context.Context) error                                { return nil }
func (restoreTarget) CheckRetainedIsolation(context.Context, hostbackup.Manifest) error { return nil }
func (restoreTarget) StartRestored(context.Context, string) error                       { return nil }
func (a restoreTarget) RestoreDatabase(ctx context.Context, stage *os.Root, dump io.Reader, _ hostbackup.Version) error {
	config := a.postgres
	config.StateDir = filepath.Join(stage.Name(), "postgres")
	return postgres.RestoreInto(ctx, config, dump)
}

// providerPoolCall sends one pooled ChatGPT call through the product handler
// and reports the status and the credential the provider received.
func providerPoolCall(t *testing.T, pool *pgxpool.Pool, codec *webhook.AESGCMSecretCodec, bearer string) (int, string) {
	t.Helper()
	var mu sync.Mutex
	received := ""
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		received = r.Header.Get("Authorization") + " account=" + r.Header.Get("Chatgpt-Account-Id")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_1","output":[]}`))
	}))
	defer provider.Close()
	q := db.New(pool)
	handler := &routes.ProviderPoolHandler{
		Pool:      services.NewProviderConnectionService(q, codec, nil, services.WithSubscriptionConnectionsEnabled(true)),
		Scopes:    services.NewProviderPoolScopes(q, pool, codec),
		Upstreams: map[string]string{"chatgpt": provider.URL},
	}
	request := httptest.NewRequest(http.MethodPost, services.ProviderPoolPath+"/chatgpt/codex/responses", strings.NewReader(`{"model":"gpt-5","input":"hi"}`))
	request.Header.Set("Authorization", "Bearer "+bearer)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	mu.Lock()
	defer mu.Unlock()
	return response.Code, received
}

// A connected provider account survives backup and restore: the restored
// installation reopens the operator key from its restored secrets file, and
// a model call with the restored binding credential reaches the provider
// with the account's token. A rotation on the restored installation keeps
// the account working and retires the backed-up key.
func TestRestoredProviderCredentialServesModelCallsPostgres(t *testing.T) {
	h := newRestoreHarness(t)
	clearBootstrapEnvironment(t)
	t.Setenv(previousOperatorKeysName, "")
	_ = os.Unsetenv(previousOperatorKeysName)
	ctx := context.Background()

	sourceRoot := t.TempDir()
	if _, err := configure(sourceRoot); err != nil {
		t.Fatal(err)
	}
	backedUpKey := os.Getenv(operatorKeyName)
	sourceDatabase, sourcePool := h.start(sourceRoot)
	if err := product.Apply(ctx, sourcePool); err != nil {
		t.Fatal(err)
	}
	sourceCodec, err := webhook.NewSecretCodec(backedUpKey)
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(sourcePool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "restore-owner", LowerUsername: "restore-owner", DisplayName: "Restore Owner"})
	if err != nil {
		t.Fatal(err)
	}
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "restore", LowerName: "restore", DefaultBookmark: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := services.NewProviderConnectionService(q, sourceCodec, nil, services.WithSubscriptionConnectionsEnabled(true)).ConnectForUser(ctx, &owner, services.ConnectProviderInput{
		Provider: services.ProviderConnectionProviderCodex, Label: "restore", AccessToken: "codex-restored-access-token",
		RefreshToken: "codex-restored-refresh-token", AccountID: "acct-restore",
	}); err != nil {
		t.Fatal(err)
	}
	var workspaceID string
	if err := sourcePool.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id) VALUES ($1, $2) RETURNING id::text`, repo.ID, owner.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	bindingID, control := uuid.NewString(), "restore-flow-host-control"
	sealedControl, err := sourceCodec.EncryptString(control)
	if err != nil {
		t.Fatal(err)
	}
	controlHash := sha256.Sum256([]byte(control))
	if _, err := sourcePool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings (id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id, workspace_id,
			catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation, credential_ciphertext, credential_hash, state)
		VALUES ($1, 'repository:1', 'user:1', 'agent-session', 's-1', $2, $3, $4, 'coding', 'smithers-coding-host', $5, $6, 1, $7, $8, 'running')`,
		bindingID, repo.ID, owner.ID, workspaceID, strings.Repeat("a", 64), strings.Repeat("b", 40), sealedControl, controlHash[:]); err != nil {
		t.Fatal(err)
	}
	bearer := flowhost.ModelCredential(bindingID, control)
	const delivered = "Bearer codex-restored-access-token account=acct-restore"
	if code, got := providerPoolCall(t, sourcePool, sourceCodec, bearer); code != http.StatusOK || got != delivered {
		t.Fatalf("source call = %d %q", code, got)
	}

	backup := h.backup(sourceRoot, sourceDatabase)
	// Another account: a state root that does not exist until the restore.
	targetRoot := filepath.Join(t.TempDir(), "Smithers")
	h.restore(backup, targetRoot)

	// The restored installation starts with none of the source's secrets in
	// its environment and reads them from the restored file.
	for _, name := range secretNames {
		_ = os.Unsetenv(name)
	}
	if _, err := configure(targetRoot); err != nil {
		t.Fatal(err)
	}
	restoredKey := os.Getenv(operatorKeyName)
	if restoredKey != backedUpKey {
		t.Fatal("the restored installation did not reopen the backed-up operator key")
	}
	_, targetPool := h.start(targetRoot)
	restoredCodec, err := webhook.NewSecretCodec(restoredKey)
	if err != nil {
		t.Fatal(err)
	}
	if code, got := providerPoolCall(t, targetPool, restoredCodec, bearer); code != http.StatusOK || got != delivered {
		t.Fatalf("restored call = %d %q", code, got)
	}

	// The database alone is not enough: without the restored key the
	// binding credential and the account do not open.
	stranger, err := webhook.NewSecretCodec("a-fresh-installation-key")
	if err != nil {
		t.Fatal(err)
	}
	if code, got := providerPoolCall(t, targetPool, stranger, bearer); code != http.StatusForbidden || got != "" {
		t.Fatalf("call without the restored key = %d %q", code, got)
	}

	// Rotating the restored installation's key keeps the account working.
	// The rotation runs as its own process, which never loaded the file.
	for _, name := range secretNames {
		_ = os.Unsetenv(name)
	}
	if _, err := RotateOperatorKey(ctx, targetRoot, func(ctx context.Context, current string, previous []string) error {
		codec, err := webhook.NewSecretCodec(current, previous...)
		if err != nil {
			return err
		}
		_, err = services.ResealOperatorKeySecrets(ctx, targetPool, codec)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, name := range append(secretNames, previousOperatorKeysName) {
		_ = os.Unsetenv(name)
	}
	if _, err := configure(targetRoot); err != nil {
		t.Fatal(err)
	}
	rotatedKey := os.Getenv(operatorKeyName)
	if rotatedKey == backedUpKey || os.Getenv(previousOperatorKeysName) != "" {
		t.Fatal("rotation did not replace and retire the key")
	}
	rotatedCodec, err := webhook.NewSecretCodec(rotatedKey, config.WebhookConfig{PreviousSecretEncryptionKeys: os.Getenv(previousOperatorKeysName)}.PreviousKeys()...)
	if err != nil {
		t.Fatal(err)
	}
	if code, got := providerPoolCall(t, targetPool, rotatedCodec, bearer); code != http.StatusOK || got != delivered {
		t.Fatalf("rotated call = %d %q", code, got)
	}
	if code, _ := providerPoolCall(t, targetPool, restoredCodec, bearer); code != http.StatusForbidden {
		t.Fatalf("the retired key still opens the restored credentials: %d", code)
	}
}
