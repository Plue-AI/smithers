package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// RFD-004: every workspace VM runs a guest head reporter that publishes the
// working-copy commit to refs/smithers/workspaces/<id>/head on repo-host and
// reports {change_id, commit_id, ahead, behind} to the API after every jj
// snapshot. It authenticates with a workspace-bound token minted on every VM
// start and revoked on suspend, destroy, and the next start.
const (
	workspaceHeadReporterService    = "smithers-workspace-head"
	workspaceHeadReporterScriptPath = "/usr/local/bin/smithers-workspace-head"
	workspaceCodingConfigPath       = "/etc/smithers/workspace-coding.json"
	workspaceGitCredentialEnvPath   = "/etc/smithers/workspace-git.env"
	workspaceGitCredentialSocket    = defaultWorkspaceHome + "/.cache/smithers/git-credential/socket"
	workspaceHeadTokenTTL           = 7 * 24 * time.Hour
	workspaceHeadInstallTimeout     = 60 * time.Second
)

// workspaceHeadReporterScript is the guest loop. It watches the jj operation
// heads (every jj command ends in a new operation), snapshots untouched
// edits on a coarse tick, pushes the commit when it changed, and reports
// the head when anything changed. Failures retry on the next poll.
const workspaceHeadReporterScript = `#!/usr/bin/env bash
# smithers-workspace-head: publish this workspace's working-copy head to
# repo-host and the API on every jj snapshot (RFD-004). Installed by the
# control plane on every workspace start; configuration comes from the unit.
set -u
repo="${SMITHERS_WORKSPACE_PATH:-$HOME/workspace}"
ws="${SMITHERS_WORKSPACE_ID:?}"
ref="refs/smithers/workspaces/${ws}/head"
api="${SMITHERS_API_BASE_URL%/}"
slug="${SMITHERS_WORKSPACE_REPO:?}"
bookmark="${SMITHERS_WORKSPACE_BOOKMARK:-main}"
tick="${SMITHERS_WORKSPACE_HEAD_TICK_SECONDS:-30}"
poll="${SMITHERS_WORKSPACE_HEAD_POLL_SECONDS:-2}"
credential_url="${SMITHERS_WORKSPACE_GIT_URL:?}"
credential_socket="${SMITHERS_WORKSPACE_GIT_CREDENTIAL_SOCKET:?}"
credential_timeout="${SMITHERS_WORKSPACE_GIT_CREDENTIAL_TIMEOUT_SECONDS:-604800}"
credential_dir="${credential_socket%/*}"
install -d -m 700 "$credential_dir"
git credential-cache --socket "$credential_socket" exit >/dev/null 2>&1 || true
refresh_credential() {
  printf 'url=%s\nusername=smithers\npassword=%s\n\n' "$credential_url" "$SMITHERS_WORKSPACE_TOKEN" |
    git credential-cache --timeout "$credential_timeout" --socket "$credential_socket" store
}
refresh_credential
clear_credential() {
  git credential-cache --socket "$credential_socket" exit >/dev/null 2>&1 || true
}
trap clear_credential EXIT
trap 'exit 0' HUP INT TERM
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer ${SMITHERS_WORKSPACE_TOKEN:?}"
op_repo="$repo/.jj/repo"
if [ -f "$op_repo" ]; then op_repo=$(realpath "$repo/.jj/$(cat "$op_repo")"); fi
heads_dir="$op_repo/op_heads/heads"
last_heads=""; last_commit=""; last_report=""; last_tick=0; coding_cursor=""

count() {
  jj -R "$repo" --at-op=@ log --ignore-working-copy --no-graph -r "$1" -T '"x\n"' 2>/dev/null | wc -l | tr -d ' '
}
list_heads() {
  ls -1 "$heads_dir" 2>/dev/null | sort | tr '\n' ' '
}

while :; do
  # Git can evict a credential after a transient rejected request, and the
  # cache daemon can exit independently. Keep the reporter-owned credential
  # available even when the working-copy head has not changed.
  refresh_credential
  if [ ! -d "$heads_dir" ]; then sleep "$poll"; continue; fi
  # The coding facet uses the same guest lock around native CAS and mutation.
  # Release it before network I/O so publication cannot stall coding work.
  exec 9>"$op_repo/smithers-coding.lock"
  if ! flock -w 1 9; then sleep "$poll"; continue; fi
  if ! jj -R "$repo" --at-op=@ --ignore-working-copy op log -n 1 --no-graph -T '""' >/dev/null 2>&1; then
    flock -u 9; sleep "$poll"; continue
  fi
  now=$(date +%s)
  if [ $((now - last_tick)) -ge "$tick" ]; then
    # Snapshot edits nobody ran a jj command for; a no-op when nothing changed.
    jj -R "$repo" log -r @ --no-graph -T '""' >/dev/null 2>&1 || true
    last_tick=$now
  fi
  heads=$(list_heads)
  if [ "$heads" = "$last_heads" ]; then flock -u 9; sleep "$poll"; continue; fi
  head=$(jj -R "$repo" --at-op=@ log --ignore-working-copy --no-graph -r @ -T 'change_id ++ " " ++ commit_id' 2>/dev/null) || { flock -u 9; sleep "$poll"; continue; }
  change_id="${head%% *}"; commit_id="${head##* }"
  if [ -z "$change_id" ] || [ -z "$commit_id" ] || [ "$change_id" = "$commit_id" ]; then flock -u 9; sleep "$poll"; continue; fi
  ahead=$(count "(${bookmark}@origin..@) ~ empty()"); behind=$(count "@..${bookmark}@origin")
  ahead="${ahead:-0}"; behind="${behind:-0}"
  # Read immutable native receipt recipes under the SAME operation view/lock.
  # The cursor is process-local; reboot replays idempotent native DB projections.
  projections=$(/usr/local/bin/smithers-jj-export --head-projections "$repo" "$ws" "$coding_cursor" "$change_id" "$commit_id" "$ahead" "$behind") || { flock -u 9; sleep "$poll"; continue; }
  flock -u 9
  if [ "$commit_id" != "$last_commit" ]; then
    if ! git -C "$repo" push --quiet --force --no-verify origin "${commit_id}:${ref}" >/dev/null 2>&1; then
      sleep "$poll"; continue
    fi
    last_commit="$commit_id"
  fi
  mapfile -t projection_lines <<< "$projections"
  if [ "${#projection_lines[@]}" -ne 3 ]; then sleep "$poll"; continue; fi
  next_cursor="${projection_lines[0]}"
  more="${projection_lines[1]}"
  report="$change_id $commit_id $ahead $behind $next_cursor"
  if [ "$report" != "$last_report" ]; then
    body="${projection_lines[2]}"
    if curl -fsS -m 20 -o /dev/null -X POST "${api}/api/repos/${slug}/workspaces/${ws}/head" \
         -H "Authorization: Bearer ${SMITHERS_WORKSPACE_TOKEN}" -H 'Content-Type: application/json' -d "$body" 2>/dev/null; then
      last_report="$report"
      coding_cursor="$next_cursor"
    else
      sleep "$poll"; continue
    fi
  fi
  last_heads="$heads"
  if [ "$more" = yes ]; then last_heads=""; fi
  sleep "$poll"
done
`

