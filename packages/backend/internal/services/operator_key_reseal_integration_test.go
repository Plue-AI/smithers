package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type operatorKeyFixture struct {
	pool                  *pgxpool.Pool
	owner                 db.User
	repositoryID, orgID   int64
	connectionID, command string
}

// seedOperatorKeyStores writes one value under oldCodec into every store the
// operator key seals, using the product services where they own the write.
func seedOperatorKeyStores(t *testing.T, oldCodec *webhook.AESGCMSecretCodec) operatorKeyFixture {
	t.Helper()
	ctx := context.Background()
	pool := newProductTestPool(t)
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "rotation-owner", LowerUsername: "rotation-owner", DisplayName: "Rotation Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "rotation", LowerName: "rotation", DefaultBookmark: "main"})
	require.NoError(t, err)
	org, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{Name: "rotation-org", LowerName: "rotation-org", Visibility: "private"})
	require.NoError(t, err)

	connection, err := NewProviderConnectionService(q, oldCodec, nil, WithSubscriptionConnectionsEnabled(true)).ConnectForUser(ctx, &owner, ConnectProviderInput{
		Provider: ProviderConnectionProviderCodex, Label: "rotation", AccessToken: "codex-rotation-access-token",
		RefreshToken: "codex-rotation-refresh-token", AccountID: "acct-rotation",
	})
	require.NoError(t, err)

	seal := func(value string) string {
		sealed, err := oldCodec.EncryptString(value)
		require.NoError(t, err)
		return sealed
	}
	exec := func(sql string, args ...any) {
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	exec(`INSERT INTO provider_connection_device_logins (user_id, provider, device_auth_id_encrypted, user_code, expires_at)
		VALUES ($1, 'codex', $2, 'ABCD-1234', now() + interval '10 minutes')`, owner.ID, []byte(seal("device-auth-id")))
	exec(`INSERT INTO owner_model_credentials (user_id, name, origin, value_encrypted) VALUES ($1, 'OPENAI_API_KEY', 'https://api.openai.com', $2)`,
		owner.ID, seal("owner-model-key"))
	exec(`INSERT INTO owner_model_credentials (user_id, name, origin, value_encrypted) VALUES ($1, 'UNSET_KEY', 'https://api.openai.com', NULL)`, owner.ID)
	exec(`INSERT INTO repository_secrets (repository_id, name, value_encrypted) VALUES ($1, 'REPO_SECRET', $2)`, repo.ID, []byte(seal("repository-secret")))
	exec(`INSERT INTO organization_secrets (organization_id, name, value_encrypted) VALUES ($1, 'ORG_SECRET', $2)`, org.ID, []byte(seal("organization-secret")))
	exec(`INSERT INTO repository_agent_environment_secrets (repository_id, name, value_encrypted) VALUES ($1, 'AGENT_SECRET', $2)`, repo.ID, []byte(seal("agent-secret")))
	exec(`INSERT INTO webhooks (repository_id, url, secret) VALUES ($1, 'https://hooks.example/a', $2), ($1, 'https://hooks.example/b', '')`, repo.ID, seal("webhook-signing-secret"))
	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id) VALUES ($1, $2) RETURNING id::text`, repo.ID, owner.ID).Scan(&workspaceID))
	control := "flow-host-control-credential"
	controlHash := sha256.Sum256([]byte(control))
	exec(`INSERT INTO flow_runtime_host_bindings (id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id, workspace_id,
			catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation, credential_ciphertext, credential_hash, state)
		VALUES ($1, 'repository:1', 'user:1', 'agent-session', 's-1', $2, $3, $4, 'coding', 'smithers-coding-host', $5, $6, 1, $7, $8, 'running')`,
		uuid.NewString(), repo.ID, owner.ID, workspaceID, strings.Repeat("a", 64), strings.Repeat("b", 40), seal(control), controlHash[:])

	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	payload, err := json.Marshal(workspaceCommandPayload{WorkspaceID: workspaceID, RepositoryID: repo.ID, UserID: owner.ID, EncryptedInput: seal(`{"operation_id":"op-1"}`)})
	require.NoError(t, err)
	receipt, err := store.Admit(ctx, jobs.Admission{Scope: repositoryJobFlowScope(repo.ID, owner.ID), Operation: workspaceCommandOperation,
		RequestID: workspaceID + ":op-1", Payload: payload, EffectPolicy: jobs.EffectUnsafe})
	require.NoError(t, err)
	return operatorKeyFixture{pool: pool, owner: owner, repositoryID: repo.ID, orgID: org.ID, connectionID: connection.ID, command: receipt.OperationID}
}

// readOperatorKeyStores opens every seeded value with codec.
func readOperatorKeyStores(t *testing.T, f operatorKeyFixture, codec webhook.SecretCodec) map[string]string {
	t.Helper()
	ctx := context.Background()
	got := map[string]string{}
	for name, query := range map[string]string{
		"access":      `SELECT convert_from(access_token_encrypted, 'UTF8') FROM provider_connections`,
		"refresh":     `SELECT convert_from(refresh_token_encrypted, 'UTF8') FROM provider_connections`,
		"device":      `SELECT convert_from(device_auth_id_encrypted, 'UTF8') FROM provider_connection_device_logins`,
		"owner model": `SELECT value_encrypted FROM owner_model_credentials WHERE value_encrypted IS NOT NULL`,
		"repository":  `SELECT convert_from(value_encrypted, 'UTF8') FROM repository_secrets`,
		"org":         `SELECT convert_from(value_encrypted, 'UTF8') FROM organization_secrets`,
		"agent":       `SELECT convert_from(value_encrypted, 'UTF8') FROM repository_agent_environment_secrets`,
		"webhook":     `SELECT secret FROM webhooks WHERE secret <> ''`,
		"flow host":   `SELECT credential_ciphertext FROM flow_runtime_host_bindings`,
		"command":     `SELECT payload->>'EncryptedInput' FROM product_job_requests`,
	} {
		var sealed string
		require.NoError(t, f.pool.QueryRow(ctx, query).Scan(&sealed), name)
		value, err := codec.DecryptString(sealed)
		if err != nil {
			got[name] = "<unreadable>"
			continue
		}
		got[name] = value
	}
	return got
}

var operatorKeyPlaintexts = map[string]string{
	"access": "codex-rotation-access-token", "refresh": "codex-rotation-refresh-token", "device": "device-auth-id",
	"owner model": "owner-model-key", "repository": "repository-secret", "org": "organization-secret", "agent": "agent-secret",
	"webhook": "webhook-signing-secret", "flow host": "flow-host-control-credential", "command": `{"operation_id":"op-1"}`,
}

func TestResealOperatorKeySecretsMovesEveryStoreToTheCurrentKeyPostgres(t *testing.T) {
	ctx := context.Background()
	oldCodec, err := webhook.NewSecretCodec("operator-key-old")
	require.NoError(t, err)
	f := seedOperatorKeyStores(t, oldCodec)
	var fingerprintBefore []byte
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT payload_fingerprint FROM product_job_requests WHERE id=$1`, f.command).Scan(&fingerprintBefore))

	newOnly, err := webhook.NewSecretCodec("operator-key-new")
	require.NoError(t, err)
	unreadable := readOperatorKeyStores(t, f, newOnly)
	for name := range operatorKeyPlaintexts {
		require.Equal(t, "<unreadable>", unreadable[name], "%s opens under the new key before the reseal", name)
	}

	rotating, err := webhook.NewSecretCodec("operator-key-new", "operator-key-old")
	require.NoError(t, err)
	counts, err := ResealOperatorKeySecrets(ctx, f.pool, rotating)
	require.NoError(t, err)
	byStore := map[string]OperatorKeyResealCount{}
	for _, count := range counts {
		byStore[count.Store] = count
	}
	require.Len(t, byStore, len(operatorKeyColumns)+1)
	for store, count := range byStore {
		resealed := int64(1)
		require.Equal(t, resealed, count.Resealed, store)
		require.Zero(t, count.Raced, store)
		// The settling pass finds every value current.
		wantCurrent := int64(1)
		if store == "webhooks.secret" {
			wantCurrent = 2 // and the empty secret
		}
		require.Equal(t, wantCurrent, count.Current, store)
	}

	// Every value now opens under the new key alone and holds its plaintext.
	require.Equal(t, operatorKeyPlaintexts, readOperatorKeyStores(t, f, newOnly))
	var fingerprintAfter []byte
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT payload_fingerprint FROM product_job_requests WHERE id=$1`, f.command).Scan(&fingerprintAfter))
	require.NotEqual(t, fingerprintBefore, fingerprintAfter, "the fingerprint follows the resealed payload")

	// The product reads the resealed credential with only the new key: the
	// model pool hands out the account's token.
	pick, err := NewProviderConnectionService(db.New(f.pool), newOnly, nil, WithSubscriptionConnectionsEnabled(true)).
		PickForModelCall(ctx, f.owner.ID, f.repositoryID, ProviderConnectionProviderCodex, nil)
	require.NoError(t, err)
	require.NotNil(t, pick.Connection)
	require.Equal(t, f.connectionID, pick.Connection.ConnectionID)
	require.Equal(t, "codex-rotation-access-token", pick.Connection.AccessToken)

	// A second pass finds everything current.
	again, err := ResealOperatorKeySecrets(ctx, f.pool, rotating)
	require.NoError(t, err)
	for _, count := range again {
		require.Zero(t, count.Resealed, count.Store)
		require.NotZero(t, count.Current, count.Store)
	}
}

func TestResealOperatorKeySecretsRefusesAValueNoKeyOpensPostgres(t *testing.T) {
	ctx := context.Background()
	oldCodec, err := webhook.NewSecretCodec("operator-key-old")
	require.NoError(t, err)
	f := seedOperatorKeyStores(t, oldCodec)
	stranger, err := webhook.NewSecretCodec("operator-key-stranger")
	require.NoError(t, err)
	foreign, err := stranger.EncryptString("foreign-secret-value")
	require.NoError(t, err)
	var id int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO repository_secrets (repository_id, name, value_encrypted) VALUES ($1, 'FOREIGN', $2) RETURNING id`,
		f.repositoryID, []byte(foreign)).Scan(&id))

	rotating, err := webhook.NewSecretCodec("operator-key-new", "operator-key-old")
	require.NoError(t, err)
	counts, err := ResealOperatorKeySecrets(ctx, f.pool, rotating)
	require.ErrorContains(t, err, fmt.Sprintf("reseal repository_secrets.value_encrypted row [%d]", id))
	require.NotContains(t, err.Error(), "foreign-secret-value")
	require.NotContains(t, err.Error(), foreign)
	require.Equal(t, "repository_secrets.value_encrypted", counts[len(counts)-1].Store)

	// Progress before the refusal is kept: a rerun with the new key alone
	// passes the resealed rows and stops at the same one.
	newOnly, err := webhook.NewSecretCodec("operator-key-new")
	require.NoError(t, err)
	counts, err = ResealOperatorKeySecrets(ctx, f.pool, newOnly)
	require.ErrorContains(t, err, fmt.Sprintf("reseal repository_secrets.value_encrypted row [%d]", id))
	require.Equal(t, OperatorKeyResealCount{Store: "provider_connections.access_token_encrypted", Current: 1}, counts[0])

	// Without the replaced key an unrotated store is refused at its first row.
	g := seedOperatorKeyStores(t, oldCodec)
	_, err = ResealOperatorKeySecrets(ctx, g.pool, newOnly)
	require.ErrorContains(t, err, "reseal provider_connections.access_token_encrypted row [")

	_, err = ResealOperatorKeySecrets(ctx, nil, rotating)
	require.Error(t, err)
	_, err = ResealOperatorKeySecrets(ctx, f.pool, nil)
	require.Error(t, err)
}

