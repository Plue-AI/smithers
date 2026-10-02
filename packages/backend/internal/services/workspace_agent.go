package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// RFD-004: an agent run executes in a workspace of kind "agent" that is
// listed under its branch beside the human workspaces, counted against the
// same quota, provisioned as a fork of the user's running workspace on that
// bookmark (else the primary, else fresh from the golden snapshot), and kept
// after the run.

// CreateAgentWorkspaceInput describes the computer an agent run needs.
type CreateAgentWorkspaceInput struct {
	RepositoryID   int64
	UserID         int64
	SessionID      string
	Title          string
	RepoOwner      string
	RepoName       string
	SourceBookmark string
	// EgressSecrets are the run's proxy bindings (platform model seats, the
	// per-run cache token). They are merged over the
	// repository's own bound secrets; the run's bindings win on a name clash.
	EgressSecrets []sandbox.EgressProxySecret
	// Members are cross-repository changeset members to clone beside the
	// primary checkout (authenticated clone URLs, pinned revisions).
	Members []sandbox.GitRepositorySpec
}

// AgentWorkspaceResult is what dispatch needs back.
type AgentWorkspaceResult struct {
	WorkspaceID       string
	VMID              string
	Forked            bool
	SourceWorkspaceID string
}

// agentWorkspaceStore is the optional querier surface for agent workspaces.
type agentWorkspaceStore interface {
	ListRunningWorkspacesForUserRepoBookmark(ctx context.Context, arg db.ListRunningWorkspacesForUserRepoBookmarkParams) ([]db.Workspace, error)
	SetAgentSessionWorkspace(ctx context.Context, arg db.SetAgentSessionWorkspaceParams) error
}

func pgUUIDFromString(value string) pgtype.UUID {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return pgtype.UUID{}
	}
	return pgtype.UUID{Bytes: parsed, Valid: true}
}

func agentWorkspaceName(sessionID, title string) string {
	short := strings.ReplaceAll(strings.TrimSpace(sessionID), "-", "")
	if len(short) > 8 {
		short = short[:8]
	}
	name := "agent-" + short
	if title = strings.TrimSpace(title); title != "" {
		if len(title) > 48 {
			title = title[:48]
		}
		name += " " + title
	}
	return name
}

// mergeEgressSecrets overlays run bindings on the repository's bindings.
func mergeEgressSecrets(base, run []sandbox.EgressProxySecret) []sandbox.EgressProxySecret {
	merged := make([]sandbox.EgressProxySecret, 0, len(base)+len(run))
	seen := make(map[string]struct{}, len(run))
	for _, secret := range run {
		seen[secret.Name] = struct{}{}
		merged = append(merged, secret)
	}
	for _, secret := range base {
		if _, dup := seen[secret.Name]; dup {
			continue
		}
		merged = append(merged, secret)
	}
	return merged
}

// CheckAgentWorkspaceQuota uses the same quota authority as workspace creation,
// before durable message dispatch creates any execution infrastructure.
func (s *WorkspaceService) CheckAgentWorkspaceQuota(ctx context.Context, userID int64) error {
	if s.q == nil || (s.runtime == nil && s.sandbox == nil) {
		return pkgerrors.Internal("workspace service unavailable")
	}
	return s.enforceWorkspaceQuota(ctx, userID)
}

