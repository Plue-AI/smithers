package services

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// A signed-in terminal (T-TRM-02, spec §5.3.2): when a person opens a
// terminal on a branch, the host mints a delegated credential for that
// person, branch and terminal session with the stage-1 terminal profile,
// writes it to the session's own token file, and names that file in the
// shell's SMITHERS_TOKEN_FILE beside SMITHERS_URL. The credential lives only
// while someone has the terminal open: the last WebSocket's close revokes it
// and deletes the file, a reattach mints a fresh one into the same file, and
// the terminal's close or the session's destroy revoke it for good. The
// person's own credential never enters the terminal.
const (
	// terminalCredentialTTL is a terminal credential's lifetime (spec §5.3.0).
	terminalCredentialTTL = time.Hour
	// terminalCredentialRenewal replaces the credential before it expires.
	terminalCredentialRenewal = 45 * time.Minute
	// terminalCredentialVia is the stored via of a terminal's credential.
	terminalCredentialVia = "terminal"
)

func terminalCredentialName(sessionID string) string { return "terminal-session-" + sessionID }

// terminalCredential is one terminal session's delegated credential.
type terminalCredential struct {
	ownerUID     uint32
	registry     *sync.Map
	issuer       *AuthService
	tokens       accessTokenStore
	writer       workspaceapi.SessionCredentialWriter
	workspaceID  string
	sessionID    string
	userID       int64
	repositoryID int64
	url          string

	mu       sync.Mutex
	path     string
	identity string
	tokenID  int64 // the live token; 0 while revoked
	holders  int
	closed   bool
	renew    *time.Timer
}

// signInWorkspaceTerminal mints the session's first credential and answers
// it, or nil when the runtime cannot place a session credential or the
// backend has no URL its sessions reach.
func (s *WorkspaceService) signInWorkspaceTerminal(ctx context.Context, row db.Workspace, sessionID string, userID int64) (*terminalCredential, error) {
	writer, ok := s.runtime.(workspaceapi.SessionCredentialWriter)
	url := strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/")
	if !ok || s.q == nil || url == "" {
		if _, installed := s.runtime.(interface {
			SessionCredentialsForMember(context.Context, string, microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error)
		}); installed {
			return nil, errors.New("installed terminal credential providers unavailable")
		}
		return nil, nil
	}
	if runtime, installed := s.runtime.(interface {
		SessionCredentialsForMember(context.Context, string, microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error)
	}); installed {
		roster, available := s.q.(interface {
			ListCollaboratorsByRepo(context.Context, int64) ([]db.Collaborator, error)
		})
		if !available {
			return nil, errors.New("terminal member roster unavailable")
		}
		members, err := roster.ListCollaboratorsByRepo(ctx, row.RepositoryID)
		if err != nil {
			return nil, err
		}
		var allocated *microsandbox.MemberIdentity
		for _, member := range members {
			if member.UserID.Valid && member.UserID.Int64 == userID && !member.SuspendedAt.Valid && (member.Permission == "write" || member.Permission == "admin") && member.UnixLogin.Valid && member.UnixUid >= 20000 {
				if allocated != nil {
					return nil, errors.New("terminal member allocation is ambiguous")
				}
				allocated = &microsandbox.MemberIdentity{Login: member.UnixLogin.String, UID: int(member.UnixUid), Active: true}
			}
		}
		if allocated == nil {
			return nil, errors.New("terminal member allocation unavailable")
		}
		bound, err := runtime.SessionCredentialsForMember(ctx, row.ID, *allocated)
		if err != nil {
			return nil, err
		}
		writer = bound
	}
	credential := &terminalCredential{registry: s.terminalCredentials, issuer: s.credentialIssuer, tokens: s.q, writer: writer, workspaceID: row.ID,
		sessionID: sessionID, userID: userID, repositoryID: row.RepositoryID, url: url}
	if err := s.installTerminalCredential(ctx, credential); err != nil {
		return nil, err
	}
	return credential, nil
}

// Serialize replacements before writing the shared session path. Retiring the
// previous lifecycle first prevents its late close or renewal from deleting or
// replacing the new lifecycle's file.
func (s *WorkspaceService) installTerminalCredential(ctx context.Context, credential *terminalCredential) error {
	s.terminalCredentialMu.Lock()
	defer s.terminalCredentialMu.Unlock()
	if s.terminalCredentials != nil {
		if previous, loaded := s.terminalCredentials.Load(credential.sessionID); loaded {
			previous.(*terminalCredential).Close()
		}
	}
	credential.mu.Lock()
	err := credential.issueLocked(ctx)
	credential.mu.Unlock()
	if err != nil {
		return err
	}
	if s.terminalCredentials != nil {
		s.terminalCredentials.Store(credential.sessionID, credential)
	}
	return nil
}

// environment is what the signed-in shell is started with.
func (c *terminalCredential) environment() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return map[string]string{"SMITHERS_TOKEN_FILE": c.path, "SMITHERS_URL": c.url}
}

