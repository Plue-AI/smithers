// Package microsandbox runs every workspace in a local Microsandbox microVM.
//
// It implements the common workspace contract (packages/backend/workspace)
// over the pinned `msb` CLI. Nothing a workspace runs executes on the host:
// commands, services, managed Flow hosts, terminals, previews and file
// operations all go through `msb exec` into the workspace's own VM. When
// Microsandbox is missing or unqualified the runtime refuses to start, and a
// VM that cannot be reached fails the operation; there is no process fallback.
//
// Machines carry the same ownership labels as @smthrs/sandbox's
// MicrosandboxSandbox (smithers.provider, smithers.owner, smithers.holder), so
// one installation never reaps or prunes another's machines or snapshots.
package microsandbox

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/egressrelay"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const (
	metadataVersion = 1

	providerLabel  = "smithers.provider"
	providerName   = "microsandbox"
	ownerLabel     = "smithers.owner"
	holderLabel    = "smithers.holder"
	workspaceLabel = "smithers.workspace"
	layerLabel     = "smithers.layer"

	guestRoot     = "/workspace"
	guestHome     = "/home/agent"
	guestStateDir = "/var/lib/smithers/state"
	guestTempDir  = "/var/tmp/smithers"
	guestUser     = "agent"
	guestUID      = 1500
)

// DefaultImage is the L0 image: node:26.5.0-trixie (Debian 13, glibc 2.41,
// linux/arm64) pinned by digest. Trixie, not bookworm: the app's build stage
// (distribution/Dockerfile) uses it, and the Hutch devkit needs glibc 2.38.
const DefaultImage = "node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b"

// Config selects the msb binary, the data root holding adapter metadata, the
// VM shape, and the backend ports a guest may reach through its bridge.
type Config struct {
	// CodingHelper is the packaged Linux arm64 source-publication helper.
	// The binding installer plants its verified bytes at the fixed guest path.
	CodingHelper string
	// Binary is the absolute path of the pinned msb executable.
	Binary string
	// Root holds adapter metadata. It is host state, never a guest mount.
	Root string
	// Image is the OCI image a workspace boots when no environment layer
	// applies. Default DefaultImage.
	Image string
	// CPUs, MemoryMiB and DiskMiB shape each workspace VM.
	CPUs      int
	MemoryMiB int
	DiskMiB   int
	// HostPorts are host loopback ports (the backend's own listener) that a
	// guest reaches at 127.0.0.1:<port> through the adapter's bridge. Every
	// other destination is denied.
	HostPorts []uint16
	// Environment augments every command's controlled environment.
	Environment map[string]string
	// MaxConcurrent caps concurrent one-shot commands across all workspaces.
	MaxConcurrent int
	// MaxRunningVMs caps simultaneously running workspace VMs.
	MaxRunningVMs int
	// OutputLimit bounds captured stdout and stderr per stream.
	OutputLimit int
	// FileReadLimit bounds ReadFile.
	FileReadLimit int64
	// CommandTimeout is the runaway guard for one command (default 60 min).
	CommandTimeout time.Duration
	// Environments enables graph-keyed environment layers. Nil boots Image.
	Environments *EnvironmentConfig
	// Artifacts maps host directories to guest paths. A managed host command
	// whose argv[0] lies under one is copied into the guest, digest-checked,
	// and rewritten to the guest path.
	Artifacts map[string]string
	// EgressRelay, when set, is the egress secret channel
	// (workspace.WorkspaceEgressSecrets). Its port joins HostPorts, so it
	// must stay the same across restarts for existing machines to reach it.
	EgressRelay *egressrelay.Relay
	// SkipQualification is for unit tests with a fake msb only.
	SkipQualification bool
}

// Layer is the environment a workspace VM boots from.
type Layer struct {
	// Snapshot is the Microsandbox snapshot name; empty boots the image.
	Snapshot string
	// Key is the content digest of the layer's graph node.
	Key string
	// Link is the offline command run after the product checkout.
	Link []string
}

type metadata struct {
	Version   int      `json:"version"`
	ID        string   `json:"id"`
	Machine   string   `json:"machine"`
	State     string   `json:"state"`
	Snapshot  string   `json:"snapshot,omitempty"`
	LayerKey  string   `json:"layerKey,omitempty"`
	Link      []string `json:"link,omitempty"`
	CreatedAt string   `json:"createdAt"`
	// Reclaimed marks a stopped workspace whose machine and disk were
	// removed; its next start boots a fresh machine (see ReclaimWorkspaceDisk).
	Reclaimed bool `json:"reclaimed,omitempty"`
	// RelayPort is the egress relay port the machine was built to reach.
	RelayPort uint16 `json:"relayPort,omitempty"`
}

