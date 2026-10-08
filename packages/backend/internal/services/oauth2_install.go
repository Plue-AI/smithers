package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type OAuth2ServiceOption func(*OAuth2Service)

func WithOAuth2InstallAuthorization(pool *pgxpool.Pool) OAuth2ServiceOption {
	return func(s *OAuth2Service) { s.install = &installAccountMutationStore{pool: pool} }
}

// A caller may revoke only the app and account its live OAuth credential names.
// Lock all target grants before the final credential check: deleting the source
// access token is the intended effect, so a post-deletion reload cannot admit it.
func (s *OAuth2Service) revokeInstallOAuth2AppTokens(ctx context.Context, appID, userID int64) error {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil {
		return &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if !info.IsTokenAuth || info.TokenSource != middleware.TokenSourceOAuth2AccessToken || info.OAuth2AppID != appID || info.User.ID != userID || appID <= 0 {
		return confirmationPermission()
	}
	if s.install.pool == nil {
		return confirmationPermission()
	}
	tx, err := s.install.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	repository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return err
	}
	if err = lockInstallRepositoryAdminMutation(ctx, tx, repository); err != nil {
		return err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, userID, false); err != nil {
		return err
	}
	subject, err := InstallAccountMutationSubject(repository, userID, "account.oauth.revoke", appID, struct{}{})
	if err != nil {
		return err
	}
	decision, err := Authorize(ctx, q, "account.oauth.revoke", subject)
	if err != nil {
		return err
	}
	ctx = WithInstallAuthorization(ctx, "account.oauth.revoke", decision, subject)
	// Refresh redemption consumes a refresh row before inserting access tokens.
	// Lock refresh grants first, then all access grants and the revocation journal.
	for _, query := range []string{
		`SELECT id FROM oauth2_refresh_tokens WHERE app_id=$1 AND user_id=$2 ORDER BY id FOR UPDATE`,
		`SELECT id FROM oauth2_access_tokens WHERE app_id=$1 AND user_id=$2 ORDER BY id FOR UPDATE`,
	} {
		rows, err := tx.Query(ctx, query, appID, userID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id int64
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	// The existing deletion trigger appends durable stream revocation events.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1548769901)`); err != nil {
		return err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, userID, false); err != nil {
		return err
	}
	stored, err := q.GetFirstPartyOAuth2AccessTokenByHash(ctx, info.TokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if err != nil {
		return err
	}
	if stored.AppID != appID || stored.UserID != userID {
		return confirmationPermission()
	}
	if err = revokeOAuth2AppTokens(ctx, q, appID, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
