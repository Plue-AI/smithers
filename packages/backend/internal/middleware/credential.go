package middleware

import (
	"context"
	stdErrors "errors"
	"strings"
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

// ReadsRepositoriesForTurn admits a person's repository read authority or an
// delegated repository reader. Callers must ReloadCredential first: that lookup fences
// the app bearer to its live producer generation and checks the account.
func (a *AuthInfo) ReadsRepositoriesForTurn() bool {
	if a.ReadsRepositoriesAsPerson() {
		return true
	}
	delegation, ok := a.Delegation()
	// External credentials retain their explicit read scope after PAT migration.
	// App credentials additionally belong to one live producer generation.
	reader := delegation.Via == "smithers" && delegation.Session != "" ||
		delegation.Via != "smithers" && delegation.Via != "terminal" && delegation.Session == ""
	return ok && a.User != nil && !IsAgentAccount(a.User.UserType) && reader &&
		delegation.Branch == "" && delegation.Profile == "" &&
		a.Scopes.Has(ScopeReadRepository) && a.RepositoryRestriction() == 0 &&
		len(ParseTokenPathRestrictions(a.RawScopes)) == 0 && a.WorkspaceRestriction() == ""
}

// BindInstallCredential derives legacy install PATs' delegated CLI identity.
// Call after each store reload as well as HTTP authentication; stored scopes,
// never the prior request's role or scopes, determine the fresh authority.
func BindInstallCredential(info *AuthInfo) bool {
	if info == nil || info.User == nil {
		return false
	}
	if !info.IsTokenAuth || info.TokenSystemIssued || IsAgentAccount(info.User.UserType) {
		return true
	}
	entries := []string{}
	for _, entry := range tokenScopeEntries(info.RawScopes) {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if strings.HasPrefix(entry, "credential:") || strings.HasPrefix(entry, workspaceRestrictionScopePrefix) || strings.HasPrefix(entry, landingWorkspaceScopePrefix) {
			return false
		}
		if strings.HasPrefix(entry, delegationViaScopePrefix) || strings.HasPrefix(entry, delegationProfileScopePrefix) || strings.HasPrefix(entry, delegationBranchScopePrefix) || strings.HasPrefix(entry, delegationSessionScopePrefix) {
			continue
		}
		entries = append(entries, entry)
	}
	info.TokenSystemIssued = true
	info.RawScopes = strings.Join(append(entries, "via:cli"), ",")
	return true
}
