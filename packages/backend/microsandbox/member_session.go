package microsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// MemberCredentials retains the host-authorized account across rotations. The
// same guest token CAS is used for every writer; a client cannot choose a UID.
type MemberCredentials struct {
	runtime *Runtime
	member  MemberIdentity
}

func (r *Runtime) SessionCredentialsForMember(ctx context.Context, id string, member MemberIdentity) (*MemberCredentials, error) {
	if _, err := r.EnsureMember(ctx, id, member); err != nil {
		return nil, err
	}
	return &MemberCredentials{r, member}, nil
}
func (c *MemberCredentials) PutSessionToken(ctx context.Context, id, session string, token []byte, expected string) (string, error) {
	if err := workspaceapi.ValidateSessionCredential(session, token); err != nil {
		return "", err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(expected, true); err != nil {
		return "", err
	}
	if token == nil {
		return "", fmt.Errorf("missing session credential")
	}
	if _, err := c.runtime.EnsureMember(ctx, id, c.member); err != nil {
		return "", err
	}
	ws, err := c.runtime.runningWorkspace(id)
	if err != nil {
		return "", err
	}
	if _, err = c.runtime.guest(ctx, ws.Machine, token, "put-member-token", c.member.Login, strconv.Itoa(c.member.UID), session, tokenIdentityArgument(expected)); err != nil {
		return "", err
	}
	return workspaceapi.SessionTokenRoot + "/" + session + "/token", nil
}
func (c *MemberCredentials) DeleteSessionToken(ctx context.Context, id, session, expected string) error {
	if err := workspaceapi.ValidateSessionCredential(session, nil); err != nil {
		return err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(expected, false); err != nil {
		return err
	}
	// Cleanup must still work after membership revocation. It can only remove
	// this lifecycle's exact bearer, through the assigned account and inode CAS.
	ws, err := c.runtime.runningWorkspace(id)
	if errors.Is(err, workspaceapi.ErrWorkspaceStopped) || errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = c.runtime.guest(ctx, ws.Machine, nil, "delete-member-token", c.member.Login, strconv.Itoa(c.member.UID), session, expected)
	return err
}

// OpenTerminal consumes one sealed admission at the installed SessionRPC door.
// Account provisioning, current membership, token identity and connection fences
// all precede spawn. There is no host PTY or msb exec -t fallback here.
func (c *MemberCredentials) OpenTerminal(ctx context.Context, id, session, digest string, command workspaceapi.Command) (workspaceapi.Terminal, error) {
	if err := workspaceapi.ValidateSessionCredential(session, nil); err != nil {
		return nil, err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(digest, false); err != nil {
		return nil, err
	}
	r := c.runtime
	ws, err := r.runningWorkspace(id)
	if err != nil {
		return nil, err
	}
	ws.sessionMu.Lock()
	defer ws.sessionMu.Unlock()
	if r.config.Bundle == nil || r.cli == nil {
		return nil, ErrUnavailable
	}
	r.mu.Lock()
	roster := r.memberRoster
	r.mu.Unlock()
	if roster == nil {
		return nil, ErrUnavailable
	}
	var terminal workspaceapi.Terminal
	err = roster(ctx, id, func(members []MemberIdentity) error {
		if err := r.provisionMembers(ctx, ws.Machine, members, &c.member); err != nil {
			return err
		}
		var err error
		terminal, err = c.openAdmitted(ctx, ws, session, digest, command)
		return err
	})
	return terminal, err
}

// Keep the authoritative membership read lock through the broker's reply so
// removal cannot commit between authorization and process creation.
func (c *MemberCredentials) openAdmitted(ctx context.Context, ws *workspace, session, digest string, command workspaceapi.Command) (workspaceapi.Terminal, error) {
	r, id := c.runtime, ws.ID
	link, err := r.machined.Current(id)
	if err != nil {
		return nil, err
	}
	if err = link.RequireReady(id); err != nil {
		return nil, err
	}
	sessions := machined.NewSessions(link.Connection, id, r.machined.Sessions(id))
	if command.Directory != "" && command.Directory != guestRoot {
		return nil, fmt.Errorf("terminal directory must be workspace root")
	}
	if len(command.Args) == 0 {
		command.Args = []string{"/bin/sh"}
	}
	environment := make(map[string]string, len(command.Environment)+3)
	for k, v := range command.Environment {
		environment[k] = v
	}
	environment["TERM"] = "xterm-256color"
	if environment["SMITHERS_TOKEN_FILE"] != workspaceapi.SessionTokenRoot+"/"+session+"/token" || environment["SMITHERS_URL"] == "" {
		return nil, fmt.Errorf("terminal credential environment is missing")
	}
	binding := struct {
		Login       string            `json:"login"`
		UID         int               `json:"uid"`
		Session     string            `json:"session"`
		Digest      string            `json:"token_sha256"`
		Environment map[string]string `json:"environment"`
	}{c.member.Login, c.member.UID, session, digest, environment}
	body, err := json.Marshal(binding)
	if err != nil {
		return nil, err
	}
	if len(body) > 256*1024 {
		return nil, fmt.Errorf("session admission exceeds limit")
	}
	if _, err = r.guest(ctx, ws.Machine, body, "put-session-binding", c.member.Login, strconv.Itoa(c.member.UID)); err != nil {
		return nil, err
	}
	terminal, err := sessions.OpenTerminal(ctx, machined.SessionUser{Login: c.member.Login, UID: uint32(c.member.UID)}, command.Args, &machined.SessionSize{Cols: 80, Rows: 24})
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = r.guest(cleanup, ws.Machine, nil, "delete-session-binding", c.member.Login, strconv.Itoa(c.member.UID))
	}
	return terminal, err
}

var _ workspaceapi.SessionCredentialWriter = (*MemberCredentials)(nil)