type workspace struct {
	metadata
	directory string
	commands  map[string]*guestCommand
	services  map[string]*managedService
	previews  map[uint16]*previewListener
	guestOK   bool
}

// Runtime owns every microVM it creates and the metadata that names them.
type Runtime struct {
	cli       *cli
	config    Config
	root      string
	owner     string
	holder    string
	semaphore chan struct{}

	environments *environments
	codingHelper codingHelperCache

	mu         sync.Mutex
	closed     bool
	workspaces map[string]*workspace
}

// New qualifies Microsandbox, loads persisted workspaces, reaps this
// installation's orphaned machines, and cleans command processes a previous
// backend process left in running guests.
func New(ctx context.Context, config Config) (*Runtime, error) {
	client, err := newCLI(config.Binary)
	if err != nil {
		return nil, err
	}
	if !config.SkipQualification {
		qualifyCtx, cancel := context.WithTimeout(ctx, time.Minute)
		err = client.qualify(qualifyCtx)
		cancel()
		if err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(config.Root) == "" {
		return nil, errors.New("microsandbox workspace root is required")
	}
	root, err := filepath.Abs(config.Root)
	if err != nil {
		return nil, err
	}
	applyDefaults(&config)
	if err := withRelayRoute(&config); err != nil {
		return nil, err
	}
	for _, dir := range []string{root, filepath.Join(root, "workspaces"), filepath.Join(root, "snapshots"), filepath.Join(root, "layers")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("create microsandbox state: %w", err)
		}
	}
	owner, err := installationOwner(root)
	if err != nil {
		return nil, err
	}
	holderToken := make([]byte, 6)
	if _, err := rand.Read(holderToken); err != nil {
		return nil, err
	}
	runtime := &Runtime{
		cli: client, config: config, root: root, owner: owner,
		holder:     fmt.Sprintf("backend-%d-%s", os.Getpid(), hex.EncodeToString(holderToken)),
		semaphore:  make(chan struct{}, config.MaxConcurrent),
		workspaces: make(map[string]*workspace),
	}
	if config.Environments != nil {
		environmentConfig := *config.Environments
		environmentConfig.defaults()
		runtime.environments = &environments{runtime: runtime, config: environmentConfig, verified: map[string]bool{}}
		if runtime.config.Image == "" || config.Environments.Image != "" {
			runtime.config.Image = environmentConfig.Image
		}
	}
	if err := runtime.load(); err != nil {
		return nil, err
	}
	recoverCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := runtime.recover(recoverCtx); err != nil {
		return nil, err
	}
	return runtime, nil
}

func applyDefaults(config *Config) {
	if config.Image == "" {
		config.Image = DefaultImage
	}
	if config.CPUs <= 0 {
		config.CPUs = 4
	}
	if config.MemoryMiB <= 0 {
		config.MemoryMiB = 8192
	}
	if config.DiskMiB <= 0 {
		config.DiskMiB = 32768
	}
	if config.MaxConcurrent <= 0 {
		config.MaxConcurrent = 32
	}
	if config.MaxRunningVMs <= 0 {
		config.MaxRunningVMs = 3
	}
	if config.OutputLimit <= 0 {
		config.OutputLimit = 4 << 20
	}
	if config.FileReadLimit <= 0 {
		config.FileReadLimit = 16 << 20
	}
	if config.CommandTimeout <= 0 {
		config.CommandTimeout = 60 * time.Minute
	}
}