// workspaceHeadStore is the optional querier surface the reporter needs.
// *db.Queries implements it; narrow test doubles may omit it.
type workspaceHeadStore interface {
	SetWorkspaceHeadPushTokenID(ctx context.Context, arg db.SetWorkspaceHeadPushTokenIDParams) error
	GetRepoOwnerSlugAndNameByID(ctx context.Context, repositoryID int64) (db.GetRepoOwnerSlugAndNameByIDRow, error)
}

type workspaceRepositoryIdentityStore interface {
	GetRepoOwnerSlugAndNameByID(ctx context.Context, repositoryID int64) (db.GetRepoOwnerSlugAndNameByIDRow, error)
}

// sandboxExecClient is the exec surface the reporter install uses.
type sandboxExecClient interface {
	Execute(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error)
}

// workspaceHeadTokenScopes binds a token to one repository and one workspace.
func workspaceHeadTokenScopes(repositoryID int64, workspaceID string) string {
	return string(middleware.ScopeWriteRepository) + "," +
		middleware.RepositoryRestrictionScope(repositoryID) + "," +
		middleware.WorkspaceRestrictionScope(workspaceID)
}

// workspaceRepoSlug resolves "<owner>/<repo>" for a workspace's repository.
func (s *WorkspaceService) workspaceRepoSlug(ctx context.Context, repositoryID int64) (string, error) {
	store, ok := s.q.(workspaceRepositoryIdentityStore)
	if !ok {
		return "", pkgerrors.Internal("workspace store cannot resolve repositories")
	}
	row, err := store.GetRepoOwnerSlugAndNameByID(ctx, repositoryID)
	if err != nil {
		return "", pkgerrors.Internal("resolve workspace repository: " + err.Error())
	}
	owner := strings.TrimSpace(row.OwnerSlug)
	name := strings.TrimSpace(row.RepoName)
	if owner == "" || name == "" {
		return "", pkgerrors.Internal("workspace repository has no owner slug")
	}
	return owner + "/" + name, nil
}