// racingResealer writes a fresh current-key value into the row being
// resealed, as a server holding the new key would, before answering.
type racingResealer struct {
	*webhook.AESGCMSecretCodec
	race func()
	once bool
}

func (r *racingResealer) Reseal(ciphertext string) (string, bool, error) {
	if !r.once {
		r.once = true
		r.race()
	}
	return r.AESGCMSecretCodec.Reseal(ciphertext)
}

func TestResealOperatorKeySecretsKeepsAConcurrentWritePostgres(t *testing.T) {
	ctx := context.Background()
	oldCodec, err := webhook.NewSecretCodec("operator-key-old")
	require.NoError(t, err)
	f := seedOperatorKeyStores(t, oldCodec)
	rotating, err := webhook.NewSecretCodec("operator-key-new", "operator-key-old")
	require.NoError(t, err)
	concurrent, err := rotating.EncryptString("codex-token-written-meanwhile")
	require.NoError(t, err)
	resealer := &racingResealer{AESGCMSecretCodec: rotating, race: func() {
		_, err := f.pool.Exec(ctx, `UPDATE provider_connections SET access_token_encrypted=$1`, []byte(concurrent))
		require.NoError(t, err)
	}}
	counts, err := ResealOperatorKeySecrets(ctx, f.pool, resealer)
	require.NoError(t, err)
	require.Equal(t, OperatorKeyResealCount{Store: "provider_connections.access_token_encrypted", Raced: 1, Current: 1}, counts[0],
		"the second pass finds the concurrent value current")
	var stored []byte
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT access_token_encrypted FROM provider_connections`).Scan(&stored))
	require.Equal(t, concurrent, string(stored), "the concurrent write wins")
}

func TestResealOperatorKeySecretsPagesThroughLargeStoresPostgres(t *testing.T) {
	ctx := context.Background()
	oldCodec, err := webhook.NewSecretCodec("operator-key-old")
	require.NoError(t, err)
	f := seedOperatorKeyStores(t, oldCodec)
	sealed, err := oldCodec.EncryptString("bulk")
	require.NoError(t, err)
	extra := operatorKeyResealPage + 7
	// Repository secrets are capped per repository: spread them over three.
	q := db.New(f.pool)
	for i, count := range []int{90, 90, extra - 180} {
		repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Name: fmt.Sprintf("bulk-%d", i),
			LowerName: fmt.Sprintf("bulk-%d", i), DefaultBookmark: "main"})
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `INSERT INTO repository_secrets (repository_id, name, value_encrypted)
			SELECT $1, 'BULK_' || n, $2 FROM generate_series(1, $3) AS n`, repo.ID, []byte(sealed), count)
		require.NoError(t, err)
	}
	_, err = f.pool.Exec(ctx, `INSERT INTO provider_connection_device_logins (user_id, provider, device_auth_id_encrypted, user_code, expires_at)
		SELECT $1, 'codex', $2, 'BULK-' || n, now() + interval '10 minutes' FROM generate_series(1, $3) AS n`, f.owner.ID, []byte(sealed), extra)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO owner_model_credentials (user_id, name, origin, value_encrypted)
		SELECT $1, 'BULK_' || n, 'https://api.openai.com', $2 FROM generate_series(1, $3) AS n`, f.owner.ID, sealed, extra)
	require.NoError(t, err)
	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	for i := range operatorKeyResealPage + 1 {
		payload, err := json.Marshal(workspaceCommandPayload{WorkspaceID: "w", RepositoryID: f.repositoryID, UserID: f.owner.ID, EncryptedInput: sealed})
		require.NoError(t, err)
		_, err = store.Admit(ctx, jobs.Admission{Scope: repositoryJobFlowScope(f.repositoryID, f.owner.ID), Operation: workspaceCommandOperation,
			RequestID: fmt.Sprintf("w:bulk-%d", i), Payload: payload, EffectPolicy: jobs.EffectUnsafe})
		require.NoError(t, err)
	}

	rotating, err := webhook.NewSecretCodec("operator-key-new", "operator-key-old")
	require.NoError(t, err)
	counts, err := ResealOperatorKeySecrets(ctx, f.pool, rotating)
	require.NoError(t, err)
	byStore := map[string]int64{}
	for _, count := range counts {
		byStore[count.Store] = count.Resealed
	}
	require.Equal(t, int64(extra+1), byStore["repository_secrets.value_encrypted"])
	require.Equal(t, int64(extra+1), byStore["provider_connection_device_logins.device_auth_id_encrypted"])
	require.Equal(t, int64(extra+1), byStore["owner_model_credentials.value_encrypted"])
	require.Equal(t, int64(operatorKeyResealPage+2), byStore["product_job_requests.payload(workspace.command)"])
	var remaining int
	newOnly, err := webhook.NewSecretCodec("operator-key-new")
	require.NoError(t, err)
	rows, err := f.pool.Query(ctx, `SELECT convert_from(value_encrypted, 'UTF8') FROM repository_secrets
		UNION ALL SELECT convert_from(device_auth_id_encrypted, 'UTF8') FROM provider_connection_device_logins
		UNION ALL SELECT value_encrypted FROM owner_model_credentials WHERE value_encrypted IS NOT NULL
		UNION ALL SELECT payload->>'EncryptedInput' FROM product_job_requests`)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var value string
		require.NoError(t, rows.Scan(&value))
		if _, err := newOnly.DecryptString(value); err != nil {
			remaining++
		}
	}
	require.NoError(t, rows.Err())
	require.Zero(t, remaining)
}

