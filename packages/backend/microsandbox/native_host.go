package microsandbox

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// The installed coding host is an agent-UID broker session. Its executable and
// environment are consumed only after the permanent identity drop. It shares
// the ordinary managed-service observation and stop lifecycle.
func (r *Runtime) startNativeHost(ctx context.Context, ws *workspace, binding string, spec workspaceapi.ServiceSpec) (workspaceapi.Service, error) {
	if err := workspaceapi.ValidateSessionCredential(binding, nil); err != nil {
		return workspaceapi.Service{}, err
	}
	request, err := r.request(spec.Command)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	token := []byte(request.Env["SMITHERS_API_KEY"])
	if err = workspaceapi.ValidateSessionCredential(binding, token); err != nil {
		return workspaceapi.Service{}, err
	}
	r.mu.Lock()
	admit, commitActor := r.machinedAgentAdmission, r.machinedAgentActor
	r.mu.Unlock()
	if admit == nil || commitActor == nil {
		return workspaceapi.Service{}, ErrUnavailable
	}
	ws.sessionMu.Lock()
	defer ws.sessionMu.Unlock()
	r.mu.Lock()
	existing := ws.services[spec.Name]
	r.mu.Unlock()
	if existing != nil && !existing.command.finished() {
		if existing.fingerprint != serviceFingerprint(spec) {
			return workspaceapi.Service{}, workspaceapi.ErrManagedHostIdentityConflict
		}
		if err = r.waitForService(ctx, ws, spec, existing.command); err != nil {
			return workspaceapi.Service{}, err
		}
		return workspaceapi.Service{Name: spec.Name, Address: spec.ReadyAddress}, nil
	}
	if existing != nil && existing.command.finished() && errors.Is(existing.command.waitErr, workspaceapi.ErrCommandTerminationUnconfirmed) {
		// An ended output pump does not establish an empty run. Repair its
		// cleanup receipt before replacing the host or planting new credentials.
		if err = existing.command.cancel(); err != nil {
			return workspaceapi.Service{}, err
		}
	}
	link, err := r.machined.Current(ws.ID)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	if err = link.RequireReady(ws.ID); err != nil {
		return workspaceapi.Service{}, err
	}
	actor, err := commitActor(ctx, ws.ID, ws.Machine, binding)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	digest := workspaceapi.SessionCredentialIdentity(token)
	path, err := r.PutSessionToken(ctx, ws.ID, binding, token, "")
	if err != nil {
		path, err = r.PutSessionToken(ctx, ws.ID, binding, token, digest)
	}
	if err != nil {
		return workspaceapi.Service{}, err
	}
	cleanupToken := func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = r.DeleteSessionToken(cleanup, ws.ID, binding, digest)
	}
	request.Env["SMITHERS_TOKEN_FILE"] = path
	if request.Env["SMITHERS_URL"] == "" {
		request.Env["SMITHERS_URL"] = request.Env["SMITHERS_API_BASE_URL"]
	}
	if request.Env["SMITHERS_URL"] == "" {
		cleanupToken()
		return workspaceapi.Service{}, fmt.Errorf("coding host API origin is missing")
	}
	body, err := json.Marshal(struct {
		Login       string            `json:"login"`
		UID         int               `json:"uid"`
		Session     string            `json:"session"`
		Digest      string            `json:"token_sha256"`
		Environment map[string]string `json:"environment"`
	}{"agent", 19999, binding, digest, request.Env})
	if err != nil || len(body) > 256*1024 {
		cleanupToken()
		return workspaceapi.Service{}, fmt.Errorf("coding host admission exceeds limit")
	}
	if _, err = r.guest(ctx, ws.Machine, body, "put-session-binding", "agent", "19999"); err != nil {
		cleanupToken()
		return workspaceapi.Service{}, err
	}
	sessions := machined.NewSessions(link.Connection, ws.ID, r.machined.Sessions(ws.ID)).WithActor(actor, binding).WithPresenceVia("agent:" + binding)
	var id uint32
	closeSession := func() {
		if id == 0 {
			return
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = sessions.CloseSession(cleanup, id)
	}
	registered := false
	err = admit(ctx, ws.ID, binding, func(spawnCtx context.Context) error {
		var err error
		id, err = sessions.OpenSession(spawnCtx, machined.SessionUser{Login: "agent", UID: 19999}, machined.SessionExec, request.Argv, nil)
		if err != nil {
			return err
		}
		err = sessions.RegisterRun(spawnCtx, binding, id)
		registered = err == nil
		return err
	})
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if id != 0 {
			// Registration is idempotent. Repair an unknown acknowledgment before
			// selecting the narrow run revocation; otherwise fence the agent identity.
			if !registered {
				registered = sessions.RegisterRun(cleanup, binding, id) == nil
			}
			var killed error
			if registered {
				_, killed = sessions.KillRun(cleanup, binding)
			} else {
				_, killed = sessions.KillUser(cleanup, machined.SessionUser{Login: "agent", UID: 19999})
			}
			closeSession()
			cleanupToken()
			if killed != nil {
				_ = sessions.CloseConnection()
				return workspaceapi.Service{}, fmt.Errorf("%w: %v", workspaceapi.ErrCommandTerminationUnconfirmed, killed)
			}
		} else {
			_, _ = r.guest(cleanup, ws.Machine, nil, "delete-session-binding", "agent", "19999")
			cleanupToken()
		}
		return workspaceapi.Service{}, err
	}
	stream, err := sessions.Stream(ctx, id)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, killed := sessions.KillRun(cleanup, binding)
		closeSession()
		cleanupToken()
		if killed != nil {
			_ = sessions.CloseConnection()
			return workspaceapi.Service{}, fmt.Errorf("%w: %v", workspaceapi.ErrCommandTerminationUnconfirmed, killed)
		}
		return workspaceapi.Service{}, err
	}
	pumpCtx, stop := context.WithCancel(context.Background())
	command := &guestCommand{runtime: r, machine: ws.Machine, id: binding, done: make(chan struct{}), stdout: &limitedBuffer{limit: r.config.OutputLimit}, stderr: &limitedBuffer{limit: r.config.OutputLimit}}
	command.cancelNative = func() error {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		// A failed attempt fenced its transport. Retry against the current
		// authenticated connection for this same machine, never the old socket.
		err := r.machined.KillRunOnMachine(cleanup, ws.ID, ws.Machine, binding)
		stop()
		closeSession()
		cleanupToken()
		<-command.done
		if err != nil {
			_ = sessions.CloseConnection()
			return fmt.Errorf("%w: %v", workspaceapi.ErrCommandTerminationUnconfirmed, err)
		}
		return nil
	}
	go func() {
		defer close(command.done)
		defer stop()
		defer cleanupToken()
		command.waitErr = superviseNativeHost(pumpCtx, stream, command.stdout, command.stderr, func(ctx context.Context) error {
			return r.machined.KillRunOnMachine(ctx, ws.ID, ws.Machine, binding)
		})
		closeSession()
	}()
	r.mu.Lock()
	ws.services[spec.Name] = &managedService{spec: spec, command: command, fingerprint: serviceFingerprint(spec)}
	r.mu.Unlock()
	if err = r.waitForService(ctx, ws, spec, command); err != nil {
		return workspaceapi.Service{}, errors.Join(err, command.cancel())
	}
	return workspaceapi.Service{Name: spec.Name, Address: spec.ReadyAddress}, nil
}