func workspaceRepoGitURL(baseURL, slug string) (string, error) {
	owner, name, ok := strings.Cut(strings.TrimSpace(slug), "/")
	if !ok || strings.TrimSpace(owner) == "" || strings.TrimSpace(name) == "" {
		return "", fmt.Errorf("workspace repository slug is invalid")
	}
	cloneURL, err := buildRepoCloneURL(baseURL, owner, name)
	if err != nil {
		return "", err
	}
	return cloneURL.String(), nil
}

func workspaceGitCredentialEnvironment() string {
	return strings.Join([]string{
		"# Managed by Smithers: repository-scoped in-memory Git credential helper.",
		"export GIT_CONFIG_COUNT=2",
		"export GIT_CONFIG_KEY_0=" + shellQuote("credential.helper"),
		"export GIT_CONFIG_VALUE_0=" + shellQuote("cache --socket "+workspaceGitCredentialSocket),
		"export GIT_CONFIG_KEY_1=" + shellQuote("credential.useHttpPath"),
		"export GIT_CONFIG_VALUE_1=" + shellQuote("true"),
		"",
	}, "\n")
}

// revokeWorkspaceHeadToken revokes the reporter token recorded on the row
// and clears the column. Best effort: a missing token is not an error.
func (s *WorkspaceService) revokeWorkspaceHeadToken(ctx context.Context, workspace db.Workspace) {
	if s.q == nil || !workspace.HeadPushTokenID.Valid {
		return
	}
	revokeTemporaryRepoCloneToken(ctx, s.q, workspace.UserID, workspace.HeadPushTokenID.Int64)
	if store, ok := s.q.(workspaceHeadStore); ok {
		_ = store.SetWorkspaceHeadPushTokenID(ctx, db.SetWorkspaceHeadPushTokenIDParams{ID: workspace.ID})
	}
}

