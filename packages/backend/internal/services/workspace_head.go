package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
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

// workspaceHeadReporterProcessCheck defines is_head_reporter, which accepts a
// pid only while it runs the publisher, so a stale pidfile never names an
// unrelated process after a restart, fork or pid reuse.
const workspaceHeadReporterProcessCheck = `is_head_reporter() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/cmdline" ]; then
    tr '\000' ' ' < "/proc/$1/cmdline" | grep -q 'smithers-workspace-head'
  else
    ps -ww -p "$1" -o command= 2>/dev/null | grep -q 'smithers-workspace-head'
  fi
}`

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
# One publisher per guest: a replacement retires its predecessor, whose token
# the control plane has already revoked, before seeding its own credential.
pidfile="$credential_dir/reporter.pid"
` + workspaceHeadReporterProcessCheck + `
previous=""
{ read -r previous _ _ < "$pidfile"; } 2>/dev/null || true
if [ -n "$previous" ] && [ "$previous" != "$$" ] && is_head_reporter "$previous"; then
  kill -TERM "$previous" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$previous" 2>/dev/null || break; sleep 0.5; done
fi
# The probe reads which token this publisher holds and when it expires.
echo "$$ ${SMITHERS_WORKSPACE_TOKEN_ID:-0} ${SMITHERS_WORKSPACE_TOKEN_EXPIRES_AT:-0}" > "$pidfile"
# The last publisher to write the pidfile owns the guest. One that started
# beside it exits at its next poll and leaves the owner's credential alone.
owns_guest() {
  owner=""
  { read -r owner _ _ < "$pidfile"; } 2>/dev/null || true
  [ "$owner" = "$$" ]
}
owns_guest || exit 0
git credential-cache --socket "$credential_socket" exit >/dev/null 2>&1 || true
# Git in the checkout reads the cached credential without a guest profile.
credential_helper="cache --socket $credential_socket"
if [ -d "$repo/.git" ] && ! git -C "$repo" config --get-all credential.helper 2>/dev/null | grep -Fxq "$credential_helper"; then
  git -C "$repo" config --add credential.helper "$credential_helper" || true
  git -C "$repo" config credential.useHttpPath true || true
fi
refresh_credential() {
  printf 'url=%s\nusername=smithers\npassword=%s\n\n' "$credential_url" "$SMITHERS_WORKSPACE_TOKEN" |
    git credential-cache --timeout "$credential_timeout" --socket "$credential_socket" store
}
refresh_credential
clear_credential() {
  owns_guest || return 0
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
  owns_guest || exit 0
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

// revokeWorkspaceHeadToken revokes the reporter token recorded on the row,
// clears the column, and revokes the children credential with it. Best
// effort: a missing token is not an error.
func (s *WorkspaceService) revokeWorkspaceHeadToken(ctx context.Context, workspace db.Workspace) {
	s.revokeWorkspaceChildrenToken(ctx, workspace)
	if s.q == nil || !workspace.HeadPushTokenID.Valid {
		return
	}
	// Clear whatever token the row records, even one another replica swapped
	// in after this caller read the row, so none stays live and unrecorded.
	if store, ok := s.q.(workspaceHeadSwapStore); ok {
		expected := workspace.HeadPushTokenID
		for attempt := 0; attempt < 3 && expected.Valid; attempt++ {
			won, err := store.SwapWorkspaceHeadPushTokenID(ctx, workspace.ID, workspace.UserID, expected, pgtype.Int8{})
			if err != nil {
				revokeTemporaryRepoCloneToken(ctx, s.q, workspace.UserID, expected.Int64)
				break
			}
			if won {
				break
			}
			current, err := s.q.GetWorkspace(ctx, workspace.ID)
			if err != nil {
				break
			}
			expected = current.HeadPushTokenID
		}
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
	workspace, token, err := s.rotateWorkspaceHeadToken(ctx, store, workspace)
	if err != nil {
		return workspace, err
	}

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
		Env: s.workspaceHeadReporterEnvironment(workspace, slug, gitURL, defaultWorkspaceClonePath, workspaceGitCredentialSocket, token,
			map[string]string{"HOME": defaultWorkspaceHome, "USER": user, "PATH": "/usr/local/bin:/usr/bin:/bin"}),
		Workdir:       defaultWorkspaceHome,
		RestartPolicy: &sandbox.RestartPolicy{Kind: sandbox.RestartPolicyAlways, Sec: &restartSec},
	})
	if err != nil {
		return workspace, pkgerrors.Internal("start workspace head reporter: " + err.Error())
	}
	if !result.Success {
		return workspace, pkgerrors.Internal("start workspace head reporter: " + strings.TrimSpace(result.Message))
	}
	// Without it the workspace cannot spawn children from inside; it still works.
	if err := s.installWorkspaceChildrenToken(ctx, workspace, vmID); err != nil {
		slog.Warn("workspace children token install failed", "workspace_id", workspace.ID, "vm_id", vmID, "error", err)
	}
	return workspace, nil
}

