package services

import (
	"context"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const (
	// Repository installs, builds and the coding host share the guest memory
	// budget with /tmp tmpfs; the provider's 512 MiB default is insufficient.
	defaultWorkspaceMemoryMB  = 4096
	defaultWorkspaceVCPUCount = 2
	defaultWorkspaceSSHHost   = "vm-ssh.smithers.sh"
	defaultWorkspaceUser      = "agent"
	defaultWorkspaceSSHUser   = defaultWorkspaceUser
	defaultWorkspaceHome      = "/home/agent"
	defaultWorkspaceClonePath = "/workspace"
	// A resume no longer waits for the (non-re-firing) ready signal, so StartSandbox
	// returns as soon as sandbox provider accepts the resume (~2s live). 30s is pure
	// headroom for a slow accept under load; blowing it now means a genuine
	// sandbox provider failure, not the old ready-signal hang, so reprovisioning is
	// the right fallback then.
	workspaceResumeTimeout = 30 * time.Second
	// Resuming a disk from an older release can stream a new CLI archive and
	// install its toolchain after the fast provider start. Keep that repair
	// bounded separately so a normal StartSandbox failure still returns promptly.
	workspaceResumeProvisionTimeout = 5 * time.Minute
	// Forking is an optimization for derived workspaces, not the provision's
	// whole job. A wedged Microsandbox fork request must leave enough of the outer
	// provisioning budget for the cold create+clone fallback.
	//
	// A fork is NOT a cheap control-plane call: the controller snapshots the
	// source VM and streams that snapshot to durable object storage BEFORE
	// booting the child, because the runtime holds a local snapshot mutation
	// lock while exporting and a running child consumes the snapshot as its CoW
	// parent. So the export is unavoidably on the fork's critical path, and a
	// real workspace snapshot is ~140 MB. The old 30s budget predated working
	// exports (a NetworkPolicy blocked all DNS from the microsandbox namespace,
	// so exports never completed at all); once DNS was restored, every fork
	// started dying at ~32s with "worker request: ... context canceled" —
	// killing an export that was progressing normally.
	//
	// 150s is sized off that export: ~140 MB at a deliberately pessimistic
	// ~2 MB/s sustained worker->controller->GCS throughput is ~70s, plus child
	// VM create and control-plane overhead. That is ~5x the old budget and ~4x
	// the observed failure point, while staying bounded so a genuinely wedged
	// fork still fails and falls back instead of hanging forever. It matches
	// workspaceForkSwitchTimeout and sits below workspaceBareVMCreateAttemptTimeout,
	// keeping the cold create+clone fallback affordable inside
	// workspaceProvisionTimeout. Both call sites treat a fork failure as a
	// fallback, never as a provisioning failure.
	workspaceForkTimeout = 150 * time.Second
	// Snapshot boots skip apt but must still stage a changed deployment bundle
	// and finish its toolchain bootstrap. Bare creates also materialize the image
	// and install default packages synchronously. Keep separate budgets with
	// enough room for a golden failure, bare fallback, clone, and settlement.
	workspaceGoldenVMCreateAttemptTimeout = 4 * time.Minute
	workspaceBareVMCreateAttemptTimeout   = 7 * time.Minute
	// ExecAwait also carries a VM-side timeout. The client-side bounds sit 30
	// seconds above it for response/transport headroom while ensuring a wedged
	// Microsandbox HTTP request cannot monopolize the full provisioning context.
	workspaceForkSwitchTimeout = 150 * time.Second
	workspaceCloneTimeout      = 210 * time.Second
	workspaceProvisionTimeout  = 15 * time.Minute
	// A live provision can spend its whole budget before VM registration (for
	// example golden failure followed by a bare create and toolchain bootstrap).
	// Neither pending nor starting-with-VM rows may be reaped before it ends.
	workspaceStaleAfter               = workspaceProvisionTimeout + time.Minute
	workspaceStartingWithVMStaleAfter = workspaceStaleAfter
	// workspaceSessionProvisionGrace is how long CreateSession waits for
	// provisioning to finish before returning the pending session ticket and
	// letting provisioning continue in the background. Fast paths (VM already
	// running, immediate failures) resolve synchronously inside this window so
	// callers still get the running/failed result; a fresh VM boot exceeds it
	// and the multi client polls GetSession / the SSE stream instead. This
	// window must stay far below upstream proxy deadlines (~125s in prod).
	workspaceSessionProvisionGrace = 1 * time.Second
	// workspaceReadyTimeoutSeconds is carried on the provider-neutral request
	// for runtimes that wait on ReadySignal. The signal is deliberately trivial
	// for container/vm workspaces and independent of the network-heavy
	// claude/node/jj bootstrap. Desktop requests move it to
	// smithers-desktop-start so create returns only after noVNC is reachable.
	// The service-level golden/bare deadlines above remain the outer bounds.
	workspaceReadyTimeoutSeconds int64 = 90
	// workspaceClaudePackage pins the Claude Code release a workspace bootstrap
	// installs when the image carries none; keep it in step with
	// CLAUDE_CODE_VERSION in Plue's cmd/agent-vm/Dockerfile.
	workspaceClaudePackage       = "@anthropic-ai/claude-code@2.1.286"
	workspaceClaudeScriptPath    = "/usr/local/bin/smithers-install-claude-code"
	workspaceClaudeService       = "smithers-workspace-claude-bootstrap"
	workspaceReadyService        = "smithers-workspace-ready"
	workspaceCodingHostPath      = "/usr/local/bin/smithers-coding-host"
	workspaceCodingHostB64Path   = workspaceArtifactCurrent + "/smithers-workspace-coding-host.b64"
	workspaceCodingHostBinaryEnv = "SMITHERS_WORKSPACE_CODING_HOST_BINARY"
	// The coding host's flows shell out to this native jj helper for their
	// --eligible preflight and tree export, so every workspace kind needs it
	// staged next to the host. The API image carries it under /usr/local/lib
	// (cmd/server/Dockerfile jj-export-builder) because that image is musl and
	// the payload is a glibc binary it must transport, never execute.
	// Smoke-run logs for the two staged binaries. The bootstrap templates name
	// these paths literally; the artifact tests redirect them to a temp dir and
	// assert the constants stay in step with the rendered script.
	workspaceCodingHostSmokeLog = "/tmp/smithers-workspace-coding-host-smoke.log"
	workspaceJJExportSmokeLog   = "/tmp/smithers-workspace-jj-export-smoke.log"
	workspaceJJExportPath       = "/usr/local/bin/smithers-jj-export"
	// WorkspaceJJExportGuestPath is the executable installed by every workspace
	// bootstrap. Hosted Flow hosts run inside that guest, not in the API image.
	WorkspaceJJExportGuestPath   = workspaceJJExportPath
	workspaceJJExportB64Path     = workspaceArtifactCurrent + "/smithers-workspace-jj-export.b64"
	workspaceJJExportBinaryEnv   = "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"
	workspaceDefaultJJExportPath = "/usr/local/lib/smithers/smithers-jj-export"
	workspaceJJReleaseAPIURL     = "https://api.github.com/repos/jj-vcs/jj/releases/tags/v0.39.0"
	workspaceNodeDistIndexURL    = "https://nodejs.org/dist/index.json"
	workspaceNodeMajor           = "26"
	workspaceLocalDir            = defaultWorkspaceHome + "/.local"
	workspaceLocalBinDir         = defaultWorkspaceHome + "/.local/bin"
	workspaceLocalNodeDir        = defaultWorkspaceHome + "/.local/node"
	workspaceNodeInstallLog      = defaultWorkspaceHome + "/.smithers/node-install.log"
	workspaceClaudeInstallLog    = defaultWorkspaceHome + "/.smithers/claude-install.log"
	// workspaceBunVersion pins the bun runtime installed into workspace VMs
	// (via the npm `bun` package); keep in sync with BUN_VERSION in
	// scripts/create-agent-snapshot.ts.
	workspaceBunVersion = "1.3.9"

	workspaceCLIPackageEnv     = "SMITHERS_WORKSPACE_CLI_PACKAGE"
	workspaceDefaultCLIPackage = "/opt/smithers/cli.tar"
	workspaceCLIPackageB64Path = workspaceArtifactCurrent + "/smithers-workspace-cli-package.b64"
	workspaceCLIPackageDir     = "/usr/local/lib/smithers-cli"

	// MaxActiveWorkspacesPerUser caps the number of non-deleted workspaces
	// any single authenticated user may own (ticket 0105). Enforced on
	// every create path (CreateWorkspace non-reuse branch, ForkWorkspace,
	// snapshot-restore branch). Reuse of an existing primary workspace
	// does NOT count — the user is resuming, not allocating new state.
	//
	// Delete semantics are SOFT: DeleteWorkspace tombstones the row
	// (workspaces.deleted_at), which drops it out of this count, so the
	// spec promise "delete one to continue" holds.
	//
	// This is a PLACEHOLDER for real payment / plan tier logic. When
	// billing ships, replace the constant with a per-user lookup; do not
	// treat the number 100 as load-bearing architecture.
	MaxActiveWorkspacesPerUser = 100
)

var defaultWorkspacePackages = []string{"ca-certificates", "git", "nodejs", "npm", "util-linux"}

const defaultWorkspaceEnvironmentSource = ".smithers/environment.nix"

// WorkspaceEnvironment identifies the immutable Nix closure selected when a
// workspace is created. Empty revision/hash values mean the repository's
// environment has not been built yet; source remains stable for the UI.
type WorkspaceEnvironment struct {
	Source      string `json:"source"`
	Revision    string `json:"revision"`
	ClosureHash string `json:"closure_hash"`
	// Image is the NixOS closure image a kind=vm/desktop workspace booted
	// (empty for container workspaces).
	Image string `json:"image,omitempty"`
}

// WorkspaceDesktop is the kind=desktop stream surface.

// WorkspaceDesktopSession identifies a desktop stream session. The relay
// token itself is returned once by POST .../desktop/session.

// WorkspaceHead is the last head reported by the workspace guest after jj
// snapshotted its working copy.
type WorkspaceHead struct {
	ChangeID string `json:"change_id"`
	CommitID string `json:"commit_id"`
}

// WorkspaceResponse is the API representation of a first-class workspace.
type WorkspaceResponse struct {
	ID             string                      `json:"id"`
	RepositoryID   int64                       `json:"repository_id"`
	UserID         int64                       `json:"user_id"`
	Name           string                      `json:"name"`
	Slug           string                      `json:"slug,omitempty"`
	Branch         string                      `json:"branch,omitempty"`
	TargetBookmark string                      `json:"target_bookmark"`
	RepoFullName   string                      `json:"repo_full_name,omitempty"`
	HTMLURL        string                      `json:"html_url,omitempty"`
	Status         string                      `json:"status"`
	Isolation      workspaceapi.IsolationLevel `json:"isolation,omitempty"`
	FailureCode    string                      `json:"failure_code,omitempty"`
	FailureMessage string                      `json:"failure_message,omitempty"`
	Kind           string                      `json:"kind"`
	Environment    WorkspaceEnvironment        `json:"environment"`
	Resources      WorkspaceResources          `json:"resources"`
	// SourceCommit is the pushed-ref commit the workspace checked out, empty
	// when it started from its bookmark (#1968).
	SourceCommit string `json:"source_commit,omitempty"`
	// Desktop is present only for kind=desktop workspaces.
	Head   WorkspaceHead `json:"head"`
	Ahead  int32         `json:"ahead"`
	Behind int32         `json:"behind"`
	// AgentSessionID is set on kind=agent rows: the run this computer
	// belongs to (RFD-004).
	AgentSessionID    string `json:"agent_session_id,omitempty"`
	ProvisioningStage string `json:"provisioning_stage,omitempty"`
	IsFork            bool   `json:"is_fork"`
	ParentWorkspaceID string `json:"parent_workspace_id,omitempty"`
	VMID              string `json:"vm_id"`
	Persistence       string `json:"persistence"`
	SSHHost           string `json:"ssh_host,omitempty"`
	SnapshotID        string `json:"snapshot_id,omitempty"`
	// LSP advertises the languages a session of kind lsp can serve (#505).
	LSP                WorkspaceLSP `json:"lsp"`
	IdleTimeoutSeconds int32        `json:"idle_timeout_seconds"`
	LastActivityAt     time.Time    `json:"last_activity_at"`
	// ClientLeaseExpiresAt is set only on a leased workspace (#2457).
	ClientLeaseExpiresAt *time.Time `json:"client_lease_expires_at,omitempty"`
	SuspendedAt          *time.Time `json:"suspended_at"`
	StartedAt            *time.Time `json:"started_at"`
	ResumedAt            *time.Time `json:"resumed_at"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`

	// Present only when the exact immutable source pin was verified.
	RetainedSource *WorkspaceRetainedSource `json:"retained_source,omitempty"`
}

// WorkspaceSessionResponse is the API representation of a workspace session.
type WorkspaceSessionResponse struct {
	ID           string `json:"id"`
	WorkspaceID  string `json:"workspace_id"`
	RepositoryID int64  `json:"repository_id"`
	UserID       int64  `json:"user_id"`
	Status       string `json:"status"`
	// Kind is terminal or lsp; Language is set for lsp sessions only (#505).
	Kind            string    `json:"kind"`
	Language        string    `json:"language,omitempty"`
	Cols            int32     `json:"cols"`
	Rows            int32     `json:"rows"`
	LastActivityAt  time.Time `json:"last_activity_at"`
	IdleTimeoutSecs int32     `json:"idle_timeout_secs"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// WorkspaceSSHHostKey describes a single accepted SSH gateway host key.
// Clients must pin the server identity to one of the advertised entries
// before sending credentials, preventing MITM on the terminal transport.
//
// Fields:
//   - Algorithm: RFC 4253 key-type name, e.g. "ssh-ed25519".
//   - PublicKey: wire-format public key, base64(standard) encoded. This
//     is what SSH clients compare byte-for-byte; fingerprints are for
//     display only.
//   - FingerprintSHA256: OpenSSH-style "SHA256:..." fingerprint, for
//     operator diagnostics and error messages. Do not verify from this
//     alone — a hash collision in display text is easier to spoof than
//     a byte comparison of the raw key.
//   - KnownHostsLine: OpenSSH known_hosts-compatible line for clients
//     that want to write it to a file (e.g. the iOS client does not
//     have known_hosts).
type WorkspaceSSHHostKey struct {
	Algorithm         string `json:"algorithm"`
	PublicKey         string `json:"public_key"`
	FingerprintSHA256 string `json:"fingerprint_sha256"`
	KnownHostsLine    string `json:"known_hosts_line,omitempty"`
}

// WorkspaceSSHConnectionInfo contains the SSH access details for a workspace session.
//
// HostKeys carries every currently-valid gateway host key. During a
// rotation the list contains both the old and new keys so clients with
// either pinned continue to succeed. The terminal handler accepts any
// advertised key and rejects everything else.
//
// SECURITY (ticket 0117): this is the in-memory, on-the-wire struct returned
// by the HTTP route. It contains the minted AccessToken and the executable
// Command. NEVER persist this struct to a database column or any other
// replicated/sync surface — use RedactedForPersistence() instead, which
// strips AccessToken and Command while preserving identifier fields and
// host_keys.
type WorkspaceSSHConnectionInfo struct {
	WorkspaceID string                `json:"workspace_id"`
	SessionID   string                `json:"session_id"`
	VMID        string                `json:"vm_id"`
	Kind        string                `json:"kind"`
	Host        string                `json:"host"`
	DialHost    string                `json:"-"`
	SSHHost     string                `json:"ssh_host"`
	Username    string                `json:"username"`
	Port        int                   `json:"port"`
	Workdir     string                `json:"workdir,omitempty"`
	AccessToken string                `json:"access_token"`
	Command     string                `json:"command"`
	HostKeys    []WorkspaceSSHHostKey `json:"host_keys"`
	// RuntimeTerminal selects the shared WorkspaceRuntime PTY transport. The
	// remaining fields are request-local inputs for the common terminal manager
	// and are never serialized or persisted.
	RuntimeTerminal bool  `json:"-"`
	RepositoryID    int64 `json:"-"`
	RequesterUserID int64 `json:"-"`
}

// PersistedWorkspaceSSHConnectionInfo is the shape-safe subset of
// WorkspaceSSHConnectionInfo that is stored in
// workspace_sessions.ssh_connection_info. Ticket 0117 split the
// persisted half from the minted half specifically so the row can be
// replicated to clients via the realtime stream without leaking
// credentials.
//
// Field contract:
//   - WorkspaceID, SessionID, VMID, Kind, Host, SSHHost, Username, Port,
//     Workdir — stable identifiers the client needs to reconnect or display.
//     Safe to sync.
//   - HostKeys — public host-key trust anchors from ticket 0130. Public
//     keys are not credentials; the client NEEDS them to pin the server
//     identity on reconnect. Safe to sync.
//
// What is deliberately absent:
//   - access_token — freshly-minted, short-lived SSH credential. NEVER
//     persisted. Re-minted on demand by GetSSHConnectionInfo.
//   - command — contains the access_token inline; same concern.
//
// The JSON tag set matches WorkspaceSSHConnectionInfo for every field that
// is present, so a replicated row round-trips cleanly through a client
// that deserializes into the same struct (with the secret fields simply
// absent / zero).
type PersistedWorkspaceSSHConnectionInfo struct {
	WorkspaceID string                `json:"workspace_id"`
	SessionID   string                `json:"session_id"`
	VMID        string                `json:"vm_id"`
	Kind        string                `json:"kind"`
	Host        string                `json:"host"`
	SSHHost     string                `json:"ssh_host"`
	Username    string                `json:"username"`
	Port        int                   `json:"port"`
	Workdir     string                `json:"workdir,omitempty"`
	HostKeys    []WorkspaceSSHHostKey `json:"host_keys"`
}

// RedactedForPersistence returns a shape-safe projection of the
// connection info for storage in workspace_sessions.ssh_connection_info.
//
// Returned struct is by value so callers cannot accidentally share the
// AccessToken or Command fields of the source struct. The only fields
// that leave this function are the ones explicitly listed in
// PersistedWorkspaceSSHConnectionInfo.
func (w WorkspaceSSHConnectionInfo) RedactedForPersistence() PersistedWorkspaceSSHConnectionInfo {
	return PersistedWorkspaceSSHConnectionInfo{
		WorkspaceID: w.WorkspaceID,
		SessionID:   w.SessionID,
		VMID:        w.VMID,
		Kind:        w.Kind,
		Host:        w.Host,
		SSHHost:     w.SSHHost,
		Username:    w.Username,
		Port:        w.Port,
		Workdir:     w.Workdir,
		HostKeys:    w.HostKeys,
	}
}

// UserWorkspaceRow is the switcher-row DTO returned by
// GET /api/user/workspaces (ticket 0135). Distinct from WorkspaceResponse:
// WorkspaceResponse is scoped to one repo and omits repo owner/name and the
// recency fields the switcher renders. Reusing it here would force the client
// to cross-reference another endpoint for every row.
type UserWorkspaceRow struct {
	WorkspaceID       string        `json:"workspace_id"`
	RepositoryID      int64         `json:"repository_id"`
	RepositoryOwner   string        `json:"repository_owner"`
	RepositoryName    string        `json:"repository_name"`
	WorkspaceTitle    string        `json:"workspace_title"`
	State             string        `json:"state"`
	FailureCode       string        `json:"failure_code,omitempty"`
	FailureMessage    string        `json:"failure_message,omitempty"`
	TargetBookmark    string        `json:"target_bookmark"`
	ProvisioningStage string        `json:"provisioning_stage,omitempty"`
	SuspendedAt       *time.Time    `json:"suspended_at"`
	Kind              string        `json:"kind"`
	Head              WorkspaceHead `json:"head"`
	Ahead             int32         `json:"ahead"`
	Behind            int32         `json:"behind"`
	StartedAt         *time.Time    `json:"started_at"`
	LastAccessedAt    *time.Time    `json:"last_accessed_at"`
	LastActivityAt    time.Time     `json:"last_activity_at"`
	CreatedAt         time.Time     `json:"created_at"`
	SortTimestamp     time.Time     `json:"sort_timestamp"`
}

// WorkspaceSnapshotResponse is the API representation of a reusable workspace snapshot.
type WorkspaceSnapshotResponse struct {
	ID           string    `json:"id"`
	RepositoryID int64     `json:"repository_id"`
	UserID       int64     `json:"user_id"`
	Name         string    `json:"name"`
	WorkspaceID  string    `json:"workspace_id,omitempty"`
	SnapshotID   string    `json:"snapshot_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// CreateWorkspaceInput is the input for creating or resuming a first-class workspace.
type CreateWorkspaceInput struct {
	RepositoryID   int64
	UserID         int64
	RepoOwner      string
	RepoName       string
	Name           string
	SnapshotID     string
	SourceBookmark string
	// SourceRef names one of the caller's pushed refs
	// (refs/smithers/users/<id>/<name>); the new workspace checks out its
	// commit instead of the bookmark (#1968).
	SourceRef   string
	Kind        string
	Environment WorkspaceEnvironment
	Resources   WorkspaceResources
	// ClientLeaseSeconds, when positive, leases the workspace to a client that
	// renews it; a lapsed lease lets the abandon reaper reclaim it (#2457).
	ClientLeaseSeconds int32
}

// CreateWorkspaceSessionInput is the input for creating a new workspace session.
type CreateWorkspaceSessionInput struct {
	RepositoryID   int64
	UserID         int64
	Cols           int32
	Rows           int32
	RepoOwner      string
	RepoName       string
	WorkspaceID    string
	SourceBookmark string
	// Kind is terminal (default) or lsp; Language names the LSP session's
	// registry row and is required with kind lsp (#505).
	Kind     string
	Language string
}

// ForkWorkspaceInput is the input for forking a running workspace.
type ForkWorkspaceInput struct {
	RepositoryID int64
	UserID       int64
	WorkspaceID  string
	Name         string
}

// CreateWorkspaceSnapshotInput is the input for taking a conditional snapshot from a workspace.
type CreateWorkspaceSnapshotInput struct {
	RepositoryID int64
	UserID       int64
	WorkspaceID  string
	Name         string
}

// UpdateWorkspacePodStatusInput is the input for updating workspace runtime status.
type UpdateWorkspacePodStatusInput struct {
	WorkspaceID string
	Status      string // "running", "suspended", "stopped", "failed"
}

// UpdateWorkspaceHeadInput is the atomic status report emitted after a guest
// jj snapshot. Ahead/behind are computed in the guest against TargetBookmark,
// where the working copy is authoritative, then persisted for cheap API reads.
type UpdateWorkspaceHeadInput struct {
	WorkspaceID string
	ChangeID    string
	CommitID    string
	Ahead       int32
	Behind      int32
}

// WorkspaceQuerier defines the minimal DB operations needed by WorkspaceService.
type WorkspaceQuerier interface {
	CreateWorkspace(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error)
	// The permanent outsider mark (outsider_workspaces): a workspace that ran
	// work started from an outsider's text, and whether its box is known to
	// run only the egress that withholds GitHub conversation.
	IsOutsiderWorkspace(ctx context.Context, workspaceID string) (bool, error)
	MarkOutsiderWorkspace(ctx context.Context, repositoryID int64, workspaceID string) error
	IsOutsiderWorkspaceEgressSealed(ctx context.Context, workspaceID string) (bool, error)
	SealOutsiderWorkspaceEgress(ctx context.Context, workspaceID string) error
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
	GetWorkspaceByRepo(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error)
	GetWorkspaceForUserRepo(ctx context.Context, arg db.GetWorkspaceForUserRepoParams) (db.Workspace, error)
	ListWorkspacesByRepo(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error)
	CountWorkspacesByRepo(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error)
	CountActiveWorkspacesByUser(ctx context.Context, userID int64) (int64, error)
	ListUserWorkspacesAcrossRepos(ctx context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error)
	CountUserWorkspacesAcrossRepos(ctx context.Context, userID int64) (int64, error)
	GetActiveWorkspaceForUserRepo(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error)
	GetActiveWorkspaceForUserRepoKind(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error)
	GetActiveWorkspaceForIdentity(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error)
	UpdateWorkspaceStatus(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error)
	SuspendRunningWorkspace(ctx context.Context, id string) (db.Workspace, error)
	SuspendRunningWorkspaceIfSessionless(ctx context.Context, id string) (db.Workspace, error)
	ResumeWorkspaceToRunning(ctx context.Context, id string) (db.Workspace, error)
	UpdateWorkspaceExecutionInfo(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error)
	MarkWorkspaceResumed(ctx context.Context, arg db.MarkWorkspaceResumedParams) error
	UpdateWorkspaceHead(ctx context.Context, arg db.UpdateWorkspaceHeadParams) (db.Workspace, error)
	SoftDeleteWorkspace(ctx context.Context, id string) (db.Workspace, error)
	TouchWorkspaceActivity(ctx context.Context, id string) error
	TouchWorkspaceLastAccessed(ctx context.Context, id string) error
	UpdateWorkspaceTargetBookmark(ctx context.Context, arg db.UpdateWorkspaceTargetBookmarkParams) (db.Workspace, error)
	CountActiveSessionsForWorkspace(ctx context.Context, workspaceID string) (int64, error)
	ListIdleWorkspaces(ctx context.Context) ([]db.Workspace, error)
	ListRunningWorkspaces(ctx context.Context) ([]db.Workspace, error)
	ListStalePendingWorkspaces(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error)
	ListStaleStartingWorkspacesWithVM(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error)
	FailStaleStartingWorkspace(ctx context.Context, arg db.FailStaleStartingWorkspaceParams) (db.Workspace, error)
	CreateWorkspaceSnapshot(ctx context.Context, arg db.CreateWorkspaceSnapshotParams) (db.WorkspaceSnapshot, error)
	GetWorkspaceSnapshot(ctx context.Context, id string) (db.WorkspaceSnapshot, error)
	GetWorkspaceSnapshotByRepo(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error)
	GetWorkspaceSnapshotForUserRepo(ctx context.Context, arg db.GetWorkspaceSnapshotForUserRepoParams) (db.WorkspaceSnapshot, error)
	ListWorkspaceSnapshotsByRepo(ctx context.Context, arg db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error)
	CountWorkspaceSnapshotsByRepo(ctx context.Context, arg db.CountWorkspaceSnapshotsByRepoParams) (int64, error)
	DeleteWorkspaceSnapshot(ctx context.Context, id string) error
	CreateWorkspaceSession(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error)
	CreateWorkspaceLSPSession(ctx context.Context, arg db.CreateWorkspaceLSPSessionParams) (db.WorkspaceSession, error)
	GetActiveWorkspaceLSPSession(ctx context.Context, arg db.GetActiveWorkspaceLSPSessionParams) (db.WorkspaceSession, error)
	GetWorkspaceSession(ctx context.Context, id string) (db.WorkspaceSession, error)
	GetWorkspaceSessionByRepo(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error)
	GetWorkspaceSessionForUserRepo(ctx context.Context, arg db.GetWorkspaceSessionForUserRepoParams) (db.WorkspaceSession, error)
	ListWorkspaceSessionsByRepo(ctx context.Context, arg db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error)
	CountWorkspaceSessionsByRepo(ctx context.Context, arg db.CountWorkspaceSessionsByRepoParams) (int64, error)
	UpdateWorkspaceSessionStatus(ctx context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error)
	MarkWorkspaceSessionRunning(ctx context.Context, id string) (db.WorkspaceSession, error)
	FailActiveWorkspaceSession(ctx context.Context, id string) (db.WorkspaceSession, error)
	UpdateWorkspaceSessionSSHConnectionInfo(ctx context.Context, arg db.UpdateWorkspaceSessionSSHConnectionInfoParams) (db.WorkspaceSession, error)
	TouchWorkspaceSessionActivity(ctx context.Context, id string) error
	ListIdleWorkspaceSessions(ctx context.Context) ([]db.WorkspaceSession, error)
	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
	NotifyWorkspaceStatus(ctx context.Context, arg db.NotifyWorkspaceStatusParams) error
	GetWorkspaceShare(ctx context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error)
}

// WorkspaceService owns product authorization, admission, durable rows, and
// lifecycle reconciliation around either a shared runtime or the legacy
// sandbox transport during migration.
type WorkspaceService struct {
	// laneStopping runs before StopLaneMachine stops a retired lane
	// (OnLaneStopping).
	laneStopping         func(context.Context, db.Workspace)
	commandJobs          *jobs.Store
	commandCodec         flowhost.SecretCodec
	provisionTasks       *workspaceProvisionTasks
	launchSessionCleanup func(string, func())
	// sessionProvisionGrace is how long CreateSession waits before answering
	// with the pending ticket; see workspaceSessionProvisionGrace.
	sessionProvisionGrace time.Duration
	billing               BillingPolicy
	audit                 *AuditService
	sourceReader          WorkspaceSourceReader
	refDeleter            WorkspaceRefDeleter
	userRefs              UserRefHost
	// branchHeads reads a scratch branch's head (WithBranchHeads).
	branchHeads BranchHeadReader
	q           WorkspaceQuerier
	// transactions holds each workspace's provisioning lock (a transaction-
	// scoped advisory lock).
	transactions                 RepositoryJobTransactions
	branchMachineProviders       BranchMachineProviders
	sandbox                      SandboxVMClient
	runtime                      workspaceapi.WorkspaceRuntime
	runtimeIdentity              WorkspaceRuntimeIdentityResolver
	runtimeLocks                 *workspaceRuntimeLockRegistry
	sandboxMetrics               SandboxMetricsRecorder
	gitBaseURL                   string
	sshHost                      string
	sshDialHost                  string
	workspaceUsername            string
	workspaceSSHUsername         string
	workspaceIdleTimeoutSeconds  int64
	workspacePersistence         sandbox.PersistenceMode
	workspacePersistencePriority int32
	// sshHostKeyDir is the directory that contains the gateway SSH host
	// key files (ssh_host_ed25519_key and optionally the rotation
	// companion ssh_host_ed25519_key.next). It is the same directory
	// the SSH server reads at boot (see internal/ssh/server.go and
	// cmd/ssh/main.go). When non-empty, the service publishes matching
	// public-key material in WorkspaceSSHConnectionInfo.HostKeys.
	sshHostKeyDir string
	// hostKeyLoader reads gateway host-key material. Tests can override
	// to avoid on-disk key files. When nil and sshHostKeyDir is set,
	// defaultHostKeyLoader is used.
	hostKeyLoader HostKeyLoader
	// goldenSnapshots supplies the pre-baked toolchain snapshot fresh VMs boot
	// from (nil / empty id → bare base image, exactly the old behavior).
	goldenSnapshots *GoldenSnapshotService
	// agentEnvironment supplies setup-only secrets and persistent nonsecret
	// variables for new repository workspace VMs.
	agentEnvironment  AgentEnvironmentProvisioningProvider
	repositorySecrets *SecretInjector
	// egressAllowDomains is the repository allowlist every workspace VM's
	// egress proxy is created and resumed with (#2653).
	egressAllowDomains EgressAllowDomainsSource
	// flowJournals drops a deleted workspace's flow journal (#3172).
	flowJournals FlowJournals
	// boxHostActivity is when each box's coding host last recorded activity.
	boxHostActivity *sync.Map
	// headReporterRetryAt spaces failed runtime publisher installs per workspace.
	headReporterRetryAt *sync.Map
	// terminalCredentials are the signed-in terminals' delegated credentials
	// by workspace session id (T-TRM-02).
	terminalCredentials *sync.Map
	providerConnections ProviderPoolOffer
	providerBootstrap   bool
	platformSeats       []modelproxy.Seat
	codingDefaultModel  string
	// environmentImages resolves the NixOS closure image kind=vm/desktop
	// workspaces boot (nil → those kinds cannot be created).
	environmentImages WorkspaceEnvironmentImageResolver
	// boxTools names the tools a box's placement declares, verified on the
	// booted box before its coding host starts (WithWorkspaceBoxTools).
	boxTools func(ctx context.Context, workspaceID string) ([]string, error)
	// Workspace, agent and desktop kinds have independent resource settings.
	workspaceMemoryMB  int32
	workspaceVCPUCount int32
	agentMemoryMB      int32
	agentVCPUCount     int32
	resourceLimits     workspaceResourceLimits
	// desktop observations. See WithWorkspaceDesktopObserveText.
	// leaseDeleteAfter is how long after a client lease lapses the abandon
	// reaper deletes the workspace. See WithWorkspaceLeaseDeleteAfter.
	leaseDeleteAfter time.Duration
}

// WorkspaceServiceOption configures optional dependencies.
type WorkspaceServiceOption func(*WorkspaceService)

// WorkspaceRuntimeIdentityResolver maps an already-authorized product
// workspace request onto the tenant and principal identifiers an isolated
// deployment uses for infrastructure fencing. The default uses the durable
// workspace owner as tenant and the authenticated user as principal.
type WorkspaceRuntimeIdentityResolver func(context.Context, db.Workspace, int64) (workspaceapi.Operation, error)

// WithWorkspaceRuntime selects the common execution boundary used after
// product authorization and admission. Both trusted process and isolated Plue
// adapters enter WorkspaceService through this option.
func WithWorkspaceRuntime(runtime workspaceapi.WorkspaceRuntime) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.runtime = runtime }
}

