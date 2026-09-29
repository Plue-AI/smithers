// Package process implements trusted single-owner workspace execution for an
// ordinary application container or native localhost process. It deliberately
// makes no sandboxing claim: child code has the backend process's OS authority.
package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"sync"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const metadataVersion = 1

// DefaultMaxConcurrent is the command concurrency cap used when Config leaves
// MaxConcurrent unset. One slow command in one workspace must not queue every
// other workspace's commands behind it.
func DefaultMaxConcurrent() int {
	return max(8, goruntime.NumCPU()*4)
}

// Config selects the adapter-owned data root and process limits. Environment
// is an explicit allowlist/value map; the adapter never copies os.Environ.
// MaxConcurrent caps concurrent one-shot commands across every workspace; zero
// selects DefaultMaxConcurrent.
type Config struct {
	Root             string
	Environment      map[string]string
	MaxConcurrent    int
	OutputLimit      int
	FileReadLimit    int64
	TerminationGrace time.Duration
}

type metadata struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	State   string `json:"state"`
}

type workspace struct {
	metadata
	directory string
	processes map[*managedProcess]struct{}
	services  map[string]*managedService
}

type managedService struct {
	spec        workspaceapi.ServiceSpec
	process     *managedProcess
	fingerprint string
	stdout      *limitedBuffer
	stderr      *limitedBuffer
	stopped     bool
}

// Runtime owns persistent workspace directories and every child process it
// starts. Product authorization and durable receipts stay outside this type.
type Runtime struct {
	root          string
	environment   map[string]string
	semaphore     chan struct{}
	outputLimit   int
	fileReadLimit int64
	grace         time.Duration

	mu         sync.Mutex
	closed     bool
	workspaces map[string]*workspace
}

// New opens a local process runtime and reloads existing workspace metadata.
// Live process state is intentionally not inferred after restart: loaded
// workspaces are stopped and common reconciliation starts required services.
func New(config Config) (*Runtime, error) {
	if strings.TrimSpace(config.Root) == "" {
		return nil, errors.New("process workspace root is required")
	}
	root, err := filepath.Abs(config.Root)
	if err != nil {
		return nil, fmt.Errorf("resolve process workspace root: %w", err)
	}
	if config.MaxConcurrent <= 0 {
		config.MaxConcurrent = DefaultMaxConcurrent()
	}
	if config.OutputLimit <= 0 {
		config.OutputLimit = 4 << 20
	}
	if config.FileReadLimit <= 0 {
		config.FileReadLimit = 16 << 20
	}
	if config.TerminationGrace <= 0 {
		config.TerminationGrace = 2 * time.Second
	}
	if err := os.MkdirAll(filepath.Join(root, "workspaces"), 0o700); err != nil {
		return nil, fmt.Errorf("create process workspace root: %w", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return nil, fmt.Errorf("protect process workspace root: %w", err)
	}
	environment := make(map[string]string, len(config.Environment)+1)
	for name, value := range config.Environment {
		if err := validateEnvironmentName(name); err != nil {
			return nil, err
		}
		if err := validateEnvironmentValue(name, value); err != nil {
			return nil, err
		}
		environment[name] = value
	}
	if _, ok := environment["PATH"]; !ok {
		environment["PATH"] = os.Getenv("PATH")
		if environment["PATH"] == "" {
			environment["PATH"] = "/usr/local/bin:/usr/bin:/bin"
		}
	}
	runtime := &Runtime{
		root: root, environment: environment, semaphore: make(chan struct{}, config.MaxConcurrent),
		outputLimit: config.OutputLimit, fileReadLimit: config.FileReadLimit, grace: config.TerminationGrace, workspaces: make(map[string]*workspace),
	}
	if err := runtime.load(); err != nil {
		return nil, err
	}
	return runtime, nil
}

func (r *Runtime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationTrustedProcess
}

// WorkspaceIsolation reports the limits of this adapter explicitly. It is a
// trusted child process with controlled workspace directories and process
// supervision, not a tenant or host security boundary.
func (r *Runtime) WorkspaceIsolation(ctx context.Context, workspaceID string) (workspaceapi.IsolationGuarantees, error) {
	if _, err := r.InspectWorkspace(ctx, workspaceID); err != nil {
		return workspaceapi.IsolationGuarantees{}, err
	}
	return workspaceapi.IsolationGuarantees{
		Level:    workspaceapi.IsolationTrustedProcess,
		Boundary: "host_process",
	}, nil
}

func (r *Runtime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{
		PersistentFiles: true, Execution: true, ManagedServices: true, ManagedHTTPHosts: true, SourceRevision: true, Terminal: goruntime.GOOS != "windows",
		LoopbackPreview: true, FileOperations: true, ColdSnapshots: false,
	}
}

func workspaceDirectoryName(id string) string {
	digest := sha256.Sum256([]byte(id))
	return hex.EncodeToString(digest[:])
}

func (r *Runtime) load() error {
	entries, err := os.ReadDir(filepath.Join(r.root, "workspaces"))
	if err != nil {
		return fmt.Errorf("read process workspaces: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		directory := filepath.Join(r.root, "workspaces", entry.Name())
		contents, err := os.ReadFile(filepath.Join(directory, "metadata.json"))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				// Older creates (or an interrupted delete) can leave an uncommitted
				// directory. Move it aside rather than discarding possible user data.
				quarantine, mkErr := os.MkdirTemp(filepath.Join(r.root, "workspaces"), ".incomplete-")
				if mkErr != nil {
					return fmt.Errorf("quarantine process workspace %s: %w", entry.Name(), mkErr)
				}
				if renameErr := os.Rename(directory, filepath.Join(quarantine, entry.Name())); renameErr != nil {
					_ = os.Remove(quarantine)
					return fmt.Errorf("quarantine process workspace %s: %w", entry.Name(), renameErr)
				}
				continue
			}
			return fmt.Errorf("read process workspace metadata %s: %w", entry.Name(), err)
		}
		var stored metadata
		if err := json.Unmarshal(contents, &stored); err != nil {
			return fmt.Errorf("decode process workspace metadata %s: %w", entry.Name(), err)
		}
		if stored.Version != metadataVersion || stored.ID == "" || workspaceDirectoryName(stored.ID) != entry.Name() {
			return fmt.Errorf("invalid process workspace metadata %s", entry.Name())
		}
		stored.State = string(workspaceapi.WorkspaceStopped)
		ws := &workspace{metadata: stored, directory: directory, processes: make(map[*managedProcess]struct{}), services: make(map[string]*managedService)}
		if err := ensureWorkspaceDirectories(directory); err != nil {
			return fmt.Errorf("restore process workspace %s: %w", stored.ID, err)
		}
		if err := writeMetadata(ws); err != nil {
			return err
		}
		if _, duplicate := r.workspaces[stored.ID]; duplicate {
			return fmt.Errorf("duplicate process workspace id %q", stored.ID)
		}
		r.workspaces[stored.ID] = ws
	}
	return nil
}