// CreateAgentWorkspace creates the row and provisions its VM synchronously.
// On any provisioning failure the row is marked failed (quota released) and
// the error is returned; the caller marks the run infrastructure-failed.
func (s *WorkspaceService) CreateAgentWorkspace(ctx context.Context, input CreateAgentWorkspaceInput) (out AgentWorkspaceResult, retErr error) {
	defer func() { s.observeWorkspaceLifecycle("create", retErr) }()
	if s.q == nil || (s.runtime == nil && s.sandbox == nil) {
		return AgentWorkspaceResult{}, pkgerrors.Internal("workspace service unavailable")
	}
	if input.RepositoryID <= 0 || input.UserID <= 0 || strings.TrimSpace(input.SessionID) == "" {
		return AgentWorkspaceResult{}, pkgerrors.BadRequest("repository, user, and session are required")
	}
	if strings.TrimSpace(input.RepoOwner) == "" || strings.TrimSpace(input.RepoName) == "" {
		return AgentWorkspaceResult{}, pkgerrors.BadRequest("repository owner and name are required")
	}
	bookmark := targetWorkspaceBookmark(input.SourceBookmark)
	if strings.TrimSpace(input.SourceBookmark) == "" {
		bookmark = s.repositoryDefaultBookmark(ctx, input.RepositoryID)
	}
	if err := s.enforceWorkspaceQuota(ctx, input.UserID); err != nil {
		return AgentWorkspaceResult{}, err
	}
	workspace, err := s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		RepositoryID:      input.RepositoryID,
		UserID:            input.UserID,
		Name:              agentWorkspaceName(input.SessionID, input.Title),
		IsFork:            true,
		ParentWorkspaceID: pgtype.UUID{},
		SourceSnapshotID:  pgtype.UUID{},
		TargetBookmark:    bookmark,
		Kind:              "agent",
		EnvironmentSource: defaultWorkspaceEnvironmentSource,
		Status:            "starting",
		AgentSessionID:    pgUUIDFromString(input.SessionID),
	})
	if err != nil {
		return AgentWorkspaceResult{}, mapWorkspaceCreateError(err, "create agent workspace")
	}
	linkSession := func() error {
		if store, ok := s.q.(agentWorkspaceStore); ok {
			if err := store.SetAgentSessionWorkspace(ctx, db.SetAgentSessionWorkspaceParams{
				WorkspaceID: pgUUIDFromString(workspace.ID),
				ID:          input.SessionID,
			}); err != nil {
				s.markWorkspaceProvisionFailed(ctx, workspace, err)
				return pkgerrors.Internal("link agent session to workspace: " + err.Error())
			}
		}
		return nil
	}
	if s.runtime != nil {
		workspace, err = s.ensureWorkspaceRunning(ctx, workspace, CreateWorkspaceSessionInput{
			RepositoryID: input.RepositoryID, UserID: input.UserID, RepoOwner: input.RepoOwner,
			RepoName: input.RepoName, SourceBookmark: bookmark,
		})
		if err != nil {
			if !errors.Is(err, errWorkspaceProvisionInProgress) {
				s.markWorkspaceProvisionFailed(ctx, workspace, err)
			}
			return AgentWorkspaceResult{}, err
		}
		if err := linkSession(); err != nil {
			return AgentWorkspaceResult{}, err
		}
		return AgentWorkspaceResult{WorkspaceID: workspace.ID}, nil
	}
	result, err := s.provisionAgentWorkspace(ctx, workspace, input, bookmark)
	if err != nil {
		return AgentWorkspaceResult{}, err
	}
	if err := linkSession(); err != nil {
		return AgentWorkspaceResult{}, err
	}
	return result, nil
}

func (s *WorkspaceService) provisionAgentWorkspace(ctx context.Context, workspace db.Workspace, input CreateAgentWorkspaceInput, bookmark string) (AgentWorkspaceResult, error) {
	s = s.withWorkspaceIdleTimeout(workspace)
	egress, err := s.workspaceEgressProxy(ctx, workspace.RepositoryID, workspace.ID)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return AgentWorkspaceResult{}, err
	}
	egress.Secrets = mergeEgressSecrets(egress.Secrets, input.EgressSecrets)
	if err := egress.Validate(); err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return AgentWorkspaceResult{}, pkgerrors.Internal("agent workspace egress bindings: " + err.Error())
	}
	startedAt := time.Now()
	if source, sameBookmark, ok := s.agentForkSource(ctx, workspace, bookmark); ok {
		result, forkErr := s.forkAgentWorkspace(ctx, workspace, input, egress, source, sameBookmark)
		if forkErr == nil {
			s.observeAgentWorkspaceCreate("success", startedAt)
			return result, nil
		}
		slog.Warn("agent workspace fork failed; falling back to fresh provision",
			"workspace_id", workspace.ID, "source_workspace_id", source.ID, "error", forkErr)
	}
	result, err := s.provisionFreshAgentWorkspace(ctx, workspace, input, egress, bookmark)
	if err != nil {
		s.observeAgentWorkspaceCreate("error", startedAt)
		return AgentWorkspaceResult{}, err
	}
	s.observeAgentWorkspaceCreate("success", startedAt)
	return result, nil
}