func WithWorkspaceRuntimeIdentityResolver(resolver WorkspaceRuntimeIdentityResolver) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.runtimeIdentity = resolver }
}

// WithWorkspaceSandboxClient sets the sandbox provider VM client for workspace lifecycle operations.
func WithWorkspaceSandboxClient(client SandboxVMClient) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		s.sandbox = client
	}
}

// WithWorkspaceGoldenSnapshots wires the golden-snapshot provider so fresh
// workspace VMs boot from the pre-baked toolchain image instead of the bare
// base image.
func WithWorkspaceGoldenSnapshots(golden *GoldenSnapshotService) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.goldenSnapshots = golden }
}

// WithWorkspaceRepositorySecrets reuses the workflow snapshot splitter for
// branch boot/wake. Unbound delivery stays dark until the machine contracts land.
func WithWorkspaceRepositorySecrets(injector *SecretInjector) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.repositorySecrets = injector }
}

// WithWorkspaceAgentEnvironment wires the repository environment provider into
// the VM provisioning lifecycle.
func WithWorkspaceAgentEnvironment(provider AgentEnvironmentProvisioningProvider) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.agentEnvironment = provider }
}

// WithWorkspaceEgressAllowDomains sends each repository's egress allowlist
// with every workspace VM it creates, forks or resumes.
func WithWorkspaceEgressAllowDomains(source EgressAllowDomainsSource) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.egressAllowDomains = source }
}