func ensureWorkspaceDirectories(directory string) error {
	for _, child := range []string{"root", "home", "state", "tmp", "home/.config", "home/.cache", "home/.local/share"} {
		if err := os.MkdirAll(filepath.Join(directory, child), 0o700); err != nil {
			return err
		}
	}
	return nil
}

func writeMetadata(ws *workspace) error {
	contents, err := json.Marshal(ws.metadata)
	if err != nil {
		return fmt.Errorf("encode process workspace metadata: %w", err)
	}
	temporary := filepath.Join(ws.directory, ".metadata.json.tmp")
	if err := os.WriteFile(temporary, append(contents, '\n'), 0o600); err != nil {
		return fmt.Errorf("write process workspace metadata: %w", err)
	}
	if err := os.Rename(temporary, filepath.Join(ws.directory, "metadata.json")); err != nil {
		return fmt.Errorf("commit process workspace metadata: %w", err)
	}
	return nil
}

func (r *Runtime) CreateWorkspace(ctx context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.Workspace{}, err
	}
	id := strings.TrimSpace(spec.ID)
	if id == "" || len(id) > 512 || strings.IndexByte(id, 0) >= 0 {
		return workspaceapi.Workspace{}, errors.New("workspace id is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return workspaceapi.Workspace{}, errors.New("process runtime is closed")
	}
	if existing := r.workspaces[id]; existing != nil {
		return describeWorkspace(existing), nil
	}
	directory := filepath.Join(r.root, "workspaces", workspaceDirectoryName(id))
	if _, err := os.Lstat(directory); err == nil {
		return workspaceapi.Workspace{}, fmt.Errorf("process workspace directory already exists for %q", id)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return workspaceapi.Workspace{}, fmt.Errorf("inspect process workspace directory: %w", err)
	}
	staging, err := os.MkdirTemp(filepath.Join(r.root, "workspaces"), ".creating-")
	if err != nil {
		return workspaceapi.Workspace{}, fmt.Errorf("create process workspace: %w", err)
	}
	defer os.RemoveAll(staging)
	if err := ensureWorkspaceDirectories(staging); err != nil {
		return workspaceapi.Workspace{}, fmt.Errorf("create process workspace directories: %w", err)
	}
	ws := &workspace{metadata: metadata{Version: metadataVersion, ID: id, State: string(workspaceapi.WorkspaceStopped)}, directory: staging,
		processes: make(map[*managedProcess]struct{}), services: make(map[string]*managedService)}
	if err := writeMetadata(ws); err != nil {
		return workspaceapi.Workspace{}, err
	}
	if err := os.Rename(staging, directory); err != nil {
		return workspaceapi.Workspace{}, fmt.Errorf("publish process workspace: %w", err)
	}
	ws.directory = directory
	r.workspaces[id] = ws
	return describeWorkspace(ws), nil
}