func (s *WorkspaceService) observeAgentWorkspaceCreate(status string, startedAt time.Time) {
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.ObserveSandboxVMCreate("agent", status, time.Since(startedAt).Seconds())
	}
}

// agentForkSource picks the computer to fork: the user's running non-agent
// workspace on the same bookmark, else their primary workspace when it has a
// VM (resumed if suspended). sameBookmark reports which one it found.
func (s *WorkspaceService) agentForkSource(ctx context.Context, workspace db.Workspace, bookmark string) (db.Workspace, bool, bool) {
	if store, ok := s.q.(agentWorkspaceStore); ok {
		candidates, err := store.ListRunningWorkspacesForUserRepoBookmark(ctx, db.ListRunningWorkspacesForUserRepoBookmarkParams{
			RepositoryID:   workspace.RepositoryID,
			UserID:         workspace.UserID,
			TargetBookmark: bookmark,
		})
		if err == nil {
			for _, candidate := range candidates {
				// Only containers fork (see workspaceKindForksCleanly): a
				// vm/desktop source yields a container-booted child that no
				// agent run can use. Skip it and provision fresh instead.
				if candidate.ID != workspace.ID && strings.TrimSpace(candidate.VmID) != "" &&
					workspaceKindForksCleanly(candidate.Kind) && s.refuseRebuildRequired(candidate) == nil &&
					!s.outsiderFork(ctx, workspace, candidate) {
					return candidate, true, true
				}
			}
		}
	}
	primary, err := s.q.GetActiveWorkspaceForUserRepo(ctx, db.GetActiveWorkspaceForUserRepoParams{
		RepositoryID: workspace.RepositoryID,
		UserID:       workspace.UserID,
	})
	if err != nil || primary.ID == workspace.ID || strings.TrimSpace(primary.VmID) == "" ||
		!workspaceKindForksCleanly(primary.Kind) || s.outsiderFork(ctx, workspace, primary) {
		return db.Workspace{}, false, false
	}
	primary, err = s.ensureExistingWorkspaceRunning(ctx, primary)
	if err != nil || strings.TrimSpace(primary.VmID) == "" {
		slog.Warn("agent fork source resume failed; provisioning fresh", "source_workspace_id", primary.ID, "error", err)
		return db.Workspace{}, false, false
	}
	return primary, targetWorkspaceBookmark(primary.TargetBookmark) == bookmark, true
}