// WithWorkspaceProviderConnections offers the owner's connected accounts to
// each workspace boot through the account pool route. Self-host only: the
// server wires it only when feature_flags.subscription_connections is on.
func WithWorkspaceProviderConnections(pool ProviderPoolOffer) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.providerConnections = pool }
}

// WithWorkspaceProviderBootstrap offers the platform model seats as the
// fallback after repository keys and connected accounts. The guest reaches
// them through the metered model proxy with a workspace model credential that
// only the host-side egress proxy holds; no provider key enters the guest.
func WithWorkspaceProviderBootstrap(seats []modelproxy.Seat, model string) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		s.providerBootstrap = true
		s.platformSeats = slices.Clone(seats)
		s.codingDefaultModel = strings.TrimSpace(model)
	}
}

// WithWorkspaceSandboxMetrics sets the metrics recorder for sandbox provider workspace lifecycle metrics.
func WithWorkspaceSandboxMetrics(metrics SandboxMetricsRecorder) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		s.sandboxMetrics = metrics
	}
}

// WithWorkspaceGitBaseURL sets the public Smithers base URL used for cloning repos into workspaces.
func WithWorkspaceGitBaseURL(url string) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		s.gitBaseURL = url
	}
}

// WithWorkspaceSSHHost overrides the SSH hostname used for workspace connections.
func WithWorkspaceSSHHost(host string) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if host != "" {
			s.sshHost = host
		}
	}
}