// rotateWorkspaceHeadToken revokes the workspace's previous publisher token and
// records a fresh workspace-bound one, so suspend, stop and delete revoke it.
func (s *WorkspaceService) rotateWorkspaceHeadToken(ctx context.Context, store workspaceHeadStore, workspace db.Workspace) (db.Workspace, temporaryRepoCloneToken, error) {
	s.revokeWorkspaceHeadToken(ctx, workspace)
	workspace.HeadPushTokenID = pgtype.Int8{}
	token, err := issueTemporaryRepoTokenWithTTL(ctx, s.q, workspace.UserID, "sandbox-workspace-"+workspace.ID,
		workspaceHeadTokenScopes(workspace.RepositoryID, workspace.ID), workspaceHeadTokenTTL)
	if err != nil {
		return workspace, temporaryRepoCloneToken{}, pkgerrors.Internal("mint workspace head token: " + err.Error())
	}
	if err := store.SetWorkspaceHeadPushTokenID(ctx, db.SetWorkspaceHeadPushTokenIDParams{
		ID:              workspace.ID,
		HeadPushTokenID: pgtype.Int8{Int64: token.ID, Valid: true},
	}); err != nil {
		revokeTemporaryRepoCloneToken(ctx, s.q, workspace.UserID, token.ID)
		return workspace, temporaryRepoCloneToken{}, pkgerrors.Internal("record workspace head token: " + err.Error())
	}
	workspace.HeadPushTokenID = pgtype.Int8{Int64: token.ID, Valid: true}
	return workspace, token, nil
}

// workspaceHeadReporterEnvironment is the publisher's configuration. The token
// travels only in the process environment, never in guest files.
func (s *WorkspaceService) workspaceHeadReporterEnvironment(workspace db.Workspace, slug, gitURL, repositoryPath, credentialSocket string, token temporaryRepoCloneToken, extra map[string]string) map[string]string {
	environment := map[string]string{
		"SMITHERS_WORKSPACE_TOKEN_ID":                       fmt.Sprint(token.ID),
		"SMITHERS_WORKSPACE_TOKEN_EXPIRES_AT":               fmt.Sprint(token.ExpiresAt.Unix()),
		"SMITHERS_WORKSPACE_ID":                             workspace.ID,
		"SMITHERS_WORKSPACE_REPO":                           slug,
		"SMITHERS_WORKSPACE_BOOKMARK":                       targetWorkspaceBookmark(workspace.TargetBookmark),
		"SMITHERS_WORKSPACE_PATH":                           repositoryPath,
		"SMITHERS_WORKSPACE_TOKEN":                          token.Plaintext,
		"SMITHERS_API_BASE_URL":                             strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/"),
		"SMITHERS_WORKSPACE_GIT_URL":                        gitURL,
		"SMITHERS_WORKSPACE_GIT_CREDENTIAL_SOCKET":          credentialSocket,
		"SMITHERS_WORKSPACE_GIT_CREDENTIAL_TIMEOUT_SECONDS": fmt.Sprint(int64(workspaceHeadTokenTTL / time.Second)),
	}
	for name, value := range extra {
		environment[name] = value
	}
	return environment
}

// runtimeWorkspaceHeadReporterProbe exits 0 only while the publisher holding
// the recorded token runs, that token is not due for renewal, and its
// credential cache is listening.
const runtimeWorkspaceHeadReporterProbe = workspaceHeadReporterProcessCheck + `
socket="${SMITHERS_WORKSPACE_GIT_CREDENTIAL_SOCKET:?}"
{ read -r pid token_id expires < "${socket%/*}/reporter.pid"; } 2>/dev/null || exit 1
[ -n "$pid" ] && [ "$token_id" = "${SMITHERS_WORKSPACE_TOKEN_ID:?}" ] || exit 1
[ "${expires:-0}" -gt "${SMITHERS_WORKSPACE_TOKEN_RENEW_BEFORE:?}" ] 2>/dev/null || exit 1
is_head_reporter "$pid" && [ -S "$socket" ]`

const (
	// workspaceHeadSeedTimeout bounds the wait for a new publisher's credential.
	workspaceHeadSeedTimeout = 15 * time.Second
	// workspaceHeadRetryDelay spaces repeated failed installs for one workspace.
	workspaceHeadRetryDelay = time.Minute
)