func (s *WorkspaceService) forkAgentWorkspace(ctx context.Context, workspace db.Workspace, input CreateAgentWorkspaceInput, egress *sandbox.EgressProxyPolicy, source db.Workspace, sameBookmark bool) (out AgentWorkspaceResult, retErr error) {
	defer func() { s.observeWorkspaceLifecycle("start", retErr) }()
	forkCtx := sandboxProvisionContext(ctx, "fork", "workspace", workspace.ID, workspaceProvisionAttempt(workspace.ProvisioningGeneration, "agent-"+source.ID))
	vm, err := s.forkWorkspaceSandbox(forkCtx, source.VmID, workspace, egress)
	if err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		return AgentWorkspaceResult{}, err
	}
	// Same bookmark: keep the human's in-flight working copy and start the
	// agent's own change on top of it. Primary on another bookmark: refresh
	// remote refs and start a new change on the run's bookmark.
	prepare := func(token string) string {
		return buildForkBookmarkSwitchCommand(token, targetWorkspaceBookmark(workspace.TargetBookmark))
	}
	if sameBookmark {
		prepare = buildAgentForkContinueCommand
	}
	if err := s.runForkedWorkspaceCommand(ctx, vm.ID, workspace.UserID, prepare); err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		return AgentWorkspaceResult{}, err
	}
	if err := s.cloneAgentWorkspaceMembers(ctx, vm.ID, input.Members); err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		return AgentWorkspaceResult{}, err
	}
	registered, _, err := s.registerNewWorkspaceVM(ctx, workspace, vm.ID, "running")
	if err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return AgentWorkspaceResult{}, pkgerrors.Internal("store agent workspace vm info: " + err.Error())
	}
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", 1)
	}
	registered = s.installWorkspaceHeadReporterBestEffort(ctx, registered, vm.ID)
	_ = s.q.TouchWorkspaceActivity(ctx, registered.ID)
	s.meterWorkspaceUsage(ctx, workspace, "running")
	s.notifyWorkspace(ctx, registered.ID, "running")
	slog.Info("agent workspace provisioned by fork", "workspace_id", registered.ID, "vm_id", vm.ID,
		"source_workspace_id", source.ID, "same_bookmark", sameBookmark)
	return AgentWorkspaceResult{WorkspaceID: registered.ID, VMID: vm.ID, Forked: true, SourceWorkspaceID: source.ID}, nil
}

func (s *WorkspaceService) provisionFreshAgentWorkspace(ctx context.Context, workspace db.Workspace, input CreateAgentWorkspaceInput, egress *sandbox.EgressProxyPolicy, bookmark string) (out AgentWorkspaceResult, retErr error) {
	defer func() { s.observeWorkspaceLifecycle("start", retErr) }()
	cloneToken, err := issueTemporaryRepoCloneToken(ctx, s.q, input.UserID, "sandbox-agent-workspace-clone")
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return AgentWorkspaceResult{}, pkgerrors.Internal("create repo clone token: " + err.Error())
	}
	defer revokeTemporaryRepoCloneToken(context.WithoutCancel(ctx), s.q, input.UserID, cloneToken.ID)
	parsedCloneURL, err := buildRepoCloneURL(s.gitBaseURL, input.RepoOwner, input.RepoName)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return AgentWorkspaceResult{}, pkgerrors.Internal("build repo clone url: " + err.Error())
	}
	req, err := s.freshWorkspaceVMRequest(ctx, workspace)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return AgentWorkspaceResult{}, err
	}
	req.EgressProxy = egress
	createCtx := sandboxProvisionContext(ctx, "create", "workspace", workspace.ID, workspaceProvisionAttempt(workspace.ProvisioningGeneration, "agent"))
	vm, err := s.createWorkspaceVMAttempt(createCtx, req)
	if err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return AgentWorkspaceResult{}, pkgerrors.Internal("create sandbox: " + err.Error())
	}
	registered, _, err := s.registerNewWorkspaceVM(ctx, workspace, vm.ID, "starting")
	if err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return AgentWorkspaceResult{}, pkgerrors.Internal("store sandbox info: " + err.Error())
	}
	workspace = registered
	fail := func(step string, cause error) (AgentWorkspaceResult, error) {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		s.markWorkspaceProvisionFailed(ctx, workspace, cause)
		slog.Error("agent workspace provisioning failed", "workspace_id", workspace.ID, "step", step, "error", cause)
		return AgentWorkspaceResult{}, cause
	}
	if err := s.cloneWorkspaceRepository(ctx, vm.ID, parsedCloneURL.String(), cloneToken.Plaintext, bookmark, s.workspaceCloneDepth(ctx, input.RepositoryID), workspaceCloneSource{}); err != nil {
		return fail("clone", err)
	}
	if err := s.runWorkspaceAgentEnvironmentSetup(ctx, workspace, vm.ID); err != nil {
		return fail("agent-environment", err)
	}
	if err := s.cloneAgentWorkspaceMembers(ctx, vm.ID, input.Members); err != nil {
		return fail("members", err)
	}
	workspace = s.installWorkspaceHeadReporterBestEffort(ctx, workspace, vm.ID)
	updated, err := s.q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{
		ID:     workspace.ID,
		VmID:   vm.ID,
		Status: "running",
	})
	if err != nil {
		return fail("activate", pkgerrors.Internal("store sandbox info: "+err.Error()))
	}
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", 1)
	}
	_ = s.q.TouchWorkspaceActivity(ctx, updated.ID)
	s.meterWorkspaceUsage(ctx, workspace, "running")
	s.notifyWorkspace(ctx, updated.ID, "running")
	slog.Info("agent workspace provisioned fresh", "workspace_id", updated.ID, "vm_id", vm.ID, "bookmark", bookmark)
	return AgentWorkspaceResult{WorkspaceID: updated.ID, VMID: vm.ID}, nil
}

