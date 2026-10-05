package middleware

import (
	"context"
	stdErrors "errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Credential names the credential that authenticated a request by what the
// store files it under: an API token's hash or a browser session's storage
// key. A consumer that later acts for the request, such as an app-agent turn
// reading source, keeps it and resolves it again before each act, so the act
// ends when the credential is revoked, expires, loses a scope or its account
// is suspended.
type Credential struct {
	TokenHash   string
	SessionHash string
}

// CredentialOf names the credential info authenticated; the zero value when
// there is none.
func CredentialOf(info *AuthInfo) Credential {
	switch {
	case info == nil:
		return Credential{}
	case info.IsTokenAuth:
		return Credential{TokenHash: info.TokenHash}
	default:
		return Credential{SessionHash: info.SessionHash}
	}
}

// ErrCredentialGone means a kept credential no longer authenticates: it was
// revoked or expired, or its account is suspended, disabled or deleted.
var ErrCredentialGone = stdErrors.New("credential no longer authenticates")

// ReloadCredential resolves a kept credential as AuthLoader resolves one now,
// without refreshing it. It answers ErrCredentialGone for a credential that
// no longer authenticates and any other error only when the store could not
// answer.
func ReloadCredential(ctx context.Context, queries AuthLoaderQuerier, credential Credential, now time.Time) (*AuthInfo, error) {
	var (
		info *AuthInfo
		err  error
	)
	switch {
	case credential.TokenHash != "" && credential.SessionHash == "":
		info, err = loadTokenAuthByHash(ctx, queries, credential.TokenHash)
		if stdErrors.Is(err, errAccountSuspended) {
			return nil, ErrCredentialGone
		}
	case credential.SessionHash != "" && credential.TokenHash == "":
		session, lookupErr := queries.GetAuthSessionBySessionKey(ctx, credential.SessionHash)
		if stdErrors.Is(lookupErr, pgx.ErrNoRows) {
			return nil, ErrCredentialGone
		}
		if lookupErr != nil {
			return nil, lookupErr
		}
		info, err = sessionAuthInfo(ctx, queries, session, credential.SessionHash, now)
	default:
		return nil, ErrCredentialGone
	}
	if err != nil {
		return nil, err
	}
	if info == nil || info.User == nil {
		return nil, ErrCredentialGone
	}
	return info, nil
}

// ReadsRepositoriesAsPerson reports whether a credential may read repository
// content for its account beyond the one route it was presented to: a
// person's browser session, or a person's token that holds read:repository
// and is bound to no repository, path or workspace.
func (a *AuthInfo) ReadsRepositoriesAsPerson() bool {
	if a == nil || a.User == nil || a.IsAgent() {
		return false
	}
	if !a.IsTokenAuth {
		return a.SessionHash != ""
	}
	return a.Scopes.Has(ScopeReadRepository) && a.RepositoryRestriction() == 0 &&
		len(ParseTokenPathRestrictions(a.RawScopes)) == 0 && a.WorkspaceRestriction() == ""
}
