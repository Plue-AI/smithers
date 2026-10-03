package seed

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// InstallOwner records username as the install's owner, as a GitHub sign-in
// carrying the setup token does, and mints an API token for it. Tests that
// drive a real backend use it in place of the GitHub round trip; the sign-in
// itself is covered by the owner sign-in integration test.
func InstallOwner(ctx context.Context, pool *pgxpool.Pool, username string, githubUserID int64) (string, error) {
	username = strings.TrimSpace(username)
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := "smithers_" + hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		q := db.New(tx)
		user, err := q.CreateOwnerUser(ctx, db.CreateOwnerUserParams{
			Username: username, LowerUsername: strings.ToLower(username), DisplayName: username,
		})
		if err != nil {
			return err
		}
		if _, err := q.CreateOwnerMember(ctx, db.CreateOwnerMemberParams{
			UserID: user.ID, GithubUserID: pgtype.Int8{Int64: githubUserID, Valid: true}, Login: username,
		}); err != nil {
			return err
		}
		if _, err := q.DeleteInstallSetting(ctx, "setup_token"); err != nil {
			return err
		}
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{
			UserID: user.ID, Name: "test-owner", TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
			Scopes: "write:repository,write:user,write:workspace,write:approval,write:agent",
		})
		return err
	})
	if err != nil {
		return "", err
	}
	return token, nil
}