// installationOwner is this installation's durable owner label. Every machine
// and snapshot it creates carries it; nothing without it is ever touched.
func installationOwner(root string) (string, error) {
	path := filepath.Join(root, "owner")
	contents, err := os.ReadFile(path)
	if err == nil {
		owner := strings.TrimSpace(string(contents))
		if strings.HasPrefix(owner, "smithers-backend-") && len(owner) == len("smithers-backend-")+16 {
			return owner, nil
		}
		return "", errors.New("microsandbox owner file is invalid")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	token := make([]byte, 8)
	if _, err := rand.Read(token); err != nil {
		return "", err
	}
	owner := "smithers-backend-" + hex.EncodeToString(token)
	if err := os.WriteFile(path, []byte(owner+"\n"), 0o600); err != nil {
		return "", err
	}
	return owner, nil
}

// Owner is the installation's ownership label value.
func (r *Runtime) Owner() string { return r.owner }

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func (r *Runtime) machineName(workspaceID string) string {
	return "smthrs-ws-" + strings.TrimPrefix(r.owner, "smithers-backend-")[:8] + "-" + digest(workspaceID)[:20]
}

func (r *Runtime) ownership(workspaceID string) map[string]string {
	labels := map[string]string{providerLabel: providerName, ownerLabel: r.owner, holderLabel: r.holder}
	if workspaceID != "" {
		labels[workspaceLabel] = digest(workspaceID)[:20]
	}
	return labels
}

func (r *Runtime) load() error {
	entries, err := os.ReadDir(filepath.Join(r.root, "workspaces"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		directory := filepath.Join(r.root, "workspaces", entry.Name())
		contents, err := os.ReadFile(filepath.Join(directory, "metadata.json"))
		if errors.Is(err, fs.ErrNotExist) {
			// A create that crashed before its metadata commit owns no machine.
			_ = os.RemoveAll(directory)
			continue
		}
		if err != nil {
			return fmt.Errorf("read microsandbox workspace metadata: %w", err)
		}
		var stored metadata
		if err := json.Unmarshal(contents, &stored); err != nil || stored.Version != metadataVersion || stored.ID == "" || digest(stored.ID) != entry.Name() {
			return fmt.Errorf("invalid microsandbox workspace metadata %s", entry.Name())
		}
		r.workspaces[stored.ID] = newWorkspace(stored, directory)
	}
	return nil
}

func newWorkspace(stored metadata, directory string) *workspace {
	return &workspace{metadata: stored, directory: directory, commands: map[string]*guestCommand{},
		services: map[string]*managedService{}, previews: map[uint16]*previewListener{}}
}

func writeMetadata(ws *workspace) error {
	contents, err := json.MarshalIndent(ws.metadata, "", "  ")
	if err != nil {
		return err
	}
	temporary := filepath.Join(ws.directory, ".metadata.json.tmp")
	if err := os.WriteFile(temporary, append(contents, '\n'), 0o600); err != nil {
		return fmt.Errorf("write microsandbox metadata: %w", err)
	}
	return os.Rename(temporary, filepath.Join(ws.directory, "metadata.json"))
}

// recover reconciles metadata with Microsandbox after a restart. A previous
// backend's exec clients and guest command groups are killed: live processes
// are never inferred across a restart, and common reconciliation restarts the
// services it needs. Owned machines without metadata are reaped.
func (r *Runtime) recover(ctx context.Context) error {
	killOrphanClients(r.cli.binary, "smthrs-ws-"+strings.TrimPrefix(r.owner, "smithers-backend-")[:8]+"-")
	records, err := r.cli.listSandboxes(ctx, map[string]string{providerLabel: providerName, ownerLabel: r.owner})
	if err != nil {
		return fmt.Errorf("%w: list owned microVMs: %v", ErrUnavailable, err)
	}
	known := map[string]*workspace{}
	for _, ws := range r.workspaces {
		known[ws.Machine] = ws
	}
	var errs []error
	present := map[string]string{}
	for _, record := range records {
		ws := known[record.Name]
		if ws == nil {
			if err := r.removeMachine(ctx, record.Name); err != nil {
				errs = append(errs, fmt.Errorf("reap orphaned microVM %s: %w", record.Name, err))
			}
			continue
		}
		present[record.Name] = strings.ToLower(record.Status)
	}
	for _, ws := range r.workspaces {
		status, ok := present[ws.Machine]
		switch {
		case !ok && ws.Reclaimed:
			// A reclaimed workspace owns no machine by design.
			ws.State = string(workspaceapi.WorkspaceStopped)
		case !ok && ws.State == string(workspaceapi.WorkspaceStarting):
			// Creation never reached Microsandbox; the metadata owns nothing.
			_ = os.RemoveAll(ws.directory)
			delete(r.workspaces, ws.ID)
			continue
		case !ok:
			ws.State = string(workspaceapi.WorkspaceRecoveryRequired)
		case status == "running":
			if _, err := r.guest(ctx, ws.Machine, nil, "kill-all"); err != nil {
				errs = append(errs, fmt.Errorf("clean previous command groups in %s: %w", ws.Machine, err))
			}
			ws.State = string(workspaceapi.WorkspaceStopped)
			// A stopped state makes common reconciliation call StartWorkspace,
			// which restarts the host bridge before anything runs.
			if err := r.stopMachine(ctx, ws.Machine); err != nil {
				errs = append(errs, err)
			}
		default:
			ws.State = string(workspaceapi.WorkspaceStopped)
		}
		if err := writeMetadata(ws); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (r *Runtime) Isolation() workspaceapi.IsolationLevel { return workspaceapi.IsolationSandboxed }

func (r *Runtime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{
		PersistentFiles: true, Execution: true, ManagedServices: true, ManagedHTTPHosts: true,
		SourceRevision: true, Terminal: true, LoopbackPreview: true, FileOperations: true, ColdSnapshots: true,
		EgressSecrets: r.config.EgressRelay != nil,
	}
}

// WorkspaceIsolation reports what this adapter actually enforces.
func (r *Runtime) WorkspaceIsolation(ctx context.Context, workspaceID string) (workspaceapi.IsolationGuarantees, error) {
	if _, err := r.InspectWorkspace(ctx, workspaceID); err != nil {
		return workspaceapi.IsolationGuarantees{}, err
	}
	return workspaceapi.IsolationGuarantees{
		Level: workspaceapi.IsolationSandboxed, Boundary: "microvm",
		DedicatedTenantFilesystem: true, DedicatedTenantNetwork: true, DefaultDenyEgress: true,
		NonPersistentCredentials: true, RuntimeVersion: "microsandbox " + RequiredVersion,
	}, nil
}

// WithholdConversationEgress holds by construction: a workspace VM reaches
// only the backend's own host ports, never GitHub.
func (r *Runtime) WithholdConversationEgress(context.Context, string) error { return nil }

var _ workspaceapi.WorkspaceConversationEgress = (*Runtime)(nil)

func describe(ws *workspace) workspaceapi.Workspace {
	return workspaceapi.Workspace{ID: ws.ID, Root: guestRoot, Home: guestHome, StateDir: guestStateDir, TempDir: guestTempDir,
		State: workspaceapi.WorkspaceState(ws.State)}
}

// WorkspaceIDs lists every workspace this runtime owns.
func (r *Runtime) WorkspaceIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.workspaces))
	for id := range r.workspaces {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func validWorkspaceID(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 512 || strings.IndexByte(id, 0) >= 0 {
		return "", errors.New("workspace id is required")
	}
	return id, nil
}

// CreateWorkspace boots the workspace VM from its environment layer (or the
// base image), prepares the guest, and records durable metadata first so a
// crash mid-create is reconciled rather than leaked.
func (r *Runtime) CreateWorkspace(ctx context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	if existing, err := r.InspectWorkspace(ctx, spec.ID); err == nil {
		return existing, nil
	}
	if r.environments != nil {
		if err := r.environments.admit(ctx); err != nil {
			return workspaceapi.Workspace{}, err
		}
	}
	layer, release, err := r.resolveWorkspaceLayerForCreate(ctx, spec)
	defer release()
	if err != nil {
		return workspaceapi.Workspace{}, fmt.Errorf("resolve workspace environment: %w", err)
	}
	return r.createFrom(ctx, spec, layer)
}

func (r *Runtime) createFrom(ctx context.Context, spec workspaceapi.WorkspaceSpec, layer Layer) (workspaceapi.Workspace, error) {
	id, err := validWorkspaceID(spec.ID)
	if err != nil {
		return workspaceapi.Workspace{}, err
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return workspaceapi.Workspace{}, errors.New("microsandbox runtime is closed")
	}
	if existing := r.workspaces[id]; existing != nil {
		r.mu.Unlock()
		return describe(existing), nil
	}
	if err := r.admitRunningLocked(); err != nil {
		r.mu.Unlock()
		return workspaceapi.Workspace{}, err
	}
	directory := filepath.Join(r.root, "workspaces", digest(id))
	if err := os.Mkdir(directory, 0o700); err != nil {
		r.mu.Unlock()
		return workspaceapi.Workspace{}, fmt.Errorf("create microsandbox workspace state: %w", err)
	}
	ws := newWorkspace(metadata{Version: metadataVersion, ID: id, Machine: r.machineName(id),
		State: string(workspaceapi.WorkspaceStarting), Snapshot: layer.Snapshot, LayerKey: layer.Key, Link: layer.Link,
		CreatedAt: time.Now().UTC().Format(time.RFC3339)}, directory)
	r.workspaces[id] = ws
	r.mu.Unlock()

	if err := writeMetadata(ws); err != nil {
		r.forget(ws)
		return workspaceapi.Workspace{}, err
	}
	if err := r.createMachine(ctx, ws); err != nil {
		_ = r.removeMachine(context.Background(), ws.Machine)
		r.forget(ws)
		return workspaceapi.Workspace{}, err
	}
	r.mu.Lock()
	ws.State = string(workspaceapi.WorkspaceRunning)
	err = writeMetadata(ws)
	described := describe(ws)
	r.mu.Unlock()
	if err != nil {
		return workspaceapi.Workspace{}, err
	}
	return described, nil
}

func (r *Runtime) forget(ws *workspace) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.workspaces[ws.ID] == ws {
		delete(r.workspaces, ws.ID)
	}
	_ = os.RemoveAll(ws.directory)
}

// admitRunningLocked refuses to boot beyond the running-VM cap rather than
// overcommitting the host.
func (r *Runtime) admitRunningLocked() error {
	running := 0
	for _, ws := range r.workspaces {
		if ws.State == string(workspaceapi.WorkspaceRunning) || ws.State == string(workspaceapi.WorkspaceStarting) {
			running++
		}
	}
	if running >= r.config.MaxRunningVMs {
		return fmt.Errorf("microVM capacity reached: %d of %d workspace VMs are running; stop one first", running, r.config.MaxRunningVMs)
	}
	return nil
}

func (r *Runtime) machineFlags(workspaceID string) []string {
	args := []string{"-n", r.machineName(workspaceID), "-c", strconv.Itoa(r.config.CPUs), "-m", strconv.Itoa(r.config.MemoryMiB) + "M", "-q",
		// Deny every destination but the backend's own loopback listener.
		"--no-net"}
	for _, port := range r.config.HostPorts {
		args = append(args, "--net-rule", fmt.Sprintf("allow@host:tcp:%d", port))
	}
	labels := r.ownership(workspaceID)
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		args = append(args, "--label", key+"="+labels[key])
	}
	return args
}

func (r *Runtime) createMachine(ctx context.Context, ws *workspace) error {
	ws.RelayPort = relayPort(r.config.EgressRelay)
	var args []string
	if ws.Snapshot != "" {
		args = append([]string{"run", "--from-snapshot", ws.Snapshot, "-d"}, r.machineFlags(ws.ID)...)
	} else {
		args = append([]string{"create", r.config.Image, "--pull", "if-missing", "--root-disk", strconv.Itoa(r.config.DiskMiB) + "M"}, r.machineFlags(ws.ID)...)
	}
	createCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if _, err := r.cli.run(createCtx, nil, args...); err != nil {
		return fmt.Errorf("%w: boot workspace microVM: %v", ErrUnavailable, err)
	}
	return r.prepareGuest(ctx, ws)
}

// prepareGuest plants the adapter's guest helper, creates the unprivileged
// workspace user and directories, and starts the host bridge.
func (r *Runtime) prepareGuest(ctx context.Context, ws *workspace) error {
	if err := r.installGuest(ctx, ws.Machine); err != nil {
		return err
	}
	if _, err := r.guest(ctx, ws.Machine, nil, "setup", guestUser, strconv.Itoa(guestUID), guestRoot, guestHome, guestStateDir, guestTempDir); err != nil {
		return fmt.Errorf("prepare workspace guest: %w", err)
	}
	if err := r.startBridges(ctx, ws); err != nil {
		return err
	}
	ws.guestOK = true
	return nil
}

func (r *Runtime) removeMachine(ctx context.Context, name string) error {
	removeCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	_, err := r.cli.run(removeCtx, nil, "remove", "--force", "-q", name)
	if err == nil {
		return nil
	}
	// `msb remove -q` reports a missing machine with a bare exit 1.
	if _, found, statusErr := r.cli.sandboxStatus(ctx, name); statusErr == nil && !found {
		return nil
	}
	return err
}

func (r *Runtime) stopMachine(ctx context.Context, name string) error {
	stopCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	_, err := r.cli.run(stopCtx, nil, "stop", "-t", "10", "-q", name)
	if err == nil {
		return nil
	}
	status, found, statusErr := r.cli.sandboxStatus(ctx, name)
	if statusErr == nil && (!found || status != "running") {
		return nil
	}
	return fmt.Errorf("stop microVM %s: %w", name, err)
}

func (r *Runtime) InspectWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.Workspace{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		return workspaceapi.Workspace{}, err
	}
	return describe(ws), nil
}

