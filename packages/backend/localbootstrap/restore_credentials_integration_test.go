package localbootstrap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// restoreHarness runs the packaged backup.sh and restore.sh against real
// PostgreSQL and data roots.
type restoreHarness struct {
	t            *testing.T
	distribution string
	env          []string
}

func newRestoreHarness(t *testing.T) restoreHarness {
	t.Helper()
	// The packaged scripts need PostgreSQL client tools of the server's major
	// version, as the distribution tests do.
	bin := os.Getenv("SMITHERS_POSTGRES_TEST_BIN")
	if bin == "" {
		t.Skip("SMITHERS_POSTGRES_TEST_BIN names no PostgreSQL client tools")
	}
	if testdb.ServerURL() == "" {
		testdb.Unavailable(t, testdb.ErrNotConfigured)
	}
	distribution, err := filepath.Abs("../../../distribution")
	if err != nil {
		t.Fatal(err)
	}
	// The container serializes maintenance with flock(1); the maintenance
	// lock itself is exercised by the distribution tests.
	fake := t.TempDir()
	if err := os.WriteFile(filepath.Join(fake, "flock"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return restoreHarness{t: t, distribution: distribution, env: []string{
		"PATH=" + fake + ":" + bin + ":" + os.Getenv("PATH"),
		"SMITHERS_LIB=" + filepath.Join(distribution, "lib.sh"),
		"SMITHERS_RELEASE_FILE=" + filepath.Join(distribution, "version.env"),
	}}
}

func (h restoreHarness) run(script string, env []string, args ...string) string {
	h.t.Helper()
	command := exec.Command("sh", append([]string{filepath.Join(h.distribution, script)}, args...)...)
	command.Env = append(append(os.Environ(), h.env...), env...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	out, err := command.Output()
	if err != nil {
		h.t.Fatalf("%s: %v\n%s", script, err, stderr.String())
	}
	return strings.TrimSpace(string(out))
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
	release, err := os.ReadFile(filepath.Join(h.distribution, "version.env"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "version.env"), release, 0o600); err != nil {
		t.Fatal(err)
	}
	sourcePool, sourceURL := postgresfixture.NewProductDatabase(t)
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

	backups := t.TempDir()
	backup := h.run("backup.sh", []string{"SMITHERS_DATABASE_URL=" + sourceURL, "SMITHERS_DATA_ROOT=" + sourceRoot, "SMITHERS_BACKUP_ROOT=" + backups})
	target := testdb.New(t)
	targetRoot := t.TempDir()
	h.run("restore.sh", []string{"SMITHERS_DATABASE_URL=" + target.URL, "SMITHERS_DATA_ROOT=" + targetRoot}, backup)

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
	targetPool, err := postgresfixture.Open(ctx, target.URL, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(targetPool.Close)
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