func describeWorkspace(ws *workspace) workspaceapi.Workspace {
	return workspaceapi.Workspace{ID: ws.ID, Root: filepath.Join(ws.directory, "root"), Home: filepath.Join(ws.directory, "home"),
		StateDir: filepath.Join(ws.directory, "state"), TempDir: filepath.Join(ws.directory, "tmp"), State: workspaceapi.WorkspaceState(ws.State)}
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
	return describeWorkspace(ws), nil
}

func (r *Runtime) StartWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.Workspace{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		return workspaceapi.Workspace{}, err
	}
	if ws.State == string(workspaceapi.WorkspaceStopping) {
		return workspaceapi.Workspace{}, errors.New("workspace stop is in progress")
	}
	if ws.State != string(workspaceapi.WorkspaceRunning) {
		previous := ws.State
		ws.State = string(workspaceapi.WorkspaceRunning)
		if err := writeMetadata(ws); err != nil {
			ws.State = previous
			return workspaceapi.Workspace{}, err
		}
	}
	return describeWorkspace(ws), nil
}

func (r *Runtime) StopWorkspace(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	ws, err := r.workspaceLocked(id)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	if ws.State == string(workspaceapi.WorkspaceStopping) {
		r.mu.Unlock()
		return errors.New("workspace stop is already in progress")
	}
	if ws.State == string(workspaceapi.WorkspaceStopped) && len(ws.processes) == 0 {
		r.mu.Unlock()
		return nil
	}
	ws.State = string(workspaceapi.WorkspaceStopping)
	persistErr := writeMetadata(ws)
	processes := make([]*managedProcess, 0, len(ws.processes))
	for process := range ws.processes {
		processes = append(processes, process)
	}
	for _, service := range ws.services {
		select {
		case <-service.process.done:
		default:
			service.stopped = true
		}
	}
	r.mu.Unlock()
	for _, process := range processes {
		process.stop(r.grace)
	}
	r.mu.Lock()
	if current := r.workspaces[strings.TrimSpace(id)]; current == ws && ws.State == string(workspaceapi.WorkspaceStopping) {
		// Reaping joins the child, not the command/service goroutine that
		// unregisters it. Retire the joined children before publishing stopped.
		for _, process := range processes {
			delete(ws.processes, process)
		}
		ws.State = string(workspaceapi.WorkspaceStopped)
		if err := writeMetadata(ws); err != nil {
			persistErr = errors.Join(persistErr, err)
		}
	}
	r.mu.Unlock()
	return persistErr
}

// WorkspaceIDs lists every workspace this runtime owns, including stopped
// workspaces reloaded from a previous process.
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

func (r *Runtime) DeleteWorkspace(ctx context.Context, id string) error {
	if err := r.StopWorkspace(ctx, id); err != nil && !errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(id)
	if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	// StopWorkspace joins children outside the lock. Refuse a concurrent
	// restart rather than deleting a directory under a newly running process.
	if ws.State != string(workspaceapi.WorkspaceStopped) || len(ws.processes) != 0 {
		return errors.New("workspace restarted during deletion; retry required")
	}
	// Keep the handle until removal succeeds so failed cleanup is retryable.
	if err := os.RemoveAll(ws.directory); err != nil {
		return fmt.Errorf("delete process workspace: %w", err)
	}
	delete(r.workspaces, ws.ID)
	return nil
}

func (r *Runtime) workspaceLocked(id string) (*workspace, error) {
	if r.closed {
		return nil, errors.New("process runtime is closed")
	}
	ws := r.workspaces[strings.TrimSpace(id)]
	if ws == nil {
		return nil, fmt.Errorf("%w: %s", workspaceapi.ErrWorkspaceNotFound, id)
	}
	return ws, nil
}