// WithWorkspaceSSHDialHost overrides the private hostname used by the API
// when it opens browser terminal SSH sessions. Public SSH metadata still
// advertises sshHost.
func WithWorkspaceSSHDialHost(host string) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if host != "" {
			s.sshDialHost = host
		}
	}
}

// WithWorkspaceSSHHostKeyDir configures the directory containing the SSH
// gateway host key files (ssh_host_ed25519_key and optionally
// ssh_host_ed25519_key.next for rotation). This should be the same path
// the SSH server uses (cfg.SSH.HostKeyDir). Clients use the advertised
// public-key material for strict host-key verification before SSH auth.
func WithWorkspaceSSHHostKeyDir(dir string) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		s.sshHostKeyDir = dir
	}
}

// WithWorkspaceSSHHostKeyLoader overrides the host-key loader. Intended
// for tests; production wiring uses the default disk-backed loader.
func WithWorkspaceSSHHostKeyLoader(loader HostKeyLoader) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		s.hostKeyLoader = loader
	}
}

// WithWorkspaceSandboxConfig configures default sandbox provider workspace behavior.
func WithWorkspaceSandboxConfig(idleTimeoutSeconds int64, persistence sandbox.PersistenceMode) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if idleTimeoutSeconds > 0 {
			s.workspaceIdleTimeoutSeconds = idleTimeoutSeconds
		}
		if persistence != "" {
			s.workspacePersistence = persistence
		}
	}
}

