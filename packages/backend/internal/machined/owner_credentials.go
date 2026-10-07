package machined

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

//go:embed owner_token.py
var ownerTokenProgram string

type OwnerSessionCredentials struct {
	mu         sync.Mutex
	prepared   *Terminal
	preparedID string
	sessions   *Sessions
	user       SessionUser
	branch     string
}

func NewOwnerSessionCredentials(sessions *Sessions, user SessionUser, branch string) *OwnerSessionCredentials {
	return &OwnerSessionCredentials{sessions: sessions, user: user, branch: branch}
}
func (w *OwnerSessionCredentials) PutSessionToken(ctx context.Context, branch, id string, token []byte, expected string) (string, error) {
	if token == nil {
		return "", fmt.Errorf("missing delegated token")
	}
	if err := workspaceapi.ValidateSessionCredential(id, token); err != nil {
		return "", err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(expected, true); err != nil {
		return "", err
	}
	if expected == "" {
		expected = "absent"
	}
	if err := w.run(ctx, branch, "put", id, token, expected); err != nil {
		return "", err
	}
	return fmt.Sprintf("/run/smithers/%d/token/sessions/%s/token", w.user.UID, id), nil
}
func (w *OwnerSessionCredentials) DeleteSessionToken(ctx context.Context, branch, id, expected string) error {
	if err := workspaceapi.ValidateSessionCredential(id, nil); err != nil {
		return err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(expected, false); err != nil {
		return err
	}
	return w.run(ctx, branch, "delete", id, nil, expected)
}
func (w *OwnerSessionCredentials) run(ctx context.Context, branch, op, id string, token []byte, expected string) error {
	if branch != w.branch || !validUser(w.user) || w.user.Login == "agent" {
		return ErrUnauthorized
	}
	w.mu.Lock()
	terminal := w.prepared
	if op != "put" || expected != "absent" || id != w.preparedID {
		terminal = nil
	} else {
		w.prepared = nil
	}
	w.mu.Unlock()
	var err error
	if terminal == nil {
		terminal, err = w.open(ctx, op, id, expected)
		if err != nil {
			return err
		}
	}
	defer terminal.Close()
	if len(token) > 0 {
		if _, err = terminal.Write(token); err != nil {
			return err
		}
	}
	if err = terminal.stream.Send(ctx, []byte{2, 0}); err != nil {
		return err
	}
	// Never expose credential-helper stderr or token content in API errors.
	_, err = io.Copy(io.Discard, terminal)
	if err != nil || !terminal.exitSeen {
		return fmt.Errorf("owner credential write refused")
	}
	return nil
}

// Prepare admits the owner-uid credential helper before the host mints a token.
// Missing broker providers therefore cannot mint even a transient bearer.
func (w *OwnerSessionCredentials) Prepare(ctx context.Context, id string) error {
	if !validUser(w.user) || w.user.Login == "agent" {
		return ErrUnauthorized
	}
	if err := workspaceapi.ValidateSessionCredential(id, nil); err != nil {
		return err
	}
	terminal, err := w.open(ctx, "put", id, "absent")
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.prepared != nil {
		_ = terminal.Close()
		return fmt.Errorf("credential helper already prepared")
	}
	w.prepared = terminal
	w.preparedID = id
	return nil
}
func (w *OwnerSessionCredentials) ClosePrepared() {
	w.mu.Lock()
	terminal := w.prepared
	w.prepared = nil
	w.mu.Unlock()
	if terminal != nil {
		_ = terminal.Close()
	}
}
func (w *OwnerSessionCredentials) open(ctx context.Context, op, id, expected string) (*Terminal, error) {
	session, err := w.sessions.OpenSession(ctx, w.user, SessionExec, []string{"/usr/bin/python3", "-I", "-S", "-c", ownerTokenProgram, op, strconv.FormatUint(uint64(w.user.UID), 10), id, expected}, nil)
	if err != nil {
		return nil, err
	}
	stream, err := w.sessions.Stream(ctx, session)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = w.sessions.CloseSession(cleanup, session)
		return nil, err
	}
	return &Terminal{stream: stream, ctx: ctx, cancel: func() {}}, nil
}