// installWorkspaceHeadReporter mints the workspace token, writes the reporter
// script, and (re)creates its systemd unit in the VM. It runs on every VM
// start (create, fork, resume, reprovision): a fork child inherits its
// parent's unit and token on disk, and both must be replaced before the
// child's first jj operation lands on the parent's head ref.
func (s *WorkspaceService) installWorkspaceHeadReporter(ctx context.Context, workspace db.Workspace, vmID string) (db.Workspace, error) {
	vmID = strings.TrimSpace(vmID)
	if s.q == nil || s.sandbox == nil || vmID == "" {
		return workspace, nil
	}
	store, ok := s.q.(workspaceHeadStore)
	if !ok {
		return workspace, nil
	}
	execClient, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return workspace, nil
	}
	slug, err := s.workspaceRepoSlug(ctx, workspace.RepositoryID)
	if err != nil {
		return workspace, err
	}
	gitURL, err := workspaceRepoGitURL(s.gitBaseURL, slug)
	if err != nil {
		return workspace, pkgerrors.Internal("build workspace repository URL: " + err.Error())
	}
	s.revokeWorkspaceHeadToken(ctx, workspace)
	workspace.HeadPushTokenID = pgtype.Int8{}
	token, err := issueTemporaryRepoTokenWithTTL(ctx, s.q, workspace.UserID, "sandbox-workspace-"+workspace.ID,
		workspaceHeadTokenScopes(workspace.RepositoryID, workspace.ID), workspaceHeadTokenTTL)
	if err != nil {
		return workspace, pkgerrors.Internal("mint workspace head token: " + err.Error())
	}
	if err := store.SetWorkspaceHeadPushTokenID(ctx, db.SetWorkspaceHeadPushTokenIDParams{
		ID:              workspace.ID,
		HeadPushTokenID: pgtype.Int8{Int64: token.ID, Valid: true},
	}); err != nil {
		revokeTemporaryRepoCloneToken(ctx, s.q, workspace.UserID, token.ID)
		return workspace, pkgerrors.Internal("record workspace head token: " + err.Error())
	}
	workspace.HeadPushTokenID = pgtype.Int8{Int64: token.ID, Valid: true}

	installCtx, cancel := context.WithTimeout(ctx, workspaceHeadInstallTimeout)
	defer cancel()
	timeoutMS := int64(workspaceHeadInstallTimeout / time.Millisecond)
	user := strings.TrimSpace(s.workspaceUsername)
	if user == "" {
		user = defaultWorkspaceUser
	}
	resp, err := execClient.Execute(installCtx, vmID, sandbox.ExecRequest{
		Command:   buildWorkspaceHeadReporterInstallCommand() + "\n" + buildWorkspaceCodingInstallCommand(workspace, user, strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/"), slug, gitURL),
		TimeoutMS: &timeoutMS,
	})
	if err != nil {
		return workspace, pkgerrors.Internal("install workspace head reporter: " + err.Error())
	}
	if resp.StatusCode != nil && *resp.StatusCode != 0 {
		return workspace, pkgerrors.Internal(fmt.Sprintf("install workspace head reporter failed with status %d: %s", *resp.StatusCode, strings.TrimSpace(resp.Stderr)))
	}
	restartSec := int64(5)
	result, err := s.sandbox.CreateService(installCtx, vmID, sandbox.ServiceSpec{
		Name: workspaceHeadReporterService,
		Mode: sandbox.ServiceModeService,
		Exec: []string{workspaceHeadReporterScriptPath},
		User: user,
		Env: map[string]string{
			"HOME":                        defaultWorkspaceHome,
			"USER":                        user,
			"PATH":                        "/usr/local/bin:/usr/bin:/bin",
			"SMITHERS_WORKSPACE_ID":       workspace.ID,
			"SMITHERS_WORKSPACE_REPO":     slug,
			"SMITHERS_WORKSPACE_BOOKMARK": targetWorkspaceBookmark(workspace.TargetBookmark),
			"SMITHERS_WORKSPACE_PATH":     defaultWorkspaceClonePath,
			"SMITHERS_WORKSPACE_TOKEN":    token.Plaintext,
			"SMITHERS_API_BASE_URL":       strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/"),
			"SMITHERS_WORKSPACE_GIT_URL":  gitURL,
			"SMITHERS_WORKSPACE_GIT_CREDENTIAL_SOCKET":          workspaceGitCredentialSocket,
			"SMITHERS_WORKSPACE_GIT_CREDENTIAL_TIMEOUT_SECONDS": fmt.Sprint(int64(workspaceHeadTokenTTL / time.Second)),
		},
		Workdir:       defaultWorkspaceHome,
		RestartPolicy: &sandbox.RestartPolicy{Kind: sandbox.RestartPolicyAlways, Sec: &restartSec},
	})
	if err != nil {
		return workspace, pkgerrors.Internal("start workspace head reporter: " + err.Error())
	}
	if !result.Success {
		return workspace, pkgerrors.Internal("start workspace head reporter: " + strings.TrimSpace(result.Message))
	}
	return workspace, nil
}

// buildWorkspaceHeadReporterInstallCommand writes the reporter script and
// stops any inherited unit so CreateService can register a fresh one.
func buildWorkspaceHeadReporterInstallCommand() string {
	return strings.Join([]string{
		"set -eu",
		"systemctl stop " + workspaceHeadReporterService + ".service >/dev/null 2>&1 || true",
		"systemctl reset-failed " + workspaceHeadReporterService + ".service >/dev/null 2>&1 || true",
		"install -d -m 755 /etc/smithers",
		"cat > " + shellQuote(workspaceGitCredentialEnvPath) + " <<'SMITHERS_GIT_ENV_EOF'\n" + workspaceGitCredentialEnvironment() + "SMITHERS_GIT_ENV_EOF",
		"chmod 644 " + shellQuote(workspaceGitCredentialEnvPath),
		"cat > " + shellQuote(workspaceHeadReporterScriptPath) + " <<'SMITHERS_HEAD_EOF'\n" + workspaceHeadReporterScript + "SMITHERS_HEAD_EOF",
		"chmod 755 " + shellQuote(workspaceHeadReporterScriptPath),
	}, "\n")
}