// workspaceHeadSwapStore records a publisher token only over the one the
// caller read and revokes that one in the same statement, so neither a crash
// nor a concurrent API replica leaves a token live and unrecorded.
type workspaceHeadSwapStore interface {
	SwapWorkspaceHeadPushTokenID(ctx context.Context, id string, userID int64, expected, next pgtype.Int8) (bool, error)
}

// ensureRuntimeWorkspaceHeadReporter gives a runtime workspace the same
// publisher as a sandbox workspace: a workspace-bound repository credential in
// the guest's in-memory Git cache and the RFD-004 head reports. The probe runs
// in the guest and checks the recorded token, so any replica repairs a missing,
// revoked, expiring or superseded publisher. Failures degrade head visibility
// and repository access; they never block the workspace from running.
func (s *WorkspaceService) ensureRuntimeWorkspaceHeadReporter(ctx context.Context, row db.Workspace, requesterID int64, observed workspaceapi.Workspace) db.Workspace {
	store, ok := s.q.(workspaceHeadSwapStore)
	if !ok || !s.runtime.Capabilities().ManagedServices || strings.TrimSpace(observed.Home) == "" || strings.TrimSpace(observed.Root) == "" {
		return row
	}
	retries := s.headReporterRetryAt
	if retries != nil {
		if retryAt, ok := retries.Load(row.ID); ok && time.Now().Before(retryAt.(time.Time)) {
			return row
		}
	}
	updated, err := s.installRuntimeWorkspaceHeadReporter(ctx, store, row, requesterID, observed)
	if err != nil {
		// A cancelled request says nothing about the publisher; retry at once.
		if retries != nil && ctx.Err() == nil {
			retries.Store(row.ID, time.Now().Add(workspaceHeadRetryDelay))
		}
		slog.Error("workspace head reporter install failed", "workspace_id", row.ID, "error", err)
		return updated
	}
	if retries != nil {
		retries.Delete(row.ID)
	}
	return updated
}

func (s *WorkspaceService) installRuntimeWorkspaceHeadReporter(ctx context.Context, store workspaceHeadSwapStore, row db.Workspace, requesterID int64, observed workspaceapi.Workspace) (db.Workspace, error) {
	socket := path.Join(observed.Home, ".cache", "smithers", "git-credential", "socket")
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "head-reporter"))
	if err != nil {
		return row, err
	}
	probe := func(tokenID int64) (bool, error) {
		renewBefore := time.Now().Add(workspaceHeadTokenTTL / 2).Unix()
		result, err := s.runtime.ExecuteCommand(operationCtx, row.ID, workspaceapi.Command{
			Args: []string{"/bin/sh", "-c", runtimeWorkspaceHeadReporterProbe},
			Environment: map[string]string{
				"SMITHERS_WORKSPACE_GIT_CREDENTIAL_SOCKET": socket,
				"SMITHERS_WORKSPACE_TOKEN_ID":              fmt.Sprint(tokenID),
				"SMITHERS_WORKSPACE_TOKEN_RENEW_BEFORE":    fmt.Sprint(renewBefore),
			},
		})
		if err != nil {
			return false, err
		}
		return result.ExitCode == 0, nil
	}
	// Probe and replace against the recorded token, never a stale copy.
	current, err := s.q.GetWorkspace(ctx, row.ID)
	if err != nil {
		return row, err
	}
	expected := current.HeadPushTokenID
	row.HeadPushTokenID = expected
	if expected.Valid {
		if running, err := probe(expected.Int64); err != nil || running {
			return row, err
		}
	}
	slug, err := s.workspaceRepoSlug(ctx, row.RepositoryID)
	if err != nil {
		return row, err
	}
	gitURL, err := workspaceRepoGitURL(s.gitBaseURL, slug)
	if err != nil {
		return row, err
	}
	token, err := issueTemporaryRepoTokenWithTTL(ctx, s.q, row.UserID, "sandbox-workspace-"+row.ID,
		workspaceHeadTokenScopes(row.RepositoryID, row.ID), workspaceHeadTokenTTL)
	if err != nil {
		return row, pkgerrors.Internal("mint workspace head token: " + err.Error())
	}
	next := pgtype.Int8{Int64: token.ID, Valid: true}
	won, err := store.SwapWorkspaceHeadPushTokenID(ctx, row.ID, row.UserID, expected, next)
	if err != nil || !won {
		revokeTemporaryRepoCloneToken(ctx, s.q, row.UserID, token.ID)
		if err != nil {
			return row, pkgerrors.Internal("record workspace head token: " + err.Error())
		}
		// Another replica replaced the publisher first; its token stands.
		if latest, err := s.q.GetWorkspace(ctx, row.ID); err == nil {
			row.HeadPushTokenID = latest.HeadPushTokenID
		}
		return row, nil
	}
	row.HeadPushTokenID = next
	// A replica that launched an earlier publisher still supervises it.
	if err := s.runtime.StopService(operationCtx, row.ID, workspaceHeadReporterService); err != nil {
		slog.Debug("workspace head reporter had no supervised predecessor", "workspace_id", row.ID, "error", err)
	}
	if _, err := s.runtime.StartService(operationCtx, row.ID, workspaceapi.ServiceSpec{
		Name:     workspaceHeadReporterService,
		Identity: fmt.Sprintf("%s:%d", workspaceHeadReporterService, token.ID),
		Command: workspaceapi.Command{
			Args:        []string{"/bin/bash", "-c", workspaceHeadReporterScript},
			Environment: s.workspaceHeadReporterEnvironment(row, slug, gitURL, observed.Root, socket, token, nil),
		},
	}); err != nil {
		return row, err
	}
	// Running means the checkout can reach its repository: wait for the seed,
	// and stop waiting as soon as the publisher exits. A publisher that never
	// seeds is stopped, so the next install starts from an empty guest.
	if err := s.awaitRuntimeWorkspaceHeadSeed(ctx, operationCtx, row.ID, token.ID, probe); err != nil {
		if stopErr := s.runtime.StopService(context.WithoutCancel(operationCtx), row.ID, workspaceHeadReporterService); stopErr != nil {
			slog.Debug("workspace head reporter stop after a failed seed", "workspace_id", row.ID, "error", stopErr)
		}
		return row, err
	}
	// A replica that swapped after this one owns the workspace now. Stop this
	// publisher, which may have retired that replica's; the next probe finds
	// no publisher for the recorded token and installs one.
	if latest, err := s.q.GetWorkspace(ctx, row.ID); err == nil && latest.HeadPushTokenID != next {
		if err := s.runtime.StopService(operationCtx, row.ID, workspaceHeadReporterService); err != nil {
			slog.Debug("workspace head reporter stop after a lost install", "workspace_id", row.ID, "error", err)
		}
		row.HeadPushTokenID = latest.HeadPushTokenID
	}
	return row, nil
}