// runForkedWorkspaceCommand mints a short-lived fetch token and runs the
// builder's command as root in the forked VM.
func (s *WorkspaceService) runForkedWorkspaceCommand(ctx context.Context, vmID string, userID int64, build func(token string) string) error {
	execClient, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return pkgerrors.Internal("sandbox exec client unavailable")
	}
	token, err := issueTemporaryRepoCloneToken(ctx, s.q, userID, "sandbox-fork-fetch")
	if err != nil {
		return pkgerrors.Internal("create fork fetch token: " + err.Error())
	}
	defer revokeTemporaryRepoCloneToken(context.WithoutCancel(ctx), s.q, userID, token.ID)
	// Two minutes: shorter than the clone budget so a stuck fork prepare
	// still leaves room for the cold-clone fallback.
	const forkPrepareTimeout = 2 * time.Minute
	timeoutMS := int64(forkPrepareTimeout / time.Millisecond)
	execCtx, cancel := context.WithTimeout(ctx, forkPrepareTimeout)
	defer cancel()
	resp, err := execClient.Execute(execCtx, vmID, sandbox.ExecRequest{
		Command:   build(token.Plaintext),
		TimeoutMS: &timeoutMS,
	})
	if err != nil {
		return pkgerrors.Internal("prepare forked workspace: " + err.Error())
	}
	if resp.StatusCode != nil && *resp.StatusCode != 0 {
		detail := strings.TrimSpace(resp.Stderr)
		if out := strings.TrimSpace(resp.Stdout); out != "" {
			if detail != "" {
				detail += "\n"
			}
			detail += out
		}
		if len(detail) > 1000 {
			detail = detail[len(detail)-1000:]
		}
		return pkgerrors.Internal(fmt.Sprintf("prepare forked workspace failed with status %d: %s", *resp.StatusCode, detail))
	}
	return nil
}

// buildAgentForkContinueCommand refreshes remote refs in a fork of a
// same-bookmark workspace and starts the agent's own change on top of the
// inherited working copy, so the human's in-flight edits are the base and
// the two computers never amend the same change.
func buildAgentForkContinueCommand(token string) string {
	path := defaultWorkspaceClonePath
	user := defaultWorkspaceUser
	asDev := "runuser -u " + shellQuote(user) + " -- env -u JJ_CONFIG HOME=" + shellQuote(defaultWorkspaceHome) + " XDG_CONFIG_HOME=" + shellQuote(defaultWorkspaceHome+"/.config") + " USER=" + shellQuote(user) + " LOGNAME=" + shellQuote(user) + " "
	lines := []string{
		"set -euo pipefail",
		"systemctl stop " + workspaceHeadReporterService + ".service >/dev/null 2>&1 || true",
		"command -v jj >/dev/null 2>&1",
	}
	lines = append(lines, gitBearerAuthEnvExports(token)...)
	lines = append(lines,
		asDev+"git -C "+shellQuote(path)+" fetch origin",
		asDev+"jj -R "+shellQuote(path)+" git import",
		asDev+"jj -R "+shellQuote(path)+" new",
	)
	return strings.Join(lines, "\n")
}

