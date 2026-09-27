package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type ChatConnectorTokenStore interface {
	accessTokenStore
	GetAuthInfoByTokenHash(context.Context, string) (db.GetAuthInfoByTokenHashRow, error)
}

// IssueChatConnectorCredential uses the owner credential only to authorize the
// backend's own sync worker. It never changes or hands that credential to the
// child. Reauthorization on rotation observes revocation and permission changes.
func (s *IssueService) IssueChatConnectorCredential(ctx context.Context, store ChatConnectorTokenStore, owner, repo, bootstrap string) (string, func(), error) {
	sum := sha256.Sum256([]byte(strings.TrimSpace(bootstrap)))
	row, err := store.GetAuthInfoByTokenHash(ctx, hex.EncodeToString(sum[:]))
	if err != nil {
		return "", nil, api.Unauthorized("invalid connector bootstrap credential")
	}
	scopes := row.TokenScopes
	if row.TokenSystemIssued || row.ProhibitLogin || !middleware.ParseTokenScopes(scopes).Has(middleware.ScopeWriteRepository) ||
		middleware.ParseTokenWorkspaceRestriction(scopes) != "" || middleware.ParseTokenAgentSessionRestriction(scopes) != "" ||
		middleware.ParseTokenLandingWorkspace(scopes) != "" || len(middleware.ParseTokenPathRestrictions(scopes)) != 0 {
		return "", nil, api.Forbidden("connector bootstrap requires an owner repository write credential")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return "", nil, err
	}
	if bound := middleware.ParseTokenRepositoryRestriction(scopes); bound != 0 && bound != repository.ID {
		return "", nil, api.Forbidden("connector bootstrap is bound to another repository")
	}
	if err := s.requireWriteAccess(ctx, repository, &db.User{ID: row.ID}); err != nil {
		return "", nil, err
	}
	token, err := issueTemporaryRepoToken(ctx, store, row.ID, "chat-connector", string(middleware.ScopeWriteRepository)+","+
		middleware.RepositoryRestrictionScope(repository.ID)+","+middleware.SyncCredentialScope())
	if err != nil {
		return "", nil, err
	}
	return token.Plaintext, func() { revokeTemporaryRepoCloneToken(ctx, store, row.ID, token.ID) }, nil
}
