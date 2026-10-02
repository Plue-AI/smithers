package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Block the real token insert in PostgreSQL. Its source PAT must remain locked
// on the same transaction until both writes commit; loading through the outer
// pool would release that lock before the insertion and fail this regression.
func TestOAuth2GrantSourceLockSurvivesUntilTokenCommit(t *testing.T) {
	pool := newProductTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	q := db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "grant-lock", LowerUsername: "grant-lock", DisplayName: "grant-lock"})
	require.NoError(t, err)
	app, err := q.CreateOAuth2Application(ctx, db.CreateOAuth2ApplicationParams{
		ClientID: FirstPartyClientID, ClientSecretHash: "public-client", Name: "grant-lock", RedirectUris: []string{"http://localhost/callback"}, Scopes: []string{"read:user"}, OwnerID: user.ID, Confidential: false,
	})
	require.NoError(t, err)
	pat, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: "grant-source", TokenHash: "source-hash", TokenLastEight: "rce-hash", Scopes: "read:user", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := pool.Exec(context.Background(), "DELETE FROM oauth2_applications WHERE id = $1", app.ID)
		require.NoError(t, err)
	})
	svc := NewOAuth2ServiceWithPool(q, pool)
	verifier := "verifier-verifier-verifier-verifier-verifier"
	code, err := svc.AuthorizeGrant(ctx, OAuth2AuthorizeInput{UserID: user.ID, ClientID: app.ClientID, RedirectURI: app.RedirectUris[0], Scope: "read:user", CodeChallenge: pkceChallengeForTest(verifier), CodeChallengeMethod: "S256", CallerScopes: []string{"read:user"}, SourceAccessTokenID: pat.ID})
	require.NoError(t, err)
	// This dedicated connection blocks INSERT without replacing any service or
	// query implementation. pg_locks below observes the real insertion waiting.
	blocker, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer blocker.Release()
	_, err = blocker.Exec(ctx, `SELECT pg_advisory_lock(92421, 1)`)
	require.NoError(t, err)
	defer blocker.Exec(context.Background(), `SELECT pg_advisory_unlock(92421, 1)`)
	_, err = pool.Exec(ctx, `CREATE FUNCTION block_oauth_access_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(92421, 1); RETURN NEW; END $$; CREATE TRIGGER block_access BEFORE INSERT ON oauth2_access_tokens FOR EACH ROW EXECUTE FUNCTION block_oauth_access_insert()`)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() {
		_, err := svc.ExchangeCode(ctx, app.ClientID, "", code.Code, app.RedirectUris[0], verifier)
		done <- err
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=92421 AND objid=1 AND NOT granted)`).Scan(&waiting)
		return err == nil && waiting
	}, 5*time.Second, 10*time.Millisecond, "token INSERT never reached its database barrier")
	updater, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer updater.Rollback(context.Background())
	_, err = updater.Exec(ctx, `SET LOCAL lock_timeout='150ms'`)
	require.NoError(t, err)
	_, err = updater.Exec(ctx, `UPDATE access_tokens SET expires_at=expires_at WHERE id=$1`, pat.ID)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr, "source metadata must remain locked until the derived pair commits")
	require.Equal(t, "55P03", pgErr.Code)
	require.NoError(t, updater.Rollback(ctx))
	_, err = blocker.Exec(ctx, `SELECT pg_advisory_unlock(92421, 1)`)
	require.NoError(t, err)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET expires_at=expires_at WHERE id=$1`, pat.ID)
	require.NoError(t, err, "commit must release the source lock")
	var source int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT source_access_token_id FROM oauth2_refresh_tokens WHERE user_id=$1`, user.ID).Scan(&source))
	require.Equal(t, pat.ID, source)
}