// WithWorkspaceResources sizes kind=vm/container workspaces. Non-positive
// values keep the built-in defaults.
func WithWorkspaceResources(memoryMB, vcpuCount int32) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if memoryMB > 0 {
			s.workspaceMemoryMB = memoryMB
		}
		if vcpuCount > 0 {
			s.workspaceVCPUCount = vcpuCount
		}
	}
}

// WithWorkspaceAgentResources sizes kind=agent workspaces using the existing
// agent sandbox settings. Non-positive values keep the built-in defaults.
func WithWorkspaceAgentResources(memoryMB, vcpuCount int32) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if memoryMB > 0 {
			s.agentMemoryMB = memoryMB
		}
		if vcpuCount > 0 {
			s.agentVCPUCount = vcpuCount
		}
	}
}

// WithWorkspaceDesktopResources sizes kind=desktop VMs. A non-positive value
// keeps the built-in default: an unset or mistyped deployment value must never
// boot a 0 MiB guest.

// WithWorkspaceDesktopObserveText toggles reading the focused Chrome tab's
// document text in desktop observations. Off makes every observation report
// text: null — the operator's kill switch for that prompt-injection channel,
// with no code change and no client change.

// NewWorkspaceService returns a new WorkspaceService.
func NewWorkspaceService(q WorkspaceQuerier, opts ...WorkspaceServiceOption) *WorkspaceService {
	svc := &WorkspaceService{
		provisionTasks:               newWorkspaceProvisionTasks(),
		boxHostActivity:              &sync.Map{},
		headReporterRetryAt:          &sync.Map{},
		terminalCredentials:          &sync.Map{},
		launchSessionCleanup:         SafeGo,
		sessionProvisionGrace:        workspaceSessionProvisionGrace,
		q:                            q,
		sshHost:                      defaultWorkspaceSSHHost,
		workspaceUsername:            defaultWorkspaceUser,
		workspaceSSHUsername:         defaultWorkspaceSSHUser,
		workspaceIdleTimeoutSeconds:  1800,
		workspacePersistence:         sandbox.PersistencePersistent,
		workspacePersistencePriority: 5,
		workspaceMemoryMB:            defaultWorkspaceMemoryMB,
		workspaceVCPUCount:           defaultWorkspaceVCPUCount,
		agentMemoryMB:                4096,
		agentVCPUCount:               2,
		leaseDeleteAfter:             defaultWorkspaceLeaseDeleteAfter,
		runtimeLocks:                 &workspaceRuntimeLockRegistry{entries: make(map[string]*workspaceRuntimeLock)},
	}
	for _, opt := range opts {
		opt(svc)
	}
	if svc.sshDialHost == "" {
		svc.sshDialHost = svc.sshHost
	}
	return svc
}

// loadOwnedWorkspace loads a workspace by ID + repo, then enforces that the
// requester either owns the workspace or holds an explicit WRITE share grant.
// It is the loader for every mutating caller (suspend, resume, delete, fork,
// snapshot, session create, SSH credentials). Read-only callers go through
// loadWorkspaceWithAccess with WorkspaceAccessRead instead.
func (s *WorkspaceService) loadOwnedWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (db.Workspace, error) {
	return s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
}

// CheckWorkspaceDesktopAccess checks the same write grant used by desktop
// observe and input before their request is charged to a rate bucket.

