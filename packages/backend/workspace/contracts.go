// Package workspace defines the shared execution and workspace lifecycle.
// Product authorization, admission, and durable receipts stay above this boundary.
package workspace

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"time"
)

// IsolationLevel is the guarantee of an execution adapter, not an edition
// label. A trusted process must never be presented as an untrusted sandbox.
type IsolationLevel string

const (
	IsolationTrustedProcess IsolationLevel = "trusted_process"
	IsolationSandboxed      IsolationLevel = "isolated"
)

// Terminal is an interactive byte stream scoped to an authorized workspace.
// The common app authenticates and authorizes before opening it.
type Terminal interface {
	io.ReadWriteCloser
	Resize(ctx context.Context, columns, rows uint16) error
}

// ErrWorkspaceNotFound is returned when an execution adapter has no durable
// workspace with the requested product-owned identifier, or confirms its
// runtime is permanently gone. On inspection, join it with a typed host_lease_lost
// error when the assigned worker is retired; lease expiry alone must not carry it.
// Product code may retain the old row for recovery and allocate a fresh workspace.
var ErrWorkspaceNotFound = errors.New("workspace not found")

// ErrWorkspaceStopped is returned when an operation needs a running workspace.
var ErrWorkspaceStopped = errors.New("workspace is stopped")

// ErrCommandCancelled certifies that an interrupted command has stopped.
// Runtime adapters join it with the context error only after termination is
// confirmed. A cancelled transport alone must never return this marker.
var ErrCommandCancelled = errors.New("command cancellation confirmed")

// ErrCommandTerminationUnconfirmed means cancellation could not prove that
// the guest command stopped. A caller must not acknowledge cancellation.
var ErrCommandTerminationUnconfirmed = errors.New("command termination could not be confirmed")

// ErrManagedHostNotRunning means no live managed process owns the requested
// host binding. Callers may start that binding after their common product lock
// and owner-generation fence are held.
var ErrManagedHostNotRunning = errors.New("managed host is not running")

// ErrManagedHostIdentityConflict means a live process answered with identity
// other than the exact protocol, artifact, source revision, and owner
// generation expected by common product state. It must never be replaced
// opportunistically while it is still live.
var ErrManagedHostIdentityConflict = errors.New("managed host identity conflict")

// ErrWorkspaceSourceUnavailable means the runtime workspace does not expose a
// supported immutable repository snapshot. Callers must not substitute a
// package build revision or fabricate a source identity.
var ErrWorkspaceSourceUnavailable = errors.New("workspace source revision is unavailable")

// WorkspaceState is the execution lifecycle observed by product code. A
// stopped persistent workspace keeps its files but owns no live processes.
type WorkspaceState string

const (
	WorkspaceStarting         WorkspaceState = "starting"
	WorkspaceRunning          WorkspaceState = "running"
	WorkspaceStopping         WorkspaceState = "stopping"
	WorkspaceStopped          WorkspaceState = "stopped"
	WorkspaceFailed           WorkspaceState = "failed"
	WorkspaceRecoveryRequired WorkspaceState = "recovery_required"
)

// WorkspaceCapabilities are facts an adapter has actually implemented. In
// particular, ColdSnapshots must remain false for a process adapter that only
// persists the workspace directory.
type WorkspaceCapabilities struct {
	PersistentFiles  bool
	Execution        bool
	ManagedServices  bool
	ManagedHTTPHosts bool
	SourceRevision   bool
	Terminal         bool
	LoopbackPreview  bool
	FileOperations   bool
	ColdSnapshots    bool
}

// WorkspaceSpec carries only durable execution identity. Authentication,
// admission, repository ownership, and receipts remain common product policy.
type WorkspaceSpec struct {
	ID string
	// Source names the repository revision the product will check out, when
	// it knows it. An isolated adapter uses it only to choose a prepared
	// environment; it confers no repository authority.
	Source *WorkspaceSource
}

// WorkspaceSource is an owner/name repository slug and the revision the
// product checks out: a commit id or a bookmark the runtime resolves once.
type WorkspaceSource struct {
	Repository string
	Revision   string
}

