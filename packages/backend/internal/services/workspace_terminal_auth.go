package services

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// AuthenticateOwnerTerminalToken fences S2 bearers against the in-process
// manager and the persisted token. Restart loses the live subject; deleting a
// token or revoking its member takes effect even if guest cleanup is delayed.
func (s *WorkspaceService) AuthenticateOwnerTerminalToken(ctx context.Context, hash string) (*middleware.AuthInfo, error) {
	issuer := s.credentialIssuer
	if s.terminalCredentials == nil || issuer == nil || issuer.TerminalSubject == nil || issuer.Members == nil {
		return nil, nil
	}
	var found *terminalCredential
	s.terminalCredentials.Range(func(_, value any) bool {
		c := value.(*terminalCredential)
		c.mu.Lock()
		matches := c.ownerUID >= 20000 && !c.closed && c.tokenID != 0 && c.identity == hash
		c.mu.Unlock()
		if matches {
			found = c
			return false
		}
		return true
	})
	if found == nil {
		return nil, nil
	}
	found.mu.Lock()
	catalog := found.catalogDelegation
	id, user, repo, branch, session := found.tokenID, found.userID, found.repositoryID, found.workspaceID, found.sessionID
	expectedScopes := found.scopes()
	found.mu.Unlock()
	if catalog && (issuer.TerminalCatalogReady == nil || !issuer.TerminalCatalogReady(ctx, user, repo, branch, session)) {
		return nil, nil
	}
	q := db.New(issuer.Members.Pool)
	token, err := q.GetAccessTokenByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if token.Scopes != expectedScopes || token.Name != terminalCredentialName(session) || !token.SystemIssued || token.UserID != user || token.TokenHash != hash || !token.ExpiresAt.Valid || !token.ExpiresAt.Time.After(time.Now()) {
		return nil, nil
	}
	person, err := q.GetUserByID(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !person.IsActive || person.ProhibitLogin || person.DeletedAt.Valid || !issuer.TerminalSubject(user, repo, branch, session) {
		return nil, nil
	}
	if err := issuer.requireDelegatedMember(ctx, user); err != nil {
		return nil, err
	}
	return &middleware.AuthInfo{User: &person, TokenID: token.ID, TokenSystemIssued: true, TokenHash: hash, RawScopes: token.Scopes, Scopes: middleware.ParseTokenScopes(token.Scopes), IsTokenAuth: true, TokenSource: middleware.TokenSourcePersonalAccessToken}, nil
}