// cloneAgentWorkspaceMembers clones cross-repository changeset members
// beside the primary checkout, as the workspace user.
func (s *WorkspaceService) cloneAgentWorkspaceMembers(ctx context.Context, vmID string, members []sandbox.GitRepositorySpec) error {
	if len(members) == 0 {
		return nil
	}
	execClient, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return pkgerrors.Internal("sandbox exec client unavailable")
	}
	timeoutMS := int64(workspaceCloneTimeout / time.Millisecond)
	execCtx, cancel := context.WithTimeout(ctx, workspaceCloneTimeout)
	defer cancel()
	resp, err := execClient.Execute(execCtx, vmID, sandbox.ExecRequest{
		Command:   buildAgentMemberCloneCommand(members),
		TimeoutMS: &timeoutMS,
	})
	if err != nil {
		return pkgerrors.Internal("clone changeset members: " + err.Error())
	}
	if resp.StatusCode != nil && *resp.StatusCode != 0 {
		return pkgerrors.Internal(fmt.Sprintf("clone changeset members failed with status %d: %s", *resp.StatusCode, strings.TrimSpace(resp.Stderr)))
	}
	return nil
}

func buildAgentMemberCloneCommand(members []sandbox.GitRepositorySpec) string {
	user := defaultWorkspaceUser
	asDev := "runuser -u " + shellQuote(user) + " -- env -u JJ_CONFIG HOME=" + shellQuote(defaultWorkspaceHome) + " XDG_CONFIG_HOME=" + shellQuote(defaultWorkspaceHome+"/.config") + " USER=" + shellQuote(user) + " LOGNAME=" + shellQuote(user) + " "
	lines := []string{"set -euo pipefail"}
	for _, member := range members {
		path := strings.TrimSpace(member.Path)
		if path == "" || strings.TrimSpace(member.Repo) == "" {
			continue
		}
		clone := asDev + "git clone --quiet"
		if depth := sandbox.ResolveCloneDepth(member.Depth); depth > 0 {
			clone += " --depth " + strconv.Itoa(depth)
		}
		lines = append(lines,
			"install -d -o "+shellQuote(user)+" -g "+shellQuote(user)+" "+shellQuote(path),
			clone+" "+shellQuote(member.Repo)+" "+shellQuote(path),
		)
		if rev := strings.TrimSpace(member.Rev); rev != "" {
			// The pinned member commit is normally inside the shallow window,
			// but a changeset can pin one further back. Deepen, then unshallow,
			// before giving up — a member checkout must land on the exact
			// revision the reviewer will see.
			lines = append(lines,
				asDev+"git -C "+shellQuote(path)+" checkout --quiet --detach "+shellQuote(rev)+
					" || { "+asDev+"git -C "+shellQuote(path)+" fetch --quiet --unshallow origin || "+
					asDev+"git -C "+shellQuote(path)+" fetch --quiet origin; "+
					asDev+"git -C "+shellQuote(path)+" checkout --quiet --detach "+shellQuote(rev)+"; }")
		}
	}
	return strings.Join(lines, "\n")
}

// SuspendAgentWorkspace suspends the computer of a finished or cancelled
// run and keeps the row. Already-suspended rows are a no-op.
func (s *WorkspaceService) SuspendAgentWorkspace(ctx context.Context, workspaceID string) error {
	if s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}
	workspace, err := s.q.GetWorkspace(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return pkgerrors.Internal("load agent workspace: " + err.Error())
	}
	if workspace.Status != "running" {
		return nil
	}
	return s.suspendWorkspace(ctx, workspace)
}