// SourceFiles reads repository files at an immutable revision for a runtime
// that keys prepared environments by their declared inputs. It is backend
// data access, never execution of repository code. A missing file returns an
// error wrapping fs.ErrNotExist.
type SourceFiles interface {
	ResolveSourceRevision(ctx context.Context, repository, revision string) (string, error)
	ReadSourceFile(ctx context.Context, source WorkspaceSource, path string) ([]byte, error)
}

// SourceFilesBinder is implemented by a runtime composed before the product
// repository client exists; the composition binds it once at startup.
type SourceFilesBinder interface {
	BindSourceFiles(SourceFiles)
}

// WorkspaceConversationEgress is a facet the product requires before
// outsider-started work runs in a workspace (a run started from an
// outsider's approved text works from that copy, never the live issue). From
// the call on, the runtime runs the workspace's egress with
// sandbox.ConversationWithheldHostRules: on its running box at once and on
// every later create or start. It may be called before the workspace exists
// and is idempotent.
type WorkspaceConversationEgress interface {
	WithholdConversationEgress(ctx context.Context, workspaceID string) error
}

// WorkspaceDiskReclaimer is an optional facet. ReclaimWorkspaceDisk removes a
// stopped workspace's machine and disk but keeps the workspace: it stays
// stopped, and the next StartWorkspace boots a fresh machine from its
// environment with an empty root, which the product refills from the
// repository. It refuses a workspace that is not stopped and is idempotent.
type WorkspaceDiskReclaimer interface {
	ReclaimWorkspaceDisk(ctx context.Context, workspaceID string) error
}

// WorkspaceEnvironmentLinker is an optional facet. After the product
// checkout, it finishes the workspace's prepared environment offline, for
// example by linking dependencies from a prepared store.
type WorkspaceEnvironmentLinker interface {
	LinkWorkspaceEnvironment(ctx context.Context, workspaceID string) error
}

// Workspace describes paths in the execution environment's namespace. Root is
// where repository material is placed. Home, StateDir, and TempDir stay
// outside that working tree. Callers use WorkspaceFiles rather than assuming
// these paths are visible in the backend process; they are host paths for the
// process adapter and guest paths for an isolated remote adapter.
type Workspace struct {
	ID       string
	Root     string
	Home     string
	StateDir string
	TempDir  string
	State    WorkspaceState
}

// ColdSnapshot is disk state captured from a stopped workspace. It carries no
// claim about preserving process memory.
type ColdSnapshot struct {
	ID                string
	SourceWorkspaceID string
}

type ColdSnapshotSpec struct {
	ID string
}

// WorkspaceSnapshots is an optional capability. A runtime advertising
// ColdSnapshots implements it; the local process runtime deliberately does
// neither, so unsupported snapshot operations cannot report fake success.
type WorkspaceSnapshots interface {
	CreateColdSnapshot(ctx context.Context, workspaceID string, spec ColdSnapshotSpec) (ColdSnapshot, error)
	ForkColdSnapshot(ctx context.Context, snapshotID string, spec WorkspaceSpec) (Workspace, error)
	DeleteColdSnapshot(ctx context.Context, snapshotID string) error
}

// Command is an argv-based process request. Directory is relative to the
// workspace root. Environment augments the adapter's controlled environment
// for this operation and is never durable workspace metadata.
type Command struct {
	Args        []string
	Directory   string
	Environment map[string]string
}

// CommandResult is direct process evidence. Product code remains responsible
// for committing the durable completion receipt.
type CommandResult struct {
	ExitCode        int
	Stdout          string
	Stderr          string
	OutputTruncated bool
}

// ServiceSpec describes one adapter-managed long-lived process. ReadyAddress,
// when set, must be a loopback host:port in the workspace's network namespace
// that accepts TCP connections before StartService returns.
type ServiceSpec struct {
	Name string
	// Identity is a caller-computed, secret-free configuration digest used to
	// deduplicate retries when an adapter-assigned address changes the argv.
	Identity     string
	Command      Command
	ReadyAddress string
	ReadyTimeout time.Duration
}