func (r *Runtime) runningWorkspaceLocked(id string) (*workspace, error) {
	ws, err := r.workspaceLocked(id)
	if err != nil {
		return nil, err
	}
	if ws.State != string(workspaceapi.WorkspaceRunning) {
		return nil, fmt.Errorf("%w: %s", workspaceapi.ErrWorkspaceStopped, id)
	}
	return ws, nil
}

func (r *Runtime) commandLocked(ws *workspace, command workspaceapi.Command) (*exec.Cmd, error) {
	if len(command.Args) == 0 || strings.TrimSpace(command.Args[0]) == "" {
		return nil, errors.New("command argv is required")
	}
	directory, err := resolveWorkspacePath(filepath.Join(ws.directory, "root"), command.Directory, true, true)
	if err != nil {
		return nil, fmt.Errorf("resolve command directory: %w", err)
	}
	environment := make(map[string]string, len(r.environment)+len(command.Environment)+8)
	for name, value := range r.environment {
		environment[name] = value
	}
	for name, value := range command.Environment {
		if err := validateEnvironmentName(name); err != nil {
			return nil, err
		}
		if err := validateEnvironmentValue(name, value); err != nil {
			return nil, err
		}
		environment[name] = value
	}
	home := filepath.Join(ws.directory, "home")
	environment["HOME"] = home
	environment["XDG_CONFIG_HOME"] = filepath.Join(home, ".config")
	environment["XDG_CACHE_HOME"] = filepath.Join(home, ".cache")
	environment["XDG_DATA_HOME"] = filepath.Join(home, ".local", "share")
	environment["TMPDIR"] = filepath.Join(ws.directory, "tmp")
	environment["SMITHERS_WORKSPACE_ROOT"] = filepath.Join(ws.directory, "root")
	environment["SMITHERS_WORKSPACE_STATE_DIR"] = filepath.Join(ws.directory, "state")
	executable, err := workspaceExecutable(command.Args[0], environment["PATH"], directory)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(executable, command.Args[1:]...)
	cmd.Args[0] = command.Args[0]
	cmd.Dir = directory
	cmd.Env = flattenEnvironment(environment)
	// A descendant may retain the output pipes after the command exits.
	// Bound that drain so the reaper can retire the remaining process group.
	cmd.WaitDelay = r.grace
	return cmd, nil
}

// exec.Command resolves bare names using the backend's PATH before Cmd.Env
// is assigned. Resolve against the actual workspace environment instead.
func workspaceExecutable(name, searchPath, directory string) (string, error) {
	if strings.ContainsRune(name, filepath.Separator) || strings.Contains(name, "/") {
		return name, nil
	}
	for _, entry := range filepath.SplitList(searchPath) {
		candidate := filepath.Join(entry, name)
		relative := !filepath.IsAbs(candidate)
		if relative {
			candidate = filepath.Join(directory, candidate)
		}
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		if relative {
			return "", &exec.Error{Name: name, Err: exec.ErrDot}
		}
		return candidate, nil
	}
	return "", &exec.Error{Name: name, Err: exec.ErrNotFound}
}

func validateEnvironmentName(name string) error {
	if name == "" || strings.ContainsAny(name, "=\x00") {
		return fmt.Errorf("invalid environment variable name %q", name)
	}
	return nil
}

func validateEnvironmentValue(name, value string) error {
	if strings.IndexByte(value, 0) >= 0 {
		return fmt.Errorf("environment variable %s contains a NUL byte", name)
	}
	return nil
}

func flattenEnvironment(environment map[string]string) []string {
	names := make([]string, 0, len(environment))
	for name := range environment {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]string, 0, len(names))
	for _, name := range names {
		result = append(result, name+"="+environment[name])
	}
	return result
}

func (r *Runtime) registerLocked(ws *workspace, process *managedProcess) {
	ws.processes[process] = struct{}{}
}

func (r *Runtime) unregister(id string, process *managedProcess) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ws := r.workspaces[strings.TrimSpace(id)]; ws != nil {
		delete(ws.processes, process)
	}
}

// Close terminates and reaps every child while preserving workspace files.
func (r *Runtime) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	var processes []*managedProcess
	var firstErr error
	for _, ws := range r.workspaces {
		ws.State = string(workspaceapi.WorkspaceStopped)
		if err := writeMetadata(ws); err != nil && firstErr == nil {
			firstErr = err
		}
		for process := range ws.processes {
			processes = append(processes, process)
		}
	}
	r.mu.Unlock()
	for _, process := range processes {
		process.stop(r.grace)
	}
	return firstErr
}