type nativeHostStream interface {
	Receive(context.Context) ([]byte, error)
	Send(context.Context, []byte) error
	Reattach(context.Context) (uint64, error)
}

// A session exit only reaps its first process. Keep the managed host running
// until the broker confirms that every descendant in its registered run is gone.
// This also fences descendants after a transport failure, without depending on
// an explicit StopService call or the request context that launched the host.
func superviseNativeHost(ctx context.Context, stream nativeHostStream, stdout, stderr *limitedBuffer, kill func(context.Context) error) error {
	pumpErr := pumpNativeHost(ctx, stream, stdout, stderr)
	cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := kill(cleanup); err != nil {
		return errors.Join(pumpErr, fmt.Errorf("%w: %v", workspaceapi.ErrCommandTerminationUnconfirmed, err))
	}
	return pumpErr
}

func pumpNativeHost(ctx context.Context, stream nativeHostStream, stdout, stderr *limitedBuffer) error {
	stderr.nativeOutput()
	for {
		frame, err := stream.Receive(ctx)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return err
			}
			if err = reconnectNativeHost(ctx, stream); err != nil {
				return err
			}
			continue
		}
		if len(frame) == 0 {
			return fmt.Errorf("empty coding host frame")
		}
		switch frame[0] {
		case 1:
			if len(frame) < 2 || (frame[1] != 1 && frame[1] != 2) {
				return fmt.Errorf("invalid coding host output")
			}
			output := stdout
			if frame[1] == 2 {
				output = stderr
			}
			_, _ = output.Write(frame[2:])
			if err = stream.Send(ctx, nativeOutputCredit(len(frame)-2)); err != nil {
				if err = reconnectNativeHost(ctx, stream); err != nil {
					return err
				}
			}
		case 5:
			if len(frame) < 2 || (frame[1] == 0 && len(frame) != 6) || (frame[1] == 1 && (len(frame) != 4 || frame[2] < 1 || frame[2] > 7 || frame[3] > 1)) || frame[1] > 1 {
				return fmt.Errorf("invalid coding host exit")
			}
			var code int32
			if frame[1] == 0 {
				code = int32(binary.BigEndian.Uint32(frame[2:]))
				if code < 0 || code > 255 {
					return fmt.Errorf("invalid coding host exit code")
				}
			} else {
				// The daemon uses the protocol signal enum, not Linux signal numbers.
				code = int32((&machined.ExitError{Signal: frame[2]}).ExitStatus())
			}
			stderr.nativeExit(int(code))
			return nil
		case 7:
			return fmt.Errorf("coding host session closed without exit receipt")
		case 255:
			return fmt.Errorf("coding host session refused")
		}
	}
}

func nativeOutputCredit(n int) []byte {
	p := make([]byte, 5)
	p[0] = 6
	binary.BigEndian.PutUint32(p[1:], uint32(n))
	return p
}

// Admission is available only through the composed install's authenticated
// native broker. An unbundled process fixture cannot enable shared host access.
func (r *Runtime) ProtectedManagedHostReady(ctx context.Context, id string) error {
	r.mu.Lock()
	providers := r.machinedAgentAdmission != nil && r.machinedAgentActor != nil
	r.mu.Unlock()
	if !providers {
		return ErrUnavailable
	}
	if r.config.Bundle == nil || !r.SecretEnvironmentAvailable() {
		return ErrUnavailable
	}
	if err := r.EnsureMachined(ctx, id); err != nil {
		return err
	}
	link, err := r.machined.Current(id)
	if err != nil {
		return err
	}
	return link.RequireReady(id)
}

func reconnectNativeHost(ctx context.Context, stream nativeHostStream) error {
	retry, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := retry.Err(); err != nil {
			return err
		}
		if _, err := stream.Reattach(retry); err == nil {
			return nil
		}
		select {
		case <-retry.Done():
			return retry.Err()
		case <-ticker.C:
		}
	}
}
