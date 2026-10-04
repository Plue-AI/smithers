package seed

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// OwnerToken seeds the verified identity prerequisite for tests of other
// subsystems. OAuth and live GitHub permission are tested separately through
// HTTP in owner_signin_integration_test and setup_claim_integration_test.
func OwnerToken(ctx context.Context, pool *pgxpool.Pool, username string) (string, error) {
	userID, err := CreateUser(ctx, pool, username)
	if err != nil {
		return "", err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, userID); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, userID); err != nil {
		return "", err
	}
	binding := map[string]any{"owner_login": username, "repository_name": "fixture", "repository_id": 0}
	value, _ := json.Marshal(binding)
	q := db.New(tx)
	if err = q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: value}); err != nil {
		return "", err
	}
	binding["last_access_check_at"] = time.Now().UTC()
	value, _ = json.Marshal(binding)
	if err = q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: value}); err != nil {
		return "", err
	}
	random := make([]byte, 32)
	if _, err = rand.Read(random); err != nil {
		return "", err
	}
	token := hex.EncodeToString(random)
	digest := sha256.Sum256([]byte(token))
	if _, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: userID, Name: "integration", TokenHash: hex.EncodeToString(digest[:]), TokenLastEight: token[len(token)-8:], Scopes: "all"}); err != nil {
		return "", err
	}
	return token, tx.Commit(ctx)
}
