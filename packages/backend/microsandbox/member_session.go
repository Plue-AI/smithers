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
	return fmt.Sprintf("/run/smithers/%d/token/sessions/%s/token", c.member.UID, session), nil
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

// MemberActor commits immutable attribution before the roster lock held through spawn.
type MemberActor func(context.Context, string, string, MemberIdentity, string) ([]byte, error)

func (r *Runtime) BindMemberActor(commit MemberActor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.memberActor = commit
}

// OpenTerminal consumes one sealed admission at the installed SessionRPC door.
// Account provisioning, current membership, token identity and connection fences
// all precede spawn. There is no host PTY or msb exec -t fallback here.
func (c *MemberCredentials) OpenTerminal(ctx context.Context, id, session, digest string, command workspaceapi.Command) (terminal workspaceapi.Terminal, err error) {
	if len(command.Args) == 0 {
		command.Args = []string{"/bin/sh"}
	}
	var admitted *machined.Sessions
	err = c.withAdmission(ctx, id, session, digest, command, "terminal", func(admissionCtx context.Context, sessions *machined.Sessions, user machined.SessionUser) error {
		admitted = sessions
		var e error
		terminal, e = sessions.OpenTerminal(admissionCtx, user, command.Args, &machined.SessionSize{Cols: 80, Rows: 24})
		return e
	})
	if err != nil && terminal != nil {
		err = errors.Join(err, c.cleanupFailedAdmission(admitted))
		_ = terminal.Close()
		terminal = nil
	}
	return
}

// OpenSession uses the same sealed member admission for SSH exec, SFTP and
// loopback relay processes. No session user comes from a channel payload.
func (c *MemberCredentials) OpenSession(ctx context.Context, id, session, digest string, command workspaceapi.Command, kind machined.SessionKind, size *machined.SessionSize) (client *machined.Sessions, sid uint32, err error) {
	err = c.withAdmission(ctx, id, session, digest, command, "ssh", func(admissionCtx context.Context, sessions *machined.Sessions, user machined.SessionUser) error {
		var e error
		sid, e = sessions.WithPresenceVia("ssh").OpenSession(admissionCtx, user, kind, command.Args, size)
		if e == nil {
			client = sessions
		}
		return e
	})
	if err != nil && client != nil {
		err = errors.Join(err, c.cleanupFailedAdmission(client))
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		_ = client.CloseSession(cleanup, sid)
		stop()
		client = nil
		sid = 0
	}
	return
}

func (c *MemberCredentials) cleanupFailedAdmission(client *machined.Sessions) error {
	cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	_, err := client.KillUser(cleanup, machined.SessionUser{Login: c.member.Login, UID: uint32(c.member.UID)})
	if err != nil {
		_ = client.CloseConnection()
		return fmt.Errorf("%w: %v", workspaceapi.ErrCommandTerminationUnconfirmed, err)
	}
	return nil
}

func (c *MemberCredentials) withAdmission(ctx context.Context, id, session, digest string, command workspaceapi.Command, via string, open func(context.Context, *machined.Sessions, machined.SessionUser) error) error {
	if err := workspaceapi.ValidateSessionCredential(session, nil); err != nil {
		return err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(digest, false); err != nil {
		return err
	}
	r := c.runtime
	if !r.SecretEnvironmentAvailable() {
		return ErrUnavailable
	}
	r.mu.Lock()
	roster, commitActor := r.memberRoster, r.memberActor
	r.mu.Unlock()
	if roster == nil || commitActor == nil {
		return ErrUnavailable
	}
	ws, err := r.runningWorkspace(id)
	if err != nil {
		return err
	}
	if _, err = r.EnsureMember(ctx, id, c.member); err != nil {
		return err
	}
	if err = r.EnsureMachined(ctx, id); err != nil {
		return err
	}
	ws.sessionMu.Lock()
	defer ws.sessionMu.Unlock()
	if r.config.Bundle == nil || r.cli == nil {
		return ErrUnavailable
	}
	actor, err := commitActor(ctx, id, ws.Machine, c.member, via)
	if err != nil {
		return err
	}
	err = roster(ctx, id, func(admissionCtx context.Context, members []MemberIdentity) error {
		if err := r.provisionMembers(admissionCtx, ws.Machine, members, &c.member); err != nil {
			return err
		}
		return c.admit(admissionCtx, ws, session, digest, command, actor, open)
	})
	return err
}

// Keep the authoritative membership read lock through the broker's reply so
// removal cannot commit between authorization and process creation.
func (c *MemberCredentials) admit(ctx context.Context, ws *workspace, session, digest string, command workspaceapi.Command, actor []byte, open func(context.Context, *machined.Sessions, machined.SessionUser) error) error {
	r, id := c.runtime, ws.ID
	link, err := r.machined.Current(id)
	if err != nil {
		return err
	}
	if err = link.RequireReady(id); err != nil {
		return err
	}
	sessions := machined.NewSessions(link.Connection, id, r.machined.Sessions(id)).WithActor(actor, "").WithPresenceVia("terminal")
	if command.Directory != "" && command.Directory != guestRoot {
		return fmt.Errorf("terminal directory must be workspace root")
	}
	if len(command.Args) == 0 {
		command.Args = []string{"/bin/sh"}
	}
	environment := make(map[string]string, len(command.Environment)+3)
	for k, v := range command.Environment {
		environment[k] = v
	}
	environment["TERM"] = "xterm-256color"
	if environment["SMITHERS_TOKEN_FILE"] != fmt.Sprintf("/run/smithers/%d/token/sessions/%s/token", c.member.UID, session) || environment["SMITHERS_URL"] == "" {
		return fmt.Errorf("terminal credential environment is missing")
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
		return err
	}
	if len(body) > 256*1024 {
		return fmt.Errorf("session admission exceeds limit")
	}
	if _, err = r.guest(ctx, ws.Machine, body, "put-session-binding", c.member.Login, strconv.Itoa(c.member.UID)); err != nil {
		return err
	}
	err = open(ctx, sessions, machined.SessionUser{Login: c.member.Login, UID: uint32(c.member.UID)})
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = r.guest(cleanup, ws.Machine, nil, "delete-session-binding", c.member.Login, strconv.Itoa(c.member.UID))
	}
	return err
}

var _ workspaceapi.SessionCredentialWriter = (*MemberCredentials)(nil)