func buildWorkspaceCodingInstallCommand(workspace db.Workspace, user, baseURL, slug, gitURL string) string {
	config, _ := json.Marshal(map[string]any{
		"version": 1, "workspaceId": workspace.ID, "actorId": workspace.UserID,
		"repositoryPath": defaultWorkspaceClonePath, "username": user,
		"repositoryId": workspace.RepositoryID, "repositorySlug": slug,
		"apiBaseUrl": baseURL + "/api", "gitUrl": gitURL, "credentialSocket": workspaceGitCredentialSocket,
	})
	return strings.Join([]string{
		"install -d -m 755 /etc/smithers",
		"cat > " + shellQuote(workspaceCodingConfigPath) + " <<'SMITHERS_CODING_CONFIG_EOF'\n" + string(config) + "\nSMITHERS_CODING_CONFIG_EOF",
		"chown root:root " + shellQuote(workspaceCodingConfigPath),
		"chmod 644 " + shellQuote(workspaceCodingConfigPath),
	}, "\n")
}

// ensureWorkspaceHeadReporter restores process-owned credentials after a guest
// reboot even when the workspace and provider still report running. No token
// value is returned by the probe or written to guest storage.
func (s *WorkspaceService) ensureWorkspaceHeadReporter(ctx context.Context, workspace db.Workspace) (db.Workspace, error) {
	if _, ok := s.q.(workspaceHeadStore); !ok || s.sandbox == nil {
		return workspace, nil
	}
	execClient, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return workspace, pkgerrors.Conflict("workspace source publisher execution is unavailable")
	}
	probe := `owner_uid=$(id -u developer) || exit 2
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  [ "$(stat -c %u "$proc" 2>/dev/null)" = "$owner_uid" ] || continue
  if tr '\000' '\n' < "$proc/cmdline" | grep -Fxq '/usr/local/bin/smithers-workspace-head'; then
    test -S '/home/developer/.cache/smithers/git-credential/socket'
    exit $?
  fi
done
exit 1`
	timeout := int64(10000)
	result, err := execClient.Execute(ctx, workspace.VmID, sandbox.ExecRequest{Command: probe, TimeoutMS: &timeout})
	if err != nil || result.StatusCode == nil {
		return workspace, pkgerrors.Conflict("workspace source publisher could not be checked; retry")
	}
	if *result.StatusCode == 0 {
		return workspace, nil
	}
	if *result.StatusCode != 1 {
		return workspace, pkgerrors.Conflict("workspace source publisher probe failed; retry")
	}
	return s.installWorkspaceHeadReporter(ctx, workspace, workspace.VmID)
}

// installWorkspaceHeadReporterBestEffort logs instead of failing: a
// workspace without head visibility is degraded, not broken.
func (s *WorkspaceService) installWorkspaceHeadReporterBestEffort(ctx context.Context, workspace db.Workspace, vmID string) db.Workspace {
	updated, err := s.installWorkspaceHeadReporter(ctx, workspace, vmID)
	if err != nil {
		slog.Error("workspace head reporter install failed", "workspace_id", workspace.ID, "vm_id", vmID, "error", err)
		return workspace
	}
	return updated
}

// ReportWorkspaceHeadInput is a guest's self-report after a jj snapshot.
// TokenWorkspaceID is the workspace binding of the calling token ("" for a
// user token); a workspace may report only itself, an owner may report their
// own workspace.
type ReportWorkspaceHeadInput struct {
	RetainSource     *repohost.WorkspaceSource
	WorkspaceID      string
	RepositoryID     int64
	UserID           int64
	TokenWorkspaceID string
	ChangeID         string
	CommitID         string
	Ahead            int32
	Behind           int32
	CodingOperations []WorkspaceCodingProjection
}

