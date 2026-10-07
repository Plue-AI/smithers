package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// InstallSubscriptionCredential is resolved from provider connections, never
// enrolled as an API key. The owner setting gates every resolution.
const InstallSubscriptionCredential = "CHATGPT_SUBSCRIPTION"

// InstallSubscriptionDigest exposes presence and a rotation identity only.
func InstallSubscriptionDigest(ctx context.Context, pool *pgxpool.Pool, ownerID int64) (string, error) {
	q := db.New(pool)
	enabled, err := InstallChatGPTEnabled(ctx, q)
	if err != nil || !enabled {
		return "", err
	}
	var installOwner int64
	err = pool.QueryRow(ctx, `SELECT user_id FROM self_host_owners WHERE singleton`).Scan(&installOwner)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if installOwner != ownerID {
		return "", nil
	}
	repository, err := q.InstallRepositoryID(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	preference, err := q.GetRepositoryProviderConnectionPreference(ctx, repository)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if preference == ProviderConnectionPreferencePlatformOnly || preference == ProviderConnectionPreferenceOrgOnly {
		return "", nil
	}
	var digest string
	err = pool.QueryRow(ctx, `SELECT COALESCE(md5(string_agg(id||':'||md5(access_token_encrypted),',' ORDER BY id)), '')
 FROM provider_connections WHERE owner_type='user' AND user_id=$1 AND provider='codex' AND kind='oauth' AND state='active'`, ownerID).Scan(&digest)
	return digest, err
}