// FailAgentWorkspace marks a workspace whose run never started as failed and
// deletes its VM so it does not hold quota.
func (s *WorkspaceService) FailAgentWorkspace(ctx context.Context, workspaceID string) error {
	if s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}
	workspace, err := s.q.GetWorkspace(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return pkgerrors.Internal("load agent workspace: " + err.Error())
	}
	s.revokeWorkspaceHeadToken(ctx, workspace)
	if strings.TrimSpace(workspace.VmID) != "" {
		s.deleteOrphanedWorkspaceVM(ctx, workspace.VmID)
		if workspace.Status == "running" && s.sandboxMetrics != nil {
			s.sandboxMetrics.AddSandboxActiveVMs("workspace", -1)
		}
	}
	if workspace.Status == "failed" || workspace.Status == "stopped" {
		return nil
	}
	_, err = s.failWorkspace(ctx, workspace, errors.New("agent run failed to start"))
	return err
}

// SnapshotAgentWorkspace snapshots a finished run's computer and returns the
// workspace snapshot id to stamp on the run's revisions.
func (s *WorkspaceService) SnapshotAgentWorkspace(ctx context.Context, workspaceID, name string) (string, error) {
	if s.q == nil {
		return "", pkgerrors.Internal("workspace store unavailable")
	}
	workspace, err := s.q.GetWorkspace(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		return "", pkgerrors.Internal("load agent workspace: " + err.Error())
	}
	if workspace.Status != "running" || strings.TrimSpace(workspace.VmID) == "" {
		return "", pkgerrors.Conflict("agent workspace is not running")
	}
	snapshot, err := s.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{
		RepositoryID: workspace.RepositoryID,
		UserID:       workspace.UserID,
		WorkspaceID:  workspace.ID,
		Name:         name,
	})
	if err != nil {
		return "", err
	}
	return snapshot.ID, nil
}

// TouchAgentWorkspace records run activity on the workspace so idle
// suspension does not stop a working agent.
func (s *WorkspaceService) TouchAgentWorkspace(ctx context.Context, workspaceID string) {
	if s.q == nil || strings.TrimSpace(workspaceID) == "" {
		return
	}
	_ = s.q.TouchWorkspaceActivity(ctx, workspaceID)
}

// repositoryDefaultBookmarkResolver is the optional querier surface used to
// pick a run's bookmark when the dispatch names none.
type repositoryDefaultBookmarkResolver interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
}

func (s *WorkspaceService) repositoryDefaultBookmark(ctx context.Context, repositoryID int64) string {
	if resolver, ok := s.q.(repositoryDefaultBookmarkResolver); ok {
		if repo, err := resolver.GetRepoByID(ctx, repositoryID); err == nil {
			return targetWorkspaceBookmark(repo.DefaultBookmark)
		}
	}
	return targetWorkspaceBookmark("")
}

// resolveWorkspaceBookmark returns the requested bookmark (or the repository
// default when omitted) together with the repository default. Keeping both
// lets callers distinguish the reusable primary workspace from a derived
// bookmark workspace even when the repository default is not "main".
func (s *WorkspaceService) resolveWorkspaceBookmark(ctx context.Context, repositoryID int64, requested string) (string, string, error) {
	resolver, ok := s.q.(repositoryDefaultBookmarkResolver)
	if !ok {
		return "", "", pkgerrors.Internal("repository default bookmark resolver unavailable")
	}
	repo, err := resolver.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return "", "", pkgerrors.Internal("load repository default bookmark: " + err.Error())
	}
	defaultBookmark := targetWorkspaceBookmark(repo.DefaultBookmark)
	bookmark := strings.TrimSpace(requested)
	if bookmark == "" {
		bookmark = defaultBookmark
	}
	return targetWorkspaceBookmark(bookmark), defaultBookmark, nil
}