func (r *Runtime) workspaceLocked(id string) (*workspace, error) {
	if r.closed {
		return nil, errors.New("microsandbox runtime is closed")
	}
	ws := r.workspaces[strings.TrimSpace(id)]
	if ws == nil {
		return nil, fmt.Errorf("%w: %s", workspaceapi.ErrWorkspaceNotFound, id)
	}
	return ws, nil
}

func (r *Runtime) runningWorkspace(id string) (*workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		return nil, err
	}
	if ws.State != string(workspaceapi.WorkspaceRunning) {
		return nil, fmt.Errorf("%w: %s", workspaceapi.ErrWorkspaceStopped, id)
	}
	return ws, nil
}

// StartWorkspace boots a stopped workspace VM on its own disk.
func (r *Runtime) StartWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	r.mu.Lock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.Workspace{}, err
	}
	switch ws.State {
	case string(workspaceapi.WorkspaceRunning):
		described := describe(ws)
		r.mu.Unlock()
		return described, nil
	case string(workspaceapi.WorkspaceStopped):
	default:
		state := ws.State
		r.mu.Unlock()
		return workspaceapi.Workspace{}, fmt.Errorf("workspace is %s", state)
	}
	if err := r.admitRunningLocked(); err != nil {
		r.mu.Unlock()
		return workspaceapi.Workspace{}, err
	}
	ws.State = string(workspaceapi.WorkspaceStarting)
	r.mu.Unlock()

	var startErr error
	if ws.Reclaimed {
		startErr = r.recreateMachine(ctx, ws)
	} else {
		startErr = r.startMachine(ctx, ws)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if startErr != nil {
		ws.State = string(workspaceapi.WorkspaceStopped)
		_ = writeMetadata(ws)
		return workspaceapi.Workspace{}, startErr
	}
	ws.Reclaimed = false
	ws.State = string(workspaceapi.WorkspaceRunning)
	if err := writeMetadata(ws); err != nil {
		return workspaceapi.Workspace{}, err
	}
	return describe(ws), nil
}