// workspacePreviewAuthorizationQuerier is what AuthorizeWorkspacePreview
// reads beyond WorkspaceQuerier; the production store (db.Queries) has it.
type workspacePreviewAuthorizationQuerier interface {
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	middleware.RepoPermissionQuerier
}

// AuthorizeWorkspacePreview answers the preview gateway's recheck of a
// viewer's grant: the account can still sign in, the repository is still
// readable to it, and the workspace is still its own or shared with it. A
// removed share, suspended user, or owner losing repository access fails here
// on the gateway's next check.
func (s *WorkspaceService) AuthorizeWorkspacePreview(ctx context.Context, workspaceID string, repositoryID, userID int64) error {
	if s == nil || s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}
	store, ok := s.q.(workspacePreviewAuthorizationQuerier)
	if !ok {
		return pkgerrors.Internal("workspace preview authorization unavailable")
	}
	user, err := store.GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("access denied")
		}
		return pkgerrors.Internal("load preview viewer").WithCause(err)
	}
	if !user.IsActive || user.ProhibitLogin || user.DeletedAt.Valid {
		return pkgerrors.Forbidden("access denied")
	}
	repository, err := store.GetRepoByID(ctx, repositoryID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("access denied")
		}
		return pkgerrors.Internal("load preview repository").WithCause(err)
	}
	permission, permErr := middleware.ResolveRepoPermission(ctx, store, repository, &user)
	if permErr != nil {
		return permErr
	}
	if !permission.Satisfies(middleware.PermissionRead) {
		return pkgerrors.Forbidden("access denied")
	}
	workspace, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return err
	}
	if workspace.UserID != userID {
		owner, err := store.GetUserByID(ctx, workspace.UserID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.Forbidden("access denied")
			}
			return pkgerrors.Internal("load preview owner").WithCause(err)
		}
		if !owner.IsActive || owner.ProhibitLogin || owner.DeletedAt.Valid {
			return pkgerrors.Forbidden("access denied")
		}
		ownerPermission, permissionErr := middleware.ResolveRepoPermission(ctx, store, repository, &owner)
		if permissionErr != nil {
			return permissionErr
		}
		if !ownerPermission.Satisfies(middleware.PermissionRead) {
			return pkgerrors.Forbidden("access denied")
		}
	}
	return nil
}

// loadWorkspaceWithAccess loads a workspace by ID + repo, then enforces that
// the requester either owns the workspace or holds an explicit share grant at
// or above minLevel. Returns 404 if the workspace does not exist in the repo,
// or 403 if it exists but the requester has insufficient access.
func (s *WorkspaceService) loadWorkspaceWithAccess(ctx context.Context, workspaceID string, repositoryID, userID int64, minLevel WorkspaceAccessLevel) (db.Workspace, error) {
	workspace, err := s.q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{
		ID:           workspaceID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		// workspaces.id is UUID-typed: a non-UUID id makes Postgres raise
		// SQLSTATE 22P02. Collapse that (and a genuine no-rows) into a uniform
		// NotFound so a malformed id returns a clean 404 instead of a 500 that
		// leaks the raw driver text. Guards every route through this loader
		// (get/suspend/resume/delete/fork/ssh).
		if errors.Is(err, pgx.ErrNoRows) || isInvalidTextRepresentation(err) {
			return db.Workspace{}, pkgerrors.NotFound("workspace not found")
		}
		return db.Workspace{}, pkgerrors.Internal("load workspace: " + err.Error())
	}
	if err := s.requireWorkspaceAccess(ctx, workspace.ID, workspace.UserID, userID, minLevel); err != nil {
		return db.Workspace{}, err
	}
	return workspace, nil
}

// loadOwnedWorkspaceSnapshot loads a snapshot by ID + repo, then enforces
// ownership/share. Snapshots are write-only operations (you take or delete
// them), so we require write-level access to the owning workspace.
func (s *WorkspaceService) loadOwnedWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) (db.WorkspaceSnapshot, error) {
	snapshot, err := s.q.GetWorkspaceSnapshotByRepo(ctx, db.GetWorkspaceSnapshotByRepoParams{
		ID:           snapshotID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		// See loadOwnedWorkspace: a non-UUID id (22P02) is a uniform 404, not a
		// driver-text-leaking 500.
		if errors.Is(err, pgx.ErrNoRows) || isInvalidTextRepresentation(err) {
			return db.WorkspaceSnapshot{}, pkgerrors.NotFound("workspace snapshot not found")
		}
		return db.WorkspaceSnapshot{}, pkgerrors.Internal("load workspace snapshot: " + err.Error())
	}
	// Snapshots are per-user; their user_id is the owner. A non-owner with
	// a write share on the parent workspace may also operate on its snapshots.
	if snapshot.UserID != userID {
		// Check if the requester has write access to the snapshot's workspace.
		if snapshot.WorkspaceID != "" {
			if err := s.requireWorkspaceAccess(ctx, snapshot.WorkspaceID, snapshot.UserID, userID, WorkspaceAccessWrite); err != nil {
				return db.WorkspaceSnapshot{}, err
			}
		} else {
			return db.WorkspaceSnapshot{}, pkgerrors.Forbidden("access denied")
		}
	}
	return snapshot, nil
}

// loadOwnedWorkspaceSession loads a session by ID + repo requiring WRITE
// access to the owning workspace (destroy, SSH credentials, terminal attach).
// Read-only callers go through loadWorkspaceSessionWithAccess instead.
func (s *WorkspaceService) loadOwnedWorkspaceSession(ctx context.Context, sessionID string, repositoryID, userID int64) (db.WorkspaceSession, error) {
	return s.loadWorkspaceSessionWithAccess(ctx, sessionID, repositoryID, userID, WorkspaceAccessWrite)
}

// loadWorkspaceSessionWithAccess loads a session by ID + repo, then enforces
// ownership/share against the OWNING WORKSPACE — never the session creator's
// identity. Creator identity must neither grant access (a revoked collaborator
// keeps session.user_id forever, so a creator shortcut would outlive share
// revocation) nor deny it (the workspace owner holds no share row for their
// own workspace, so passing the creator as "owner" locked owners out of
// collaborator-created sessions).
func (s *WorkspaceService) loadWorkspaceSessionWithAccess(ctx context.Context, sessionID string, repositoryID, userID int64, minLevel WorkspaceAccessLevel) (db.WorkspaceSession, error) {
	session, err := s.q.GetWorkspaceSessionByRepo(ctx, db.GetWorkspaceSessionByRepoParams{
		ID:           sessionID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		// See loadOwnedWorkspace: a non-UUID id (22P02) is a uniform 404, not a
		// driver-text-leaking 500.
		if errors.Is(err, pgx.ErrNoRows) || isInvalidTextRepresentation(err) {
			return db.WorkspaceSession{}, pkgerrors.NotFound("workspace session not found")
		}
		return db.WorkspaceSession{}, pkgerrors.Internal("load workspace session: " + err.Error())
	}
	workspace, err := s.q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{
		ID:           session.WorkspaceID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		// A session whose workspace is gone (deleted) is not operable; collapse
		// into the same uniform 404 as a missing session.
		if errors.Is(err, pgx.ErrNoRows) || isInvalidTextRepresentation(err) {
			return db.WorkspaceSession{}, pkgerrors.NotFound("workspace session not found")
		}
		return db.WorkspaceSession{}, pkgerrors.Internal("load workspace session: " + err.Error())
	}
	if err := s.requireWorkspaceAccess(ctx, workspace.ID, workspace.UserID, userID, minLevel); err != nil {
		return db.WorkspaceSession{}, err
	}
	return session, nil
}

// GetWorkspace returns a first-class workspace by ID. Viewing status is a
// read-level operation, so a read share  is sufficient.
func (s *WorkspaceService) GetWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (WorkspaceResponse, error) {
	if s.q == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace store unavailable")
	}

	workspace, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return WorkspaceResponse{}, err
	}

	return s.toWorkspaceResponse(workspace), nil
}