// Service is an observation of a process accepted by the adapter.
type Service struct {
	Name    string
	PID     int
	Address string
}

type ServiceState string

const (
	ServiceRunning ServiceState = "running"
	ServiceExited  ServiceState = "exited"
	ServiceStopped ServiceState = "stopped"
	ServiceFailed  ServiceState = "failed"
)

// ServiceObservation exposes bounded process evidence for diagnostics. It is
// not a workflow completion receipt.
type ServiceObservation struct {
	Service
	State           ServiceState
	ExitCode        int
	Stdout          string
	Stderr          string
	OutputTruncated bool
}

// PreviewTarget is an internal upstream for the common authenticated proxy.
// It is never evidence that the process is isolated from its host.
type PreviewTarget struct {
	URL string
}

// FileEntry describes one direct child of a workspace directory.
type FileEntry struct {
	Name  string
	Mode  fs.FileMode
	Size  int64
	IsDir bool
}

// WorkspaceLifecycle owns durable files and live execution state.
type WorkspaceLifecycle interface {
	Isolation() IsolationLevel
	Capabilities() WorkspaceCapabilities
	CreateWorkspace(ctx context.Context, spec WorkspaceSpec) (Workspace, error)
	InspectWorkspace(ctx context.Context, workspaceID string) (Workspace, error)
	StartWorkspace(ctx context.Context, workspaceID string) (Workspace, error)
	StopWorkspace(ctx context.Context, workspaceID string) error
	DeleteWorkspace(ctx context.Context, workspaceID string) error
}

// WorkspaceExecution runs admitted work and manages long-lived helpers.
type WorkspaceExecution interface {
	ExecuteCommand(ctx context.Context, workspaceID string, command Command) (CommandResult, error)
	StartService(ctx context.Context, workspaceID string, spec ServiceSpec) (Service, error)
	InspectService(ctx context.Context, workspaceID, name string) (ServiceObservation, error)
	StopService(ctx context.Context, workspaceID, name string) error
}

// WorkspaceServiceCatalog is optional because not every execution backend can
// enumerate its init system. A runtime advertising ManagedServices implements
// it so the common product service can list real observations.
type WorkspaceServiceCatalog interface {
	ListServices(ctx context.Context, workspaceID string) ([]ServiceObservation, error)
}

// WorkspaceNamedServiceController preserves deployment-defined service
// semantics such as systemd units without exposing an init-system model to the
// common product service.
type WorkspaceNamedServiceController interface {
	ManageService(ctx context.Context, workspaceID, name, action string) (ServiceObservation, error)
}

// ManagedHostIdentity is immutable readiness evidence returned by the
// canonical Flow runtime protocol. SourceRevision is repository-specific;
// adapters compare these values exactly and never infer them from a process or
// listening socket.
type ManagedHostIdentity struct {
	Protocol        string
	ArtifactDigest  string
	SourceRevision  string
	OwnerGeneration int64
}

// ManagedHostConnection is a private control-plane connection. Trusted local
// execution uses a loopback endpoint and nil HTTPClient. An isolated adapter
// supplies a client whose transport opens a placement-fenced workspace port;
// neither form is a public preview URL.
type ManagedHostConnection struct {
	Endpoint   string
	HTTPClient *http.Client
}

// ManagedHostPlacement contains paths and an address chosen by the adapter in
// the workspace's own namespace. StateDir is stable for Spec.ID across owner
// generations. A command builder must use these values rather than choosing a
// fixed port or a backend-host path.
type ManagedHostPlacement struct {
	Workspace Workspace
	StateDir  string
	Host      string
	Port      uint16
	Address   string
}

// ManagedHostBuilder materializes a canonical coding host command
// after the execution adapter allocates the address.
type ManagedHostBuilder interface {
	BuildManagedHost(context.Context, ManagedHostPlacement) (Command, error)
}

type ManagedHostBuilderFunc func(context.Context, ManagedHostPlacement) (Command, error)

func (build ManagedHostBuilderFunc) BuildManagedHost(ctx context.Context, placement ManagedHostPlacement) (Command, error) {
	return build(ctx, placement)
}