func (r *Runtime) startMachine(ctx context.Context, ws *workspace) error {
	status, found, err := r.cli.sandboxStatus(ctx, ws.Machine)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if !found {
		return fmt.Errorf("workspace microVM %s no longer exists", ws.Machine)
	}
	if status != "running" {
		startCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		_, err := r.cli.run(startCtx, nil, "start", "-q", ws.Machine)
		cancel()
		if err != nil {
			return fmt.Errorf("%w: start workspace microVM: %v", ErrUnavailable, err)
		}
	}
	if _, err := r.guest(ctx, ws.Machine, nil, "kill-all"); err != nil {
		return err
	}
	return r.prepareGuest(ctx, ws)
}

// recreateMachine boots a fresh machine for a reclaimed workspace from its
// environment layer, or the base image, with an empty root. A partial boot is
// removed so the workspace stays reclaimed and startable.
func (r *Runtime) recreateMachine(ctx context.Context, ws *workspace) error {
	if r.environments != nil {
		if err := r.environments.admit(ctx); err != nil {
			return err
		}
	}
	if err := r.createMachine(ctx, ws); err != nil {
		_ = r.removeMachine(context.Background(), ws.Machine)
		return err
	}
	return nil
}

// ReclaimWorkspaceDisk removes a stopped workspace's machine and disk and
// keeps its metadata. The next StartWorkspace boots a fresh machine with an
// empty root from the workspace's environment layer; a workspace forked from
// a cold snapshot boots the base image instead, because that snapshot holds
// another workspace's files. It is idempotent.
func (r *Runtime) ReclaimWorkspaceDisk(ctx context.Context, id string) error {
	r.mu.Lock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	if ws.State != string(workspaceapi.WorkspaceStopped) {
		state := ws.State
		r.mu.Unlock()
		return fmt.Errorf("workspace is %s; only a stopped workspace's disk is reclaimed", state)
	}
	if ws.Reclaimed {
		r.mu.Unlock()
		return nil
	}
	ws.State = string(workspaceapi.WorkspaceStopping)
	r.mu.Unlock()

	removeErr := r.removeMachine(ctx, ws.Machine)
	r.mu.Lock()
	defer r.mu.Unlock()
	ws.State = string(workspaceapi.WorkspaceStopped)
	if removeErr != nil {
		return fmt.Errorf("reclaim workspace disk: %w", removeErr)
	}
	ws.Reclaimed = true
	if strings.HasPrefix(ws.Snapshot, coldSnapshotPrefix) {
		ws.Snapshot, ws.LayerKey, ws.Link = "", "", nil
	}
	return writeMetadata(ws)
}