// ListWorkspaces returns paginated workspaces for a repository.
func (s *WorkspaceService) ListWorkspaces(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]WorkspaceResponse, int64, error) {
	if s.q == nil {
		return nil, 0, pkgerrors.Internal("workspace store unavailable")
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > 100 {
		perPage = 30
	}
	offset := (page - 1) * perPage

	rows, err := s.q.ListWorkspacesByRepo(ctx, db.ListWorkspacesByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
		PageOffset:   ClampInt32(offset),
		PageSize:     int32(perPage),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("list workspaces: " + err.Error())
	}

	total, err := s.q.CountWorkspacesByRepo(ctx, db.CountWorkspacesByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("count workspaces: " + err.Error())
	}

	result := make([]WorkspaceResponse, 0, len(rows))
	for _, row := range rows {
		result = append(result, s.toWorkspaceResponse(row))
	}
	return result, total, nil
}

// UserWorkspaceListResult carries paginated user-scoped workspaces plus
// the total count (for pagination headers). Separate from WorkspaceResponse
// / the existing list result so the switcher-row shape remains explicit.
type UserWorkspaceListResult struct {
	Items      []UserWorkspaceRow
	TotalCount int64
	Page       int
	PerPage    int
}

// MaxUserWorkspacesPerPage caps the /api/user/workspaces limit. The product
// target is ~100 workspaces per user, so the switcher should typically
// load in a single request; this matches MaxActiveWorkspacesPerUser.
const MaxUserWorkspacesPerPage = 100

// ListUserWorkspacesAcrossRepos returns the user's workspaces across every
// repo they can still read (ticket 0135), ordered by best-available recency
// (ticket 0136's last_accessed_at takes precedence via COALESCE).
//
// Authorization is explicit:
//   - Only workspaces with user_id = current user appear (owner-scoped).
//   - Repos the user can no longer read drop out — this is the "revoked
//     access hides the row" behavior reviewers verify.
//   - Tombstoned workspaces (deleted_at) are already excluded by the query.
func (s *WorkspaceService) ListUserWorkspacesAcrossRepos(ctx context.Context, userID int64, page, perPage int) (UserWorkspaceListResult, error) {
	if s.q == nil {
		return UserWorkspaceListResult{}, pkgerrors.Internal("workspace store unavailable")
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 30
	}
	if perPage > MaxUserWorkspacesPerPage {
		perPage = MaxUserWorkspacesPerPage
	}
	// Cap page so the int32 SQL offset (page-1)*perPage cannot overflow to a
	// negative value, which would 500 the query.
	if maxPage := math.MaxInt32/perPage + 1; page > maxPage {
		page = maxPage
	}
	offset := ClampInt32((page - 1) * perPage)

	rows, err := s.q.ListUserWorkspacesAcrossRepos(ctx, db.ListUserWorkspacesAcrossReposParams{
		UserID:     userID,
		PageOffset: offset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return UserWorkspaceListResult{}, pkgerrors.Internal("list user workspaces: " + err.Error())
	}

	total, err := s.q.CountUserWorkspacesAcrossRepos(ctx, userID)
	if err != nil {
		return UserWorkspaceListResult{}, pkgerrors.Internal("count user workspaces: " + err.Error())
	}

	items := make([]UserWorkspaceRow, 0, len(rows))
	for _, r := range rows {
		row := UserWorkspaceRow{
			WorkspaceID:       r.WorkspaceID,
			RepositoryID:      r.RepositoryID,
			RepositoryOwner:   r.RepositoryOwner,
			RepositoryName:    r.RepositoryName,
			WorkspaceTitle:    r.WorkspaceTitle,
			State:             r.Status,
			FailureCode:       r.FailureCode.String,
			FailureMessage:    r.FailureMessage.String,
			TargetBookmark:    targetWorkspaceBookmark(r.TargetBookmark),
			ProvisioningStage: r.ProvisioningStage,
			Kind:              normalizeWorkspaceKind(r.Kind),
			Head:              WorkspaceHead{ChangeID: r.HeadChangeID, CommitID: r.HeadCommitID},
			Ahead:             r.Ahead,
			Behind:            r.Behind,
			LastActivityAt:    r.LastActivityAt,
			CreatedAt:         r.CreatedAt,
			SortTimestamp:     r.SortTimestamp,
		}
		if r.SuspendedAt.Valid {
			t := r.SuspendedAt.Time
			row.SuspendedAt = &t
		}
		if r.StartedAt.Valid {
			t := r.StartedAt.Time
			row.StartedAt = &t
		}
		if r.LastAccessedAt.Valid {
			t := r.LastAccessedAt.Time
			row.LastAccessedAt = &t
		}
		items = append(items, row)
	}

	return UserWorkspaceListResult{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *WorkspaceService) toWorkspaceResponse(workspace db.Workspace) WorkspaceResponse {
	environmentSource := strings.TrimSpace(workspace.EnvironmentSource)
	if environmentSource == "" {
		environmentSource = defaultWorkspaceEnvironmentSource
	}
	resp := WorkspaceResponse{
		ID:             workspace.ID,
		RepositoryID:   workspace.RepositoryID,
		UserID:         workspace.UserID,
		Name:           workspace.Name,
		TargetBookmark: targetWorkspaceBookmark(workspace.TargetBookmark),
		Status:         workspace.Status,
		FailureCode:    workspace.FailureCode.String,
		FailureMessage: workspace.FailureMessage.String,
		Kind:           normalizeWorkspaceKind(workspace.Kind),
		Environment: WorkspaceEnvironment{
			Source:      environmentSource,
			Revision:    workspace.EnvironmentRevision,
			ClosureHash: workspace.EnvironmentClosureHash,
			Image:       workspace.EnvironmentImage,
		},
		SourceCommit:       workspace.SourceCommit,
		Head:               WorkspaceHead{ChangeID: workspace.HeadChangeID, CommitID: workspace.HeadCommitID},
		Resources:          workspaceResourcesResponse(workspace),
		Ahead:              workspace.Ahead,
		Behind:             workspace.Behind,
		AgentSessionID:     UUIDString(workspace.AgentSessionID),
		ProvisioningStage:  workspace.ProvisioningStage,
		IsFork:             workspace.IsFork,
		ParentWorkspaceID:  UUIDString(workspace.ParentWorkspaceID),
		VMID:               workspace.VmID,
		Persistence:        string(s.workspacePersistence),
		LSP:                WorkspaceLSP{Languages: LSPLanguages()},
		IdleTimeoutSeconds: workspace.IdleTimeoutSecs,
		LastActivityAt:     workspace.LastActivityAt,
		CreatedAt:          workspace.CreatedAt,
		UpdatedAt:          workspace.UpdatedAt,
	}
	if workspace.ClientLeaseExpiresAt.Valid {
		expires := workspace.ClientLeaseExpiresAt.Time
		resp.ClientLeaseExpiresAt = &expires
	}
	if s.runtime != nil {
		resp.Isolation = s.runtime.Isolation()
	} else if s.sandbox != nil {
		resp.Isolation = workspaceapi.IsolationSandboxed
	}
	if strings.TrimSpace(workspace.VmID) != "" {
		resp.SSHHost = fmt.Sprintf("%s@%s", workspace.VmID, s.sshHost)
	}

	if snapshotID := UUIDString(workspace.SourceSnapshotID); snapshotID != "" {
		resp.SnapshotID = snapshotID
	}
	if workspace.SuspendedAt.Valid {
		suspendedAt := workspace.SuspendedAt.Time
		resp.SuspendedAt = &suspendedAt
	}
	if workspace.StartedAt.Valid {
		startedAt := workspace.StartedAt.Time
		resp.StartedAt = &startedAt
	}
	if workspace.ResumedAt.Valid {
		resumedAt := workspace.ResumedAt.Time
		resp.ResumedAt = &resumedAt
	}
	return resp
}

func normalizeWorkspaceKind(kind string) string {
	switch strings.TrimSpace(kind) {
	case "vm":
		return "vm"
	case "desktop":
		// Preserve the kind of historical rows; all provisioning rejects it.
		return "desktop"
	case "agent":
		// RFD-004: an agent run's computer. Only the control plane creates
		// these; validateWorkspaceCreateMetadata refuses it from callers.
		return "agent"
	default:
		return "container"
	}
}

func validateWorkspaceCreateMetadata(input CreateWorkspaceInput) error {
	kind := strings.TrimSpace(input.Kind)
	if kind != "" && kind != "container" && kind != "vm" {
		return pkgerrors.BadRequest("kind must be container or vm")
	}
	source := strings.TrimSpace(input.Environment.Source)
	if source != "" && source != defaultWorkspaceEnvironmentSource {
		return pkgerrors.BadRequest("environment.source must be .smithers/environment.nix")
	}
	if (strings.TrimSpace(input.Environment.Revision) == "") != (strings.TrimSpace(input.Environment.ClosureHash) == "") {
		return pkgerrors.BadRequest("environment revision and closure_hash must be provided together")
	}
	if input.SourceRef != "" {
		if !repohost.ValidUserRefName(input.SourceRef) {
			return pkgerrors.BadRequest("invalid ref name")
		}
		if strings.TrimSpace(input.SnapshotID) != "" {
			return pkgerrors.BadRequest("source_ref cannot be combined with snapshot_id")
		}
	}
	return validateWorkspaceClientLease(input.ClientLeaseSeconds)
}

func workspaceCreateParamsMetadata(input CreateWorkspaceInput) (string, WorkspaceEnvironment) {
	environment := input.Environment
	environment.Source = strings.TrimSpace(environment.Source)
	if environment.Source == "" {
		environment.Source = defaultWorkspaceEnvironmentSource
	}
	environment.Revision = strings.TrimSpace(environment.Revision)
	environment.ClosureHash = strings.TrimSpace(environment.ClosureHash)
	return normalizeWorkspaceKind(input.Kind), environment
}

type workspaceCreateMetadata struct {
	kind        string
	environment WorkspaceEnvironment
	resources   WorkspaceResources
}

func normalizeWorkspaceCreateMetadata(metadata workspaceCreateMetadata) workspaceCreateMetadata {
	metadata.kind = normalizeWorkspaceKind(metadata.kind)
	metadata.environment.Source = strings.TrimSpace(metadata.environment.Source)
	if metadata.environment.Source == "" {
		metadata.environment.Source = defaultWorkspaceEnvironmentSource
	}
	metadata.environment.Revision = strings.TrimSpace(metadata.environment.Revision)
	metadata.environment.ClosureHash = strings.TrimSpace(metadata.environment.ClosureHash)
	return metadata
}

func toWorkspaceSessionResponse(s db.WorkspaceSession) WorkspaceSessionResponse {
	kind := s.Kind
	if kind == "" {
		kind = WorkspaceSessionKindTerminal
	}
	return WorkspaceSessionResponse{
		ID:              s.ID,
		WorkspaceID:     s.WorkspaceID,
		RepositoryID:    s.RepositoryID,
		UserID:          s.UserID,
		Status:          s.Status,
		Kind:            kind,
		Language:        s.Language,
		Cols:            s.Cols,
		Rows:            s.Rows,
		LastActivityAt:  s.LastActivityAt,
		IdleTimeoutSecs: s.IdleTimeoutSecs,
		CreatedAt:       s.CreatedAt,
		UpdatedAt:       s.UpdatedAt,
	}
}

func toWorkspaceSnapshotResponse(snapshot db.WorkspaceSnapshot) WorkspaceSnapshotResponse {
	return WorkspaceSnapshotResponse{
		ID:           snapshot.ID,
		RepositoryID: snapshot.RepositoryID,
		UserID:       snapshot.UserID,
		Name:         snapshot.Name,
		WorkspaceID:  snapshot.WorkspaceID,
		SnapshotID:   snapshot.SnapshotID,
		CreatedAt:    snapshot.CreatedAt,
		UpdatedAt:    snapshot.UpdatedAt,
	}
}

// UUIDString converts a pgtype.UUID to its string representation.
// Returns an empty string if the UUID is not valid (null).
func UUIDString(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	b := u.Bytes
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// stringToUUID parses a UUID string into a pgtype.UUID.
// Returns an invalid (null) pgtype.UUID if the string is empty or malformed.
func stringToUUID(s string) pgtype.UUID {
	s = strings.TrimSpace(s)
	if s == "" {
		return pgtype.UUID{}
	}
	var u pgtype.UUID
	if err := u.Scan(s); err != nil {
		return pgtype.UUID{}
	}
	return u
}

func WithWorkspaceBillingPolicy(policy BillingPolicy) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.billing = policy }
}

// workspaceVendorLoginPaths are the vendor sign-ins a person makes inside
// their own workspace, relative to a home directory. The platform never holds
// these tokens, so a derived workspace (fork or snapshot restore) must not
// carry them to another principal or to cloned siblings that would race one
// rotating refresh token (#2805). Children reach a model through the parent's
// seat, never a copied login.
var workspaceVendorLoginPaths = []string{
	".claude/.credentials.json",
	".claude.json",
	".claude.json.backup",
	".codex/auth.json",
	".config/anthropic",
}

// workspaceSandboxLoginHomes are the homes a Microsandbox guest signs in from:
// the workspace user's and root's.
var workspaceSandboxLoginHomes = []string{defaultWorkspaceHome, "/root"}

// workspaceLoginScrubScript removes every vendor login under each home given
// as a positional argument ($HOME when none is given) and fails unless each
// one is gone afterwards. A missing or unwritable home holds nothing this
// user could have signed in to and is skipped.
func workspaceLoginScrubScript() string {
	var b strings.Builder
	b.WriteString("set -u\n[ \"$#\" -gt 0 ] || set -- \"$HOME\"\n")
	b.WriteString("for home in \"$@\"; do\n")
	b.WriteString("  { [ -d \"$home\" ] && [ -w \"$home\" ]; } || continue\n")
	b.WriteString("  for rel in")
	for _, rel := range workspaceVendorLoginPaths {
		b.WriteByte(' ')
		b.WriteString(shellQuote(rel))
	}
	b.WriteString("; do\n")
	b.WriteString("    rm -rf -- \"$home/$rel\"\n")
	b.WriteString("    if [ -e \"$home/$rel\" ] || [ -L \"$home/$rel\" ]; then echo \"vendor login remains: $home/$rel\" >&2; exit 1; fi\n")
	b.WriteString("  done\ndone\n")
	return b.String()
}

// workspaceSandboxLoginScrubCommand is the Microsandbox exec form of the scrub.
func workspaceSandboxLoginScrubCommand() string {
	command := "/bin/sh -c " + shellQuote(workspaceLoginScrubScript()) + " smithers-login-scrub"
	for _, home := range workspaceSandboxLoginHomes {
		command += " " + shellQuote(home)
	}
	return command
}

// scrubSandboxWorkspaceLogins signs a freshly forked or restored Microsandbox
// guest out of every vendor login before anyone can use it. Callers discard
// the guest when it fails: a derived workspace is never handed out signed in.
func (s *WorkspaceService) scrubSandboxWorkspaceLogins(ctx context.Context, vmID string) error {
	execClient, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return pkgerrors.Internal("sandbox exec client unavailable to sign out derived workspace")
	}
	timeoutMS := int64(30_000)
	execCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	result, err := execClient.Execute(execCtx, vmID, sandbox.ExecRequest{Command: workspaceSandboxLoginScrubCommand(), TimeoutMS: &timeoutMS})
	if err != nil {
		return pkgerrors.Internal("sign out derived workspace: " + err.Error())
	}
	if !successfulExecStatus(result) {
		return pkgerrors.Internal("sign out derived workspace failed: " + strings.TrimSpace(result.Stderr))
	}
	return nil
}

// scrubRuntimeWorkspaceLogins is the workspace-runtime form of the scrub; it
// runs as the runtime's workspace user, whose $HOME holds its logins.
func (s *WorkspaceService) scrubRuntimeWorkspaceLogins(ctx context.Context, row db.Workspace, requesterID int64) error {
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "sign-out-logins"))
	if err != nil {
		return err
	}
	execCtx, cancel := context.WithTimeout(operationCtx, time.Minute)
	defer cancel()
	result, err := s.runtime.ExecuteCommand(execCtx, row.ID, workspaceapi.Command{
		Args: []string{"/bin/sh", "-c", workspaceLoginScrubScript()},
	})
	if err != nil {
		return runtimeOperationError("sign out derived workspace", err)
	}
	if result.ExitCode != 0 {
		return pkgerrors.Internal(fmt.Sprintf("sign out derived workspace failed with status %d: %s", result.ExitCode, strings.TrimSpace(result.Stderr)))
	}
	return nil
}

// WithWorkspaceAuditService records system workspace actions, such as
// sandbox-hours suspensions, in the audit log.
func WithWorkspaceAuditService(audit *AuditService) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.audit = audit }
}