// awaitRuntimeWorkspaceHeadSeed waits until the publisher holding tokenID has
// seeded its credential, failing when it exits or the seed timeout passes.
func (s *WorkspaceService) awaitRuntimeWorkspaceHeadSeed(ctx, operationCtx context.Context, workspaceID string, tokenID int64, probe func(int64) (bool, error)) error {
	deadline := time.Now().Add(workspaceHeadSeedTimeout)
	for {
		running, err := probe(tokenID)
		if err != nil {
			return err
		}
		if running {
			return nil
		}
		if service, err := s.runtime.InspectService(operationCtx, workspaceID, workspaceHeadReporterService); err == nil && service.State != workspaceapi.ServiceRunning {
			return fmt.Errorf("workspace head reporter exited before seeding its credential: %s", strings.TrimSpace(service.Stderr))
		}
		if time.Now().After(deadline) {
			return errors.New("workspace head reporter did not seed its credential")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// repairRuntimeWorkspaceHeadReporter is the box host's repair for a runtime
// workspace: it restores the runtime publisher and reports failure, since the
// host needs a working repository credential.
func (s *WorkspaceService) repairRuntimeWorkspaceHeadReporter(ctx context.Context, workspace db.Workspace) (db.Workspace, error) {
	store, ok := s.q.(workspaceHeadSwapStore)
	if !ok || !s.runtime.Capabilities().ManagedServices {
		return workspace, nil
	}
	unlock := s.lockRuntimeWorkspace(workspace.ID)
	defer unlock()
	operationCtx, err := s.workspaceRuntimeContext(ctx, workspace, workspace.UserID, workspaceLifecycleOperation(workspace, "inspect"))
	if err != nil {
		return workspace, err
	}
	observed, err := s.runtime.InspectWorkspace(operationCtx, workspace.ID)
	if err != nil {
		return workspace, pkgerrors.Conflict("workspace source publisher could not be checked; retry").WithCause(err)
	}
	if strings.TrimSpace(observed.Home) == "" || strings.TrimSpace(observed.Root) == "" {
		return workspace, nil
	}
	return s.installRuntimeWorkspaceHeadReporter(ctx, store, workspace, workspace.UserID, observed)
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
	if s.runtime != nil {
		return s.repairRuntimeWorkspaceHeadReporter(ctx, workspace)
	}
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