// StopWorkspace ends every command and service, then stops the VM. Its disk,
// and so the workspace's files, are kept.
func (r *Runtime) StopWorkspace(ctx context.Context, id string) error {
	r.mu.Lock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	if ws.State == string(workspaceapi.WorkspaceStopped) {
		r.mu.Unlock()
		return nil
	}
	if ws.State == string(workspaceapi.WorkspaceStopping) {
		r.mu.Unlock()
		return errors.New("workspace stop is already in progress")
	}
	previous := ws.State
	ws.State = string(workspaceapi.WorkspaceStopping)
	commands := r.detachProcessesLocked(ws)
	r.mu.Unlock()

	for _, command := range commands {
		command.cancel()
	}
	stopErr := r.stopMachine(ctx, ws.Machine)
	r.mu.Lock()
	defer r.mu.Unlock()
	if stopErr != nil {
		ws.State = previous
		return stopErr
	}
	ws.State = string(workspaceapi.WorkspaceStopped)
	ws.guestOK = false
	return writeMetadata(ws)
}

// detachProcessesLocked revokes the egress binding, marks services stopped,
// and returns every live guest command so the caller can end them outside
// the lock.
func (r *Runtime) detachProcessesLocked(ws *workspace) []*guestCommand {
	if r.config.EgressRelay != nil {
		r.config.EgressRelay.Revoke(ws.ID)
	}
	commands := make([]*guestCommand, 0, len(ws.commands))
	for _, command := range ws.commands {
		commands = append(commands, command)
	}
	for _, service := range ws.services {
		if !service.command.finished() {
			service.stopped = true
		}
	}
	for port, preview := range ws.previews {
		preview.close()
		delete(ws.previews, port)
	}
	return commands
}