// ManagedHostProbe authenticates to the canonical host and decodes its
// protocol identity. The execution adapter performs the exact comparison with
// ManagedHostSpec.Expected before returning a connection.
type ManagedHostProbe interface {
	ProbeManagedHost(context.Context, ManagedHostConnection) (ManagedHostIdentity, error)
}

type ManagedHostProbeFunc func(context.Context, ManagedHostConnection) (ManagedHostIdentity, error)

func (probe ManagedHostProbeFunc) ProbeManagedHost(ctx context.Context, connection ManagedHostConnection) (ManagedHostIdentity, error) {
	return probe(ctx, connection)
}

// ManagedHostSpec is an in-process launch request assembled from durable,
// server-resolved product binding and catalog state. ID remains stable for the
// binding; Identity is a secret-free digest of the exact service command
// inputs and changes when its immutable owner identity changes.
type ManagedHostSpec struct {
	ID           string
	Name         string
	Identity     string
	Expected     ManagedHostIdentity
	ReadyTimeout time.Duration
	Builder      ManagedHostBuilder
	Probe        ManagedHostProbe
}

// WorkspaceManagedHosts is an optional runtime facet layered over the same
// WorkspaceExecution service lifecycle. Product authorization, durable
// bindings, cross-replica locking, bearer protection, and Flow receipts remain
// common. Stop and workspace teardown continue through WorkspaceExecution and
// WorkspaceLifecycle rather than a second host service model.
type WorkspaceManagedHosts interface {
	InspectManagedHost(ctx context.Context, workspaceID string, spec ManagedHostSpec) (ManagedHostConnection, error)
	StartManagedHost(ctx context.Context, workspaceID string, spec ManagedHostSpec) (ManagedHostConnection, error)
}

// WorkspaceSourceRevisionResolver resolves the repository snapshot actually
// mounted in a running workspace. Jujutsu workspaces resolve their immutable
// working-copy commit; Git workspaces resolve HEAD only when the worktree is
// clean. Implementations return exactly 40 lowercase hexadecimal characters.
type WorkspaceSourceRevisionResolver interface {
	ResolveWorkspaceSourceRevision(ctx context.Context, workspaceID string) (string, error)
}

// WorkspaceTerminal opens a real PTY after common authorization succeeds.
type WorkspaceTerminal interface {
	OpenWorkspaceTerminal(ctx context.Context, workspaceID string, command Command) (Terminal, error)
}

// WorkspacePreview resolves an authorized workspace port to a local upstream.
type WorkspacePreview interface {
	PreviewTarget(ctx context.Context, workspaceID string, port uint16) (PreviewTarget, error)
}

// WorkspaceFiles provides path-scoped file operations. Implementations must
// preserve exact names, including leading and trailing whitespace, and reject
// traversal and parent symlink escapes from the workspace root.
type WorkspaceFiles interface {
	// ReadFile rejects symlink escapes and returns an error matching
	// fs.ErrNotExist via errors.Is when the path is missing.
	ReadFile(ctx context.Context, workspaceID, path string) ([]byte, error)
	// WriteFile must not modify a symlink target outside the workspace root.
	WriteFile(ctx context.Context, workspaceID, path string, content []byte, mode fs.FileMode) error
	ListFiles(ctx context.Context, workspaceID, path string) ([]FileEntry, error)
	// RemoveFile unlinks a final symlink without following its target, including
	// outside, dangling, and directory links, and recursively removes directories.
	// A missing path returns an error matching fs.ErrNotExist via errors.Is.
	RemoveFile(ctx context.Context, workspaceID, path string) error
}

// WorkspaceRuntime is the common execution contract. Deployments may expose
// narrower facets to services that do not need every operation. Optional
// capabilities such as WorkspaceSnapshots remain separate interfaces.
type WorkspaceRuntime interface {
	WorkspaceLifecycle
	WorkspaceExecution
	WorkspaceTerminal
	WorkspacePreview
	WorkspaceFiles
	io.Closer
}
