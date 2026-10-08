package services

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Only the host lifecycle owns this key. It is never included in the guest
// environment, token writer, terminal stream or a command response.
func (c *terminalCredential) issuePersonLocked(ctx context.Context) (string, error) {
	if c.issuer == nil || c.issuer.Members == nil {
		return "", nil
	}
	if err := c.issuer.requireDelegatedMember(ctx, c.userID); err != nil {
		return "", err
	}
	key := c.issuer.generateSession()
	binding, err := json.Marshal(map[string]any{"kind": "session", "via": "terminal", "member": c.userID, "branch": c.workspaceID, "terminal_session": c.sessionID})
	if err != nil {
		return "", err
	}
	_, err = c.issuer.Members.Pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,is_admin,data,expires_at) SELECT $1,id,username,is_admin,$3, $4 FROM users WHERE id=$2`, sessionStorageKey(key), c.userID, binding, time.Now().Add(terminalCredentialTTL))
	return key, err
}
func (c *terminalCredential) revokePerson(key string) {
	if key == "" || c.issuer == nil || c.issuer.Members == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), temporaryRepoTokenRevokeTimeout)
	defer cancel()
	if err := db.New(c.issuer.Members.Pool).DeleteAuthSession(ctx, sessionStorageKey(key)); err != nil {
		slog.Warn("terminal person session removal failed", "session_id", c.sessionID, "error", err)
	}
}

// TerminalPersonCommand reauthenticates the stored host session and the live
// terminal before dispatch. Callers cannot supply a bearer or choose an actor.
func (s *WorkspaceService) TerminalPersonCommand(ctx context.Context, session string, repository, member int64, dispatch func(context.Context) error) error {
	refused := func() error {
		return &AccessError{Status: http.StatusUnauthorized, Class: "permission", Code: "unauthenticated", Message: "Unauthenticated"}
	}
	if s.terminalCredentials == nil {
		return refused()
	}
	value, ok := s.terminalCredentials.Load(session)
	if !ok {
		return refused()
	}
	c := value.(*terminalCredential)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.tokenID == 0 || c.personBearer == "" || c.userID != member || c.repositoryID != repository || c.issuer == nil || c.issuer.Members == nil {
		return refused()
	}
	if c.issuer.TerminalSubject != nil && !c.issuer.TerminalSubject(member, repository, c.workspaceID, session) {
		return refused()
	}
	if err := c.issuer.requireDelegatedMember(ctx, member); err != nil {
		return err
	}
	q := db.New(c.issuer.Members.Pool)
	info, err := middleware.ReloadCredential(ctx, q, middleware.Credential{SessionHash: sessionStorageKey(c.personBearer)}, time.Now())
	if err != nil {
		return refused()
	}
	stored, err := q.GetAuthSessionBySessionKey(ctx, info.SessionHash)
	if err != nil {
		return refused()
	}
	var binding struct {
		Kind    string `json:"kind"`
		Via     string `json:"via"`
		Member  int64  `json:"member"`
		Branch  string `json:"branch"`
		Session string `json:"terminal_session"`
	}
	if json.Unmarshal(stored.Data, &binding) != nil || binding.Kind != "session" || binding.Via != "terminal" || binding.Member != member || binding.Branch != c.workspaceID || binding.Session != session {
		return refused()
	}
	// This is a new catalog dispatch under the broker-owned credential.
	ctx = context.WithValue(ctx, installAuthorizationKey{}, nil)
	return dispatch(middleware.ContextWithAuthInfo(ctx, info))
}