// ReportWorkspaceHead stores the head and emits it on the workspace status
// stream as {"status", "head", "ahead", "behind"}.
func (s *WorkspaceService) ReportWorkspaceHead(ctx context.Context, input ReportWorkspaceHeadInput) (WorkspaceResponse, error) {
	if s.q == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace store unavailable")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	if input.WorkspaceID == "" {
		return WorkspaceResponse{}, pkgerrors.BadRequest("workspace id is required")
	}
	workspace, err := s.q.GetWorkspace(ctx, input.WorkspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return WorkspaceResponse{}, pkgerrors.NotFound("workspace not found")
		}
		return WorkspaceResponse{}, pkgerrors.Internal("load workspace: " + err.Error())
	}
	if workspace.RepositoryID != input.RepositoryID {
		return WorkspaceResponse{}, pkgerrors.NotFound("workspace not found")
	}
	tokenWorkspace := strings.ToLower(strings.TrimSpace(input.TokenWorkspaceID))
	switch {
	case tokenWorkspace != "":
		if tokenWorkspace != strings.ToLower(workspace.ID) {
			return WorkspaceResponse{}, pkgerrors.Forbidden("workspace credentials may only report their own workspace head")
		}
	case input.UserID == 0 || workspace.UserID != input.UserID:
		return WorkspaceResponse{}, pkgerrors.Forbidden("only the workspace owner may report its head")
	}
	if input.RetainSource != nil {
		return s.reportRetainedSource(ctx, workspace, input)
	}
	if err := validateCodingProjections(input.CodingOperations); err != nil {
		return WorkspaceResponse{}, err
	}
	for _, projection := range input.CodingOperations {
		revisions := make([]WorkspaceCodingRevision, 0, len(projection.ChangeIDs))
		for _, id := range projection.ChangeIDs {
			revisions = append(revisions, WorkspaceCodingRevision{ChangeID: id})
		}
		// This is the effective workspace execution principal, not a claim
		// about the initiating human of a shared Smithers run. That actor is
		// retained by the control journal's existing launch attribution.
		if err := s.recordCodingOperation(ctx, workspace.ID, workspace.RepositoryID, workspace.UserID, projection.Operation, WorkspaceCodingResult{
			OperationID: projection.OperationID, ParentOperationID: projection.ParentOperationID,
			Timestamp: projection.Timestamp, Revisions: revisions,
		}); err != nil {
			return WorkspaceResponse{}, err
		}
	}
	if err := s.UpdateWorkspaceHead(ctx, UpdateWorkspaceHeadInput{
		WorkspaceID: workspace.ID,
		ChangeID:    input.ChangeID,
		CommitID:    input.CommitID,
		Ahead:       input.Ahead,
		Behind:      input.Behind,
	}); err != nil {
		return WorkspaceResponse{}, err
	}
	updated, err := s.q.GetWorkspace(ctx, workspace.ID)
	if err != nil {
		return WorkspaceResponse{}, pkgerrors.Internal("reload workspace: " + err.Error())
	}
	s.notifyWorkspaceHead(ctx, updated)
	return s.toWorkspaceResponse(updated), nil
}

// notifyWorkspaceHead emits a head event on the workspace's status channel.
// The status field keeps existing subscribers, which only read status, valid.
func (s *WorkspaceService) notifyWorkspaceHead(ctx context.Context, workspace db.Workspace) {
	if s.q == nil || strings.TrimSpace(workspace.ID) == "" {
		return
	}
	safeID := strings.ReplaceAll(workspace.ID, "-", "")
	payload, _ := json.Marshal(map[string]any{
		"status": workspace.Status,
		"head":   WorkspaceHead{ChangeID: workspace.HeadChangeID, CommitID: workspace.HeadCommitID},
		"ahead":  workspace.Ahead,
		"behind": workspace.Behind,
	})
	_ = s.q.NotifyWorkspaceStatus(ctx, db.NotifyWorkspaceStatusParams{
		SessionID: safeID,
		Payload:   string(payload),
	})
}

// sandboxKindForWorkspace maps a workspace kind onto the sandbox execution
// model: agent workspaces are ordinary container guests.
func sandboxKindForWorkspace(kind string) string {
	switch normalizeWorkspaceKind(kind) {
	case "vm":
		return "vm"
	case "desktop":
		return "desktop"
	default:
		return "container"
	}
}