// DeleteWorkspace removes the VM and its disk. It is idempotent.
func (r *Runtime) DeleteWorkspace(ctx context.Context, id string) error {
	r.mu.Lock()
	ws, err := r.workspaceLocked(id)
	if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		r.mu.Unlock()
		return nil
	}
	if err != nil {
		r.mu.Unlock()
		return err
	}
	commands := r.detachProcessesLocked(ws)
	ws.State = string(workspaceapi.WorkspaceStopping)
	r.mu.Unlock()
	for _, command := range commands {
		command.cancel()
	}
	if err := r.removeMachine(ctx, ws.Machine); err != nil {
		return fmt.Errorf("delete workspace microVM: %w", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := os.RemoveAll(ws.directory); err != nil {
		return fmt.Errorf("delete microsandbox workspace state: %w", err)
	}
	delete(r.workspaces, ws.ID)
	return nil
}

// Close ends every command the backend holds and stops running VMs so no
// guest work outlives the backend. Disks and metadata are kept.
func (r *Runtime) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	var commands []*guestCommand
	var running []*workspace
	for _, ws := range r.workspaces {
		commands = append(commands, r.detachProcessesLocked(ws)...)
		if ws.State == string(workspaceapi.WorkspaceRunning) {
			running = append(running, ws)
		}
	}
	r.mu.Unlock()
	for _, command := range commands {
		command.cancel()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var errs []error
	for _, ws := range running {
		if err := r.stopMachine(ctx, ws.Machine); err != nil {
			errs = append(errs, err)
			continue
		}
		ws.State = string(workspaceapi.WorkspaceStopped)
		errs = append(errs, writeMetadata(ws))
	}
	return errors.Join(errs...)
}

var (
	_ workspaceapi.WorkspaceRuntime       = (*Runtime)(nil)
	_ workspaceapi.IsolationReporter      = (*Runtime)(nil)
	_ workspaceapi.WorkspaceDiskReclaimer = (*Runtime)(nil)
)