func TestResealOperatorKeySecretsRepeatsUntilNothingIsUnderAPreviousKeyPostgres(t *testing.T) {
	ctx := context.Background()
	oldCodec, err := webhook.NewSecretCodec("operator-key-old")
	require.NoError(t, err)
	f := seedOperatorKeyStores(t, oldCodec)
	var stale []byte
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT refresh_token_encrypted FROM provider_connections`).Scan(&stale))
	rotating, err := webhook.NewSecretCodec("operator-key-new", "operator-key-old")
	require.NoError(t, err)

	// A stale writer copies the old refresh token back once, after the first
	// pass resealed it: the second pass reseals it again.
	copies := 1
	resealer := &passHookResealer{AESGCMSecretCodec: rotating, afterStore: func(store string) {
		if store == "provider_connection_device_logins.device_auth_id_encrypted" && copies > 0 {
			copies--
			_, err := f.pool.Exec(ctx, `UPDATE provider_connections SET refresh_token_encrypted=$1`, stale)
			require.NoError(t, err)
		}
	}}
	counts, err := ResealOperatorKeySecrets(ctx, f.pool, resealer)
	require.NoError(t, err)
	require.Equal(t, OperatorKeyResealCount{Store: "provider_connections.refresh_token_encrypted", Resealed: 2, Current: 1}, counts[1])
	newOnly, err := webhook.NewSecretCodec("operator-key-new")
	require.NoError(t, err)
	require.Equal(t, operatorKeyPlaintexts, readOperatorKeyStores(t, f, newOnly))

	// A writer that keeps copying the old value back is reported, and the
	// previous key must not retire.
	_, err = f.pool.Exec(ctx, `UPDATE provider_connections SET refresh_token_encrypted=$1`, stale)
	require.NoError(t, err)
	stubborn := &passHookResealer{AESGCMSecretCodec: rotating, beforeReseal: func(plaintext string) {
		if plaintext == "codex-rotation-refresh-token" {
			again, err := oldCodec.EncryptString(plaintext)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE provider_connections SET refresh_token_encrypted=$1`, []byte(again))
			require.NoError(t, err)
		}
	}}
	_, err = ResealOperatorKeySecrets(ctx, f.pool, stubborn)
	require.ErrorContains(t, err, "kept reappearing")
}

// passHookResealer runs beforeReseal with each value's plaintext and
// afterStore when it reaches the device login value.
type passHookResealer struct {
	*webhook.AESGCMSecretCodec
	afterStore   func(store string)
	beforeReseal func(plaintext string)
}

func (r *passHookResealer) Reseal(ciphertext string) (string, bool, error) {
	if plaintext, err := r.DecryptString(ciphertext); err == nil {
		if r.beforeReseal != nil {
			r.beforeReseal(plaintext)
		}
		if plaintext == "device-auth-id" && r.afterStore != nil {
			r.afterStore("provider_connection_device_logins.device_auth_id_encrypted")
		}
	}
	return r.AESGCMSecretCodec.Reseal(ciphertext)
}
