package services

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ValidExternalAgent admits only public external-agent labels. Reserved host
// labels cannot select the app-agent or terminal credential profile.
func ValidExternalAgent(agent string) bool {
	if len(agent) < 1 || len(agent) > 32 || agent == "smithers" || agent == "terminal" {
		return false
	}
	for _, ch := range agent {
		if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
			return false
		}
	}
	return true
}

func (s *AuthService) requireDelegatedMember(ctx context.Context, userID int64) error {
	if !config.IsSingleOwner(s.cfg) || s.queries == nil || s.Members == nil || s.Members.Pool == nil {
		return &AccessError{Status: http.StatusServiceUnavailable, Class: "infra", Code: "credential_issuer_unavailable", Message: "Credential issuer unavailable"}
	}
	role, err := InstallRoleOf(ctx, db.New(s.Members.Pool), userID)
	if err != nil {
		return err
	}
	if role == "" {
		return &AccessError{Status: http.StatusUnauthorized, Class: "permission", Code: "unauthenticated", Message: "Unauthenticated"}
	}
	return nil
}

// MintForTurn is host-only: no route accepts its subject or returns its bearer.
// The runner owns the turn subject and revokes the token with DeleteToken on
// completion or cancellation; every replacement rechecks active membership.
func (s *AuthService) MintForTurn(ctx context.Context, userID int64, turnID string) (CreateTokenResult, error) {
	if strings.TrimSpace(turnID) == "" {
		return CreateTokenResult{}, pkgerrors.BadRequest("turn subject is required")
	}
	return s.mintForSubject(ctx, userID, "app-turn-"+turnID, middleware.Delegation{Via: "smithers", Session: turnID}, []string{"repo", "user", "workspace", "agent"})
}

// MintForTerminal binds a host-issued terminal token to its immutable session
// and branch. No public scope or agent label can select this profile.
func (s *AuthService) MintForTerminal(ctx context.Context, userID, repositoryID int64, branchID, sessionID string) (CreateTokenResult, error) {
	if repositoryID <= 0 || strings.TrimSpace(branchID) == "" || strings.TrimSpace(sessionID) == "" {
		return CreateTokenResult{}, pkgerrors.BadRequest("terminal subject is required")
	}
	if err := s.requireDelegatedMember(ctx, userID); err != nil {
		return CreateTokenResult{}, err
	}
	subject, err := db.New(s.Members.Pool).GetWorkspaceSession(ctx, sessionID)
	if err != nil || subject.WorkspaceID != branchID || subject.RepositoryID != repositoryID || subject.UserID != userID || subject.Kind != "terminal" || (subject.Status != "pending" && subject.Status != "starting" && subject.Status != "running") {
		return CreateTokenResult{}, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Terminal subject is not active"}
	}
	return s.mintForSubject(ctx, userID, terminalCredentialName(sessionID), middleware.Delegation{Via: "terminal", Branch: branchID, Session: sessionID, Profile: middleware.TerminalProfileS1}, []string{string(middleware.ScopeReadRepository), string(middleware.ScopeReadUser), middleware.RepositoryRestrictionScope(repositoryID)})
}

func (s *AuthService) mintForSubject(ctx context.Context, userID int64, name string, binding middleware.Delegation, scopes []string) (CreateTokenResult, error) {
	if err := s.requireDelegatedMember(ctx, userID); err != nil {
		return CreateTokenResult{}, err
	}
	store, ok := s.queries.(accessTokenStore)
	if !ok {
		return CreateTokenResult{}, &AccessError{Status: 503, Class: "infra", Code: "credential_issuer_unavailable", Message: "Credential issuer unavailable"}
	}
	scopes = append(scopes, middleware.DelegationScopes(binding)...)
	token, err := issueTemporaryRepoTokenWithTTL(ctx, store, userID, name, strings.Join(scopes, ","), time.Hour)
	if err != nil {
		return CreateTokenResult{}, err
	}
	return CreateTokenResult{Token: token.Plaintext, TokenSummary: TokenSummary{ID: token.ID, Name: name, Scopes: scopes, ExpiresAt: &token.ExpiresAt, Kind: "delegated", Via: binding.Via}}, nil
}
