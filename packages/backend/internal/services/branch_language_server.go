package services

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// ErrBranchAsleep refuses code intelligence on a sleeping branch: reading
// never wakes it (spec §8.4.4), so no language server starts.
var ErrBranchAsleep = pkgerrors.Conflict("The branch is asleep.")

// memberExecOpener is the installed member runtime's exec door.
type memberExecOpener interface {
	OpenExec(context.Context, string, string, string, workspaceapi.Command) (*machined.Exec, error)
}

type memberLanguageRuntime interface {
	SessionCredentialsForMember(context.Context, string, microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error)
}

// LanguageServerProcess is one File-card language server: a daemon exec
// session owned by the member who asked (spec §9.1.2).
type LanguageServerProcess struct {
	*machined.Exec
	once    sync.Once
	release func()
}

// Ready retires the launch credential once the launch script printed its
// ready line: the session launcher has consumed it, and the server keeps none.
func (p *LanguageServerProcess) Ready() { p.once.Do(p.release) }

// Kill empties the session's cgroup and retires the launch credential.
func (p *LanguageServerProcess) Kill(ctx context.Context) error {
	defer p.Ready()
	return p.Exec.Kill(ctx)
}

// LanguageServerAvailable reports whether the installed member runtime can
// start language servers; without it the door refuses and starts nothing.
func (s *WorkspaceService) LanguageServerAvailable(registry *machined.Registry) bool {
	if !s.OwnerTerminalAvailable(registry) {
		return false
	}
	_, ok := s.runtime.(memberLanguageRuntime)
	return ok
}

// RequireAwakeBranch answers ErrBranchAsleep unless the branch machine runs
// with an admitted daemon link. It reads memory and the row only; it never
// queues a wake.
func (s *WorkspaceService) RequireAwakeBranch(ctx context.Context, registry *machined.Registry, branch string) error {
	row, err := s.q.GetWorkspace(ctx, branch)
	if err != nil {
		return err
	}
	if row.Status != "running" || registry == nil {
		return ErrBranchAsleep
	}
	link, err := registry.Current(row.ID)
	if err != nil || link.RequireReady(row.ID) != nil {
		return ErrBranchAsleep
	}
	return nil
}

// OpenOwnerLanguageServer starts language on the awake branch as the member.
// It authorizes branch.join, refuses a sleeping branch before any write,
// takes no machine admission (so the server never holds the machine awake)
// and writes no workspace_sessions row. The session launcher requires a
// bound session token; this one lives only until the ready line.
func (s *WorkspaceService) OpenOwnerLanguageServer(ctx context.Context, registry *machined.Registry, branch string, repo, member int64, language string) (*LanguageServerProcess, error) {
	spec, ok := LanguageServerFor(language)
	if !ok {
		return nil, pkgerrors.BadRequest("language must be one of: " + strings.Join(LSPLanguages(), ", "))
	}
	if !s.LanguageServerAvailable(registry) {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Code intelligence is unavailable")
	}
	runtime := s.runtime.(memberLanguageRuntime)
	row, err := s.AuthorizeTerminalBranch(ctx, branch, repo, member)
	if err != nil {
		return nil, err
	}
	if err = s.RequireAwakeBranch(ctx, registry, row.ID); err != nil {
		return nil, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// Serialize membership allocation with removal until the session is bound.
	if err = s.branchMachineProviders.Membership(ctx, tx, repo, member); err != nil {
		return nil, err
	}
	var user machined.SessionUser
	if err = tx.QueryRow(ctx, `SELECT unix_login,unix_uid FROM collaborators WHERE repository_id=$1 AND user_id=$2 AND suspended_at IS NULL AND permission IN ('write','admin')`, repo, member).Scan(&user.Login, &user.UID); err != nil {
		return nil, err
	}
	writer, err := runtime.SessionCredentialsForMember(ctx, row.ID, microsandbox.MemberIdentity{Login: user.Login, UID: int(user.UID), Active: true})
	if err != nil {
		return nil, err
	}
	opener, ok := writer.(memberExecOpener)
	if !ok {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Code intelligence is unavailable")
	}
	session := uuid.NewString()
	minted, err := s.credentialIssuer.mintForSubject(ctx, member, "language-server-"+session,
		middleware.Delegation{Via: "web", Branch: row.ID, Session: session, Profile: middleware.TerminalProfileS1},
		[]string{string(middleware.ScopeReadRepository), string(middleware.ScopeReadUser), middleware.RepositoryRestrictionScope(repo)})
	if err != nil {
		return nil, err
	}
	path, err := writer.PutSessionToken(ctx, row.ID, session, []byte(minted.Token), "")
	if err != nil {
		revokeTemporaryRepoCloneToken(context.WithoutCancel(ctx), s.q, member, minted.ID)
		return nil, err
	}
	identity := workspaceapi.SessionCredentialIdentity([]byte(minted.Token))
	release := func() {
		cleanup, cancel := context.WithTimeout(context.Background(), temporaryRepoTokenRevokeTimeout)
		defer cancel()
		revokeTemporaryRepoCloneToken(cleanup, s.q, member, minted.ID)
		_ = writer.DeleteSessionToken(cleanup, row.ID, session, identity)
	}
	environment := map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": strings.TrimRight(s.gitBaseURL, "/")}
	process, err := opener.OpenExec(ctx, row.ID, session, identity, workspaceapi.Command{Args: spec.LaunchArgv(defaultWorkspaceClonePath), Environment: environment})
	if err != nil {
		release()
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		kill, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		release()
		return nil, errors.Join(err, process.Kill(kill))
	}
	return &LanguageServerProcess{Exec: process, release: release}, nil
}
