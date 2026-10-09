package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// PrepareMainMachine uses the install's shared microVM admission and source
// primitives. It never clones a branch disk or resumes a person's working copy.
func (s *WorkspaceService) PrepareMainMachine(ctx context.Context, id string, repository, user int64, revision string) (retErr error) {
	if s.runtime == nil || s.runtime.Isolation() != workspaceapi.IsolationSandboxed || !flowCommitPattern.MatchString(revision) {
		return fmt.Errorf("manual main machine unavailable")
	}
	q, ok := s.q.(*db.Queries)
	if !ok {
		return fmt.Errorf("manual main store unavailable")
	}
	queue, ok := s.runtime.(interface {
		FreeDisk(context.Context) (int64, error)
		CancelFailedAdmission(string, string)
		WaitAdmission(context.Context, microsandbox.AdmissionProviders, string, string, string, string) (context.Context, error)
	})
	if !ok {
		return fmt.Errorf("background admission unavailable")
	}
	ctx, err := queue.WaitAdmission(ctx, microsandbox.AdmissionProviders{FreeDisk: queue.FreeDisk, Ready: func(ctx context.Context, request microsandbox.AdmissionRequest) error {
		if request.Holder != "workspace:"+id || request.Actor != id || request.Class != "background" {
			return microsandbox.ErrAdmissionNotReady
		}
		credential := middleware.CredentialOf(middleware.AuthInfoFromContext(ctx))
		info, err := middleware.ReloadCredential(ctx, q, credential, time.Now())
		if err != nil {
			return err
		}
		if info.User.ID != user || info.IsTokenAuth || info.CredentialKind() != middleware.CredentialPerson {
			return middleware.ErrCredentialGone
		}
		role, err := InstallRoleOf(ctx, q, user)
		if err != nil {
			return err
		}
		if role != InstallOwner && role != InstallMaintainer {
			return fmt.Errorf("manual main role revoked")
		}
		return nil
	}}, "background", "workspace:"+id, id, "manual-main")
	if err != nil {
		return err
	}
	defer func() {
		if retErr != nil {
			if _, err := s.runtime.InspectWorkspace(context.WithoutCancel(ctx), id); errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
				queue.CancelFailedAdmission("workspace:"+id, id)
			}
		}
	}()
	current, err := s.runtime.InspectWorkspace(ctx, id)
	if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		current, err = s.runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	}
	if err != nil {
		return err
	}
	if current.State != workspaceapi.WorkspaceRunning {
		if _, err = s.runtime.StartWorkspace(ctx, id); err != nil {
			return err
		}
	}
	machines, ok := s.runtime.(interface {
		WorkspaceMachineIdentity(context.Context, string) (string, error)
	})
	if !ok {
		return fmt.Errorf("manual main machine identity unavailable")
	}
	machine, err := machines.WorkspaceMachineIdentity(ctx, id)
	if err != nil {
		return err
	}
	if machine == "" {
		return fmt.Errorf("manual main machine identity unavailable")
	}
	if _, err := s.q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{ID: id, VmID: machine, Status: "starting"}); err != nil {
		return err
	}
	identity, ok := s.runtime.(GuestIdentityRuntime)
	if !ok {
		return fmt.Errorf("manual main guest identity unavailable")
	}
	login, uid := identity.GuestIdentity()
	if login != "agent" || uid != 19999 {
		return fmt.Errorf("manual main guest identity unavailable")
	}
	protected, ok := s.runtime.(interface {
		ProtectedManagedHostReady(context.Context, string) error
	})
	if !ok {
		return fmt.Errorf("manual main guest bootstrap unavailable")
	}
	if err := protected.ProtectedManagedHostReady(ctx, id); err != nil {
		return err
	}
	resolver, ok := s.runtime.(workspaceapi.WorkspaceSourceRevisionResolver)
	if !ok {
		return fmt.Errorf("manual main revision resolver unavailable")
	}
	// This is the machine's whole setup, so both exits end with the receipt a
	// Flow host start waits for, as branch setup's does.
	unavailable := fmt.Errorf("manual main source unavailable")
	actual, err := resolver.ResolveWorkspaceSourceRevision(ctx, id)
	if err == nil && actual == revision {
		return writeSetupReceipt(ctx, s.runtime, id, repository, revision, unavailable)
	}
	// All commands execute through the runtime's non-root guest boundary.
	slug, err := q.GetRepoOwnerSlugAndNameByID(ctx, repository)
	if err != nil {
		return err
	}
	clone, err := buildRepoCloneURL(s.gitBaseURL, slug.OwnerSlug, slug.RepoName)
	if err != nil {
		return err
	}
	token, err := issueTemporaryBoundRepoCloneToken(ctx, s.q, user, repository, "manual-main-source")
	if err != nil {
		return err
	}
	defer revokeTemporaryRepoCloneToken(ctx, s.q, user, token.ID)
	auth := map[string]string{"GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraHeader", "GIT_CONFIG_VALUE_0": "Authorization: Bearer " + token.Plaintext}
	for _, args := range [][]string{{"git", "init", "--quiet"}, {"git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", clone.String(), "+refs/heads/main:refs/smithers/manual/main"}, {"git", "checkout", "--quiet", "--detach", revision}, {"jj", "git", "init", "--colocate"}, {"jj", "edit", revision}} {
		env := map[string]string(nil)
		if len(args) > 1 && args[1] == "fetch" {
			env = auth
		}
		if err = machineCommand(ctx, s.runtime, id, env, unavailable, args...); err != nil {
			return err
		}
	}
	actual, err = resolver.ResolveWorkspaceSourceRevision(ctx, id)
	if err != nil {
		return err
	}
	if strings.TrimSpace(actual) != revision {
		return fmt.Errorf("manual main source revision differs")
	}
	return writeSetupReceipt(ctx, s.runtime, id, repository, revision, unavailable)
}

func (s *WorkspaceService) RetireMainMachine(ctx context.Context, id string) error {
	if s.runtime == nil {
		return fmt.Errorf("manual main machine unavailable")
	}
	if err := s.runtime.DeleteWorkspace(ctx, id); err != nil && !errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return err
	}
	_, err := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: id, Status: "stopped"})
	return err
}