func (c *terminalCredential) scopes() string {
	entries := []string{string(middleware.ScopeReadRepository), string(middleware.ScopeReadUser),
		middleware.RepositoryRestrictionScope(c.repositoryID)}
	entries = append(entries, middleware.DelegationScopes(middleware.Delegation{Via: terminalCredentialVia,
		Branch: c.workspaceID, Profile: middleware.TerminalProfileS1, Session: c.sessionID})...)
	return strings.Join(entries, ",")
}

// issueLocked mints a fresh credential, writes it over the session's file
// and only then revokes the one it replaces.
func (c *terminalCredential) issueLocked(ctx context.Context) error {
	q := c.tokens
	var token temporaryRepoCloneToken
	var err error
	if c.issuer != nil {
		var minted CreateTokenResult
		minted, err = c.issuer.MintForTerminal(ctx, c.userID, c.repositoryID, c.workspaceID, c.sessionID)
		if err == nil {
			token = temporaryRepoCloneToken{ID: minted.ID, Plaintext: minted.Token, ExpiresAt: *minted.ExpiresAt}
		}
	} else {
		token, err = issueTemporaryRepoTokenWithTTL(ctx, q, c.userID, terminalCredentialName(c.sessionID), c.scopes(), terminalCredentialTTL)
	}
	if err != nil {
		return err
	}
	path, err := c.writer.PutSessionToken(ctx, c.workspaceID, c.sessionID, []byte(token.Plaintext), c.identity)
	if err != nil {
		revokeTemporaryRepoCloneToken(ctx, q, c.userID, token.ID)
		return err
	}
	if c.tokenID != 0 {
		revokeTemporaryRepoCloneToken(ctx, q, c.userID, c.tokenID)
	}
	c.path, c.tokenID = path, token.ID
	c.identity = workspaceapi.SessionCredentialIdentity([]byte(token.Plaintext))
	if c.renew != nil {
		c.renew.Stop()
	}
	c.renew = time.AfterFunc(terminalCredentialRenewal, c.renewal)
	return nil
}

// revokeLocked deletes the live credential and its file.
func (c *terminalCredential) revokeLocked() {
	if c.renew != nil {
		c.renew.Stop()
		c.renew = nil
	}
	if c.tokenID == 0 {
		return
	}
	revokeTemporaryRepoCloneToken(context.Background(), c.tokens, c.userID, c.tokenID)
	c.tokenID = 0
	ctx, cancel := context.WithTimeout(context.Background(), temporaryRepoTokenRevokeTimeout)
	defer cancel()
	if err := c.writer.DeleteSessionToken(ctx, c.workspaceID, c.sessionID, c.identity); err != nil {
		slog.Warn("terminal credential file removal failed", "session_id", c.sessionID, "error", err)
	}
	c.identity = ""
}

func (c *terminalCredential) renewal() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.tokenID == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := c.issueLocked(ctx); err != nil {
		slog.Warn("terminal credential renewal failed", "session_id", c.sessionID, "error", err)
	}
}

var errTerminalClosed = errors.New("terminal closed")

// AcquireCredential is called when a WebSocket attaches to the terminal: a
// terminal nobody had open gets a fresh credential in its file.
func (c *terminalCredential) AcquireCredential(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errTerminalClosed
	}
	if c.tokenID == 0 {
		if err := c.issueLocked(ctx); err != nil {
			return err
		}
	}
	c.holders++
	return nil
}

// ReleaseCredential is called when a WebSocket detaches: the last one's
// close revokes the credential.
func (c *terminalCredential) ReleaseCredential() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.holders > 0 {
		c.holders--
	}
	if c.holders == 0 {
		c.revokeLocked()
	}
}

// Close revokes the credential for good: the terminal ended or its session
// was destroyed.
func (c *terminalCredential) Close() {
	c.mu.Lock()
	c.closed = true
	c.revokeLocked()
	c.mu.Unlock()
	if c.registry != nil {
		c.registry.CompareAndDelete(c.sessionID, c)
	}
}

// signedInTerminal is a runtime terminal with its session's credential.
type signedInTerminal struct {
	workspaceapi.Terminal
	*terminalCredential
}

func (t *signedInTerminal) Close() error {
	err := t.Terminal.Close()
	t.terminalCredential.Close()
	return err
}

// revokeWorkspaceTerminalCredential revokes a destroyed session's terminal
// credential, on this replica and in the store.
func (s *WorkspaceService) revokeWorkspaceTerminalCredential(ctx context.Context, session db.WorkspaceSession, userID int64) {
	if s.terminalCredentials != nil {
		if credential, ok := s.terminalCredentials.Load(session.ID); ok {
			credential.(*terminalCredential).Close()
		}
	}
	store, ok := s.q.(interface {
		DeleteSystemAccessTokensByName(context.Context, db.DeleteSystemAccessTokensByNameParams) error
	})
	if !ok {
		return
	}
	if err := store.DeleteSystemAccessTokensByName(context.WithoutCancel(ctx), db.DeleteSystemAccessTokensByNameParams{UserID: userID, Name: terminalCredentialName(session.ID)}); err != nil {
		slog.Warn("terminal credential revocation failed", "session_id", session.ID, "error", err)
	}
}
