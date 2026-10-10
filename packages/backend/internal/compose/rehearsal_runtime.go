package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The assisted journey supervises trusted processes, not production VMs.
// Its test-only admission adapter supplies the ordered TODO contract without
// claiming capacity or isolation evidence. Production uses microsandbox's queue.
type rehearsalAdmissionRuntime struct {
	*process.Runtime
	admissionMu    sync.Mutex
	daemonLocks    sync.Map // one authenticated boot per retained process checkout
	daemonStates   sync.Map // retained machine journal, independent of daemon transport
	eligible       map[string]bool
	released       map[string]bool
	aliases        map[string]string
	reviewRequests map[string]microsandbox.AdmissionRequest
}

func (r *rehearsalAdmissionRuntime) SyncTodoAdmission(scope string, holders []string, limit int) error {
	r.admissionMu.Lock()
	defer r.admissionMu.Unlock()
	if scope == "" {
		return errors.New("TODO admission scope unavailable")
	}
	capacity := 3
	for _, request := range r.reviewRequests {
		if request.State == "granted" {
			capacity--
		}
	}
	// The owner's TODO limit and total machine capacity are distinct.
	// A review uses one machine slot, not one of the owner's TODO slots.
	limit = min(limit, max(0, capacity))
	r.eligible = map[string]bool{}
	for i, holder := range holders {
		if target := r.aliases[holder]; target != "" {
			holder = target
		}
		r.eligible[holder] = i < limit
	}
	return nil
}

func (r *rehearsalAdmissionRuntime) TodoAdmissionEligible(holder string) bool {
	r.admissionMu.Lock()
	defer r.admissionMu.Unlock()
	if target := r.aliases[holder]; target != "" {
		holder = target
	}
	return r.eligible[holder]
}

func (r *rehearsalAdmissionRuntime) TransferTodoAdmission(from, to string) error {
	r.admissionMu.Lock()
	defer r.admissionMu.Unlock()
	origin := from
	if target := r.aliases[from]; target != "" {
		if !r.released[target] {
			return errors.New("TODO admission handoff still active")
		}
		from = target
	}
	_, known := r.eligible[from]
	_, targetExists := r.eligible[to]
	if (!known && !r.released[from]) || to == "" || to == from || targetExists {
		return errors.New("TODO admission handoff unavailable")
	}
	r.eligible[to] = r.eligible[from]
	delete(r.eligible, from)
	delete(r.released, from)
	for holder, target := range r.aliases {
		if target == from {
			r.aliases[holder] = to
		}
	}
	r.aliases[origin], r.aliases[from] = to, to
	return nil
}

// Stop confirms release only after its actual processes stop. As in the
// production admission holder, aliases survive so ordered Sync can re-admit
// reviews and transfer a released holder to the next attempt's new lane.
func (r *rehearsalAdmissionRuntime) StopWorkspace(ctx context.Context, id string) error {
	err := r.Runtime.StopWorkspace(ctx, id)
	if err == nil || errors.Is(err, workspaceapi.ErrWorkspaceStopped) || errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		r.releaseTodoAdmission("workspace:" + id)
	}
	return err
}

func (r *rehearsalAdmissionRuntime) releaseTodoAdmission(holder string) {
	r.admissionMu.Lock()
	defer r.admissionMu.Unlock()
	if r.released == nil {
		r.released = map[string]bool{}
	}
	r.released[holder] = true
	delete(r.eligible, holder)
	// Review demand shares this runtime, so its confirmed process stop must
	// retire the review grant as well as any ordered TODO demand. Otherwise
	// SyncTodoAdmission keeps subtracting a stopped review from parallel.
	if request, ok := r.reviewRequests[holder]; ok {
		request.State = "released"
		r.reviewRequests[holder] = request
	}
}

// bindingProcessRuntime is the trusted-process runtime with the source binding
// a guest gets (installRuntimeBoxCodingBinding): the binding is written as this
// user in the checkout's .jj directory, and each coding host the
// workspace starts names it in SMITHERS_WORKSPACE_CODING_CONFIG. Only a
// smithers-jj-export built with trusted-process-binding reads that file; the
// credential is the head publisher's Git cache, as in a guest.
// A host that exits before it is ready leaves both output streams in the evidence.
type bindingProcessRuntime struct {
	productAPIURL       string
	sandboxed           bool
	node, helper, tools string
	hostCredentials     *sync.Map
	*rehearsalAdmissionRuntime
	evidence          string
	t                 rehearsalLifecycle
	daemons           *machined.Registry
	daemonStops       *sync.Map
	pool              *pgxpool.Pool
	daemonBinary      string
	repository        *repohost.Client
	failNextTodoStart *atomic.Bool
}

var _ workspaceapi.WorkspaceCodingBindingInstaller = bindingProcessRuntime{}

// Linux acceptance runs repository commands in a real unprivileged mount/user
// namespace. This is sandbox evidence only; reference microVM/root proofs remain
// separate. Never attest isolation for the underlying trusted process runtime.
func (r bindingProcessRuntime) Isolation() workspaceapi.IsolationLevel {
	if !r.sandboxed {
		return r.Runtime.Isolation()
	}
	return workspaceapi.IsolationSandboxed
}

// Capacity/order remain the rehearsal admission model above, not Mac capacity
// evidence. The production workspace service still validates each stored demand.
func (r bindingProcessRuntime) ReconstructAdmission(ctx context.Context, demand []microsandbox.AdmissionRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.admissionMu.Lock()
	defer r.admissionMu.Unlock()
	if r.eligible == nil {
		r.eligible = map[string]bool{}
	}
	for _, row := range demand {
		if row.Class == "todo" {
			if _, ordered := r.eligible[row.Holder]; !ordered {
				r.eligible[row.Holder] = false
			}
		}
	}
	return nil
}

func (r bindingProcessRuntime) WaitAdmission(ctx context.Context, p microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	row := microsandbox.AdmissionRequest{Class: class, Holder: holder, Actor: actor, Reason: reason, State: "waiting"}
	if p.Ready == nil {
		return ctx, errors.New("rehearsal admission readiness unavailable")
	}
	for {
		err := p.Ready(ctx, row)
		if err == nil {
			return ctx, nil
		}
		if !errors.Is(err, microsandbox.ErrAdmissionNotReady) {
			r.t.Logf("Linux admission %s: %v", holder, err)
			return ctx, err
		}
		select {
		case <-ctx.Done():
			return ctx, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// The assisted journey does not qualify idle reclaim or the 24-hour machine
// policy. Validate its service composition; reference tests drive the scheduler.
func (r bindingProcessRuntime) SetAdmissionIdleProviders(p microsandbox.AdmissionIdleProviders) error {
	if p.FreeDisk == nil || p.Safety == nil || p.Prepare == nil || p.Stop == nil {
		return errors.New("rehearsal idle providers unavailable")
	}
	return nil
}

func (r bindingProcessRuntime) AdmissionSnapshot() []microsandbox.AdmissionRequest {
	return (&rehearsalReviewRuntime{rehearsalAdmissionRuntime: r.rehearsalAdmissionRuntime}).AdmissionSnapshot()
}

func (r bindingProcessRuntime) FreeDisk(ctx context.Context) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	// Match the existing declared rehearsal profile for coding and review.
	// Fleet disk pressure is not a reference-host capacity measurement.
	return (&rehearsalReviewRuntime{rehearsalAdmissionRuntime: r.rehearsalAdmissionRuntime}).FreeDisk(ctx)
}

func (r bindingProcessRuntime) GuestIdentity() (string, int) {
	if !r.sandboxed {
		return "lane", os.Getuid()
	}
	return "agent", 19998
}

func (r bindingProcessRuntime) WorkspaceIsolation(ctx context.Context, id string) (workspaceapi.IsolationGuarantees, error) {
	if _, err := r.InspectWorkspace(ctx, id); err != nil {
		return workspaceapi.IsolationGuarantees{}, err
	}
	boundary := "trusted_process"
	if r.sandboxed {
		boundary = "linux_user_mount_namespace"
	}
	return workspaceapi.IsolationGuarantees{Level: r.Isolation(), Boundary: boundary}, nil
}

func (r bindingProcessRuntime) confined(current workspaceapi.Workspace, command workspaceapi.Command, artifact string) (workspaceapi.Command, error) {
	if !r.sandboxed {
		return command, nil
	}
	bwrap, err := exec.LookPath("bwrap")
	if err != nil {
		return command, err
	}
	sandbox := rehearsalReviewRuntime{bubblewrap: bwrap, node: r.node, helper: r.helper, host: artifact, tools: r.tools}
	command = sandbox.confined(current, command)
	// Before clone the repository must remain empty. Its installed native JJ
	// appears afterward; the fixed namespace tool directory serves bootstrap.
	localTools := filepath.Join(current.Root, ".jj", "rehearsal-tools")
	if _, err := os.Stat(localTools); err == nil {
		command.Environment["PATH"] = localTools + ":" + command.Environment["PATH"]
	}

	return command, nil
}

func (r bindingProcessRuntime) ExecuteCommand(ctx context.Context, id string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	current, err := r.InspectWorkspace(ctx, id)
	if err != nil {
		return workspaceapi.CommandResult{}, err
	}
	command, err = r.confined(current, command, "")
	if err != nil {
		return workspaceapi.CommandResult{}, err
	}
	return r.Runtime.ExecuteCommand(ctx, id, command)
}

func (r bindingProcessRuntime) StartService(ctx context.Context, id string, spec workspaceapi.ServiceSpec) (workspaceapi.Service, error) {
	current, err := r.InspectWorkspace(ctx, id)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	spec.Command, err = r.confined(current, spec.Command, "")
	if err != nil {
		return workspaceapi.Service{}, err
	}
	return r.Runtime.StartService(ctx, id, spec)
}

// Person file writes use the authenticated daemon and the ordinary operation
// context. The process runtime's direct filesystem helpers are never a fallback.
func (r bindingProcessRuntime) CompareWriteFiles(ctx context.Context, workspaceID string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	return (machined.WorkspaceWriter{Client: r.daemons, EnsureReady: func(ctx context.Context, branch string) error {
		observed, err := r.InspectWorkspace(ctx, branch)
		if err != nil {
			return err
		}
		if err := r.ensureDaemon(ctx, branch, observed.Root); err != nil {
			return err
		}
		link, err := r.daemons.Current(branch)
		if err != nil {
			return err
		}
		return link.RequireReady(branch)
	}}).CompareWriteFiles(ctx, workspaceID, changes)
}

// EnsureMachined makes branch admission use the production publisher retirement
// and daemon reconciliation before the workspace is advertised as running.
func (r bindingProcessRuntime) EnsureMachined(ctx context.Context, id string) error {
	observed, err := r.InspectWorkspace(ctx, id)
	if err != nil {
		return err
	}
	// Presence can probe while the normal repository setup still runs.
	// The probe must not initialize the checkout ahead of that setup.
	if _, err := os.Stat(filepath.Join(observed.Root, ".jj")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return machined.ErrNotReady
		}
		return err
	}
	err = r.ensureDaemon(ctx, id, observed.Root)
	if err != nil {
		r.t.Logf("daemon admission workspace=%s: %v", id, err)
	}
	return err
}

// Resolve the catalog only after native wake has settled the working copy.
// Admission can change its snapshot; a source captured before wake is stale.
func (r bindingProcessRuntime) ResolveWorkspaceSourceRevision(ctx context.Context, id string) (string, error) {
	if err := r.EnsureMachined(ctx, id); err != nil {
		return "", err
	}
	return r.Runtime.ResolveWorkspaceSourceRevision(ctx, id)
}

func (r bindingProcessRuntime) ensureDaemon(ctx context.Context, id, root string) error {
	// Gateway registration and a person's request can reach the same retained
	// checkout concurrently. A second MintBoot must not fence the first boot
	// while its real object transfer and reconciliation are still in progress.
	lock, _ := r.daemonLocks.LoadOrStore(id, new(sync.Mutex))
	boot := lock.(*sync.Mutex)
	boot.Lock()
	defer boot.Unlock()
	observed, err := r.InspectWorkspace(ctx, id)
	if err != nil {
		return err
	}
	if observed.State != workspaceapi.WorkspaceRunning {
		return workspaceapi.ErrWorkspaceStopped
	}

	link, err := r.daemons.Current(id)
	if err == nil && link.RequireReady(id) == nil {
		return nil
	}
	// Recomposition closes the old event transport. Its process still owns
	// the native checkout until stopped; replacing it first lets the next
	// authenticated boot replay and reconcile the retained journal.
	if stop, ok := r.daemonStops.LoadAndDelete(id); ok {
		stop.(func())()
	}
	item, err := machineItemBinding(ctx, r.pool, id, r.repository)
	if err != nil {
		return fmt.Errorf("item binding: %w", err)
	}
	// The transport belongs to the retained machine, not one launch.
	// Resolve its host-authorized head before native wake; cleanup retires it.
	head, err := machineBranchHead(r.pool, r.repository)(ctx, id)
	if err != nil {
		return fmt.Errorf("host head: %w", err)
	}
	state, exists := r.daemonStates.Load(id)
	if !exists {
		state = r.t.TempDir()
		r.daemonStates.Store(id, state)
	}
	r.t.Logf("daemon item binding workspace=%s number=%d change=%s", id, item.Number, item.Change)
	conflict, err := machineRetainedConflict(ctx, r.pool, id)
	if err != nil {
		return err
	}
	return startRehearsalMachinedWith(r.t, r.t.Context(), r.daemons, id, root, r.evidence, r.daemonBinary, &item, &rehearsalRestart{State: state.(string), HostHead: head, Transfer: true, Conflict: conflict}, func(stop func()) { r.daemonStops.Store(id, stop) })
}

// Stop the retained machine's native transport with its actual processes.
func (r bindingProcessRuntime) StopWorkspace(ctx context.Context, id string) error {
	lock, _ := r.daemonLocks.LoadOrStore(id, new(sync.Mutex))
	boot := lock.(*sync.Mutex)
	boot.Lock()
	defer boot.Unlock()
	err := r.rehearsalAdmissionRuntime.StopWorkspace(ctx, id)
	if err == nil || errors.Is(err, workspaceapi.ErrWorkspaceStopped) || errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		if stop, ok := r.daemonStops.LoadAndDelete(id); ok {
			stop.(func())()
		}
		if link, err := r.daemons.Current(id); err == nil {
			_ = link.Close()
		}
	}
	return err
}

func (r bindingProcessRuntime) binding(ctx context.Context, workspaceID string) (string, workspaceapi.Workspace, error) {
	observed, err := r.InspectWorkspace(ctx, workspaceID)
	if err != nil {
		return "", observed, err
	}
	// The coding host runs its helper confined to the checkout's reads, so
	// the binding sits in the checkout's .jj directory, which no source holds.
	return filepath.Join(observed.Root, ".jj", "workspace-coding.json"), observed, nil
}

func (r bindingProcessRuntime) InstallWorkspaceCodingBinding(ctx context.Context, workspaceID string, binding workspaceapi.WorkspaceCodingBinding) error {
	if err := binding.Validate(); err != nil {
		return err
	}
	file, observed, err := r.binding(ctx, workspaceID)
	if err != nil {
		return err
	}
	if err := provisionRehearsalJJ(observed.Root); err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		workspaceapi.WorkspaceCodingBinding
		Version          int    `json:"version"`
		WorkspaceID      string `json:"workspaceId"`
		RepositoryPath   string `json:"repositoryPath"`
		CredentialSocket string `json:"credentialSocket"`
	}{binding, 1, workspaceID, observed.Root, filepath.Join(observed.Home, ".cache", "smithers", "git-credential", "socket")})
	if err != nil {
		return err
	}
	temporary := file + ".tmp"
	if err = os.WriteFile(temporary, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, file); err != nil {
		return err
	}

	return nil
}

// Every production host checks its source with the same confined jj binary,
// including flow-load hosts that have no candidate/landing binding.
func provisionRehearsalJJ(root string) error {
	// Catalog probes can arrive during provisioning. Never make the clone's
	// empty destination nonempty before its repository materialization settles.
	if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
		if os.IsNotExist(err) {
			return workspaceapi.ErrWorkspaceSourceUnavailable
		}
		return err
	}
	// The confined native helper also invokes jj. Host-home tools are outside
	// its runtime reads, so provision the exact fixture executable inside .jj,
	// alongside the protected test-only binding; never grant the host home.
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	if err != nil {
		return err
	}
	// Auxiliary readers start from the plain Git image too. The daemon loads
	// JJ directly, so initialize its colocated store before native admission.
	if _, err := os.Stat(filepath.Join(root, ".jj", "repo")); os.IsNotExist(err) {
		command := exec.Command(jj, "git", "init", "--colocate", root)
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("initialize rehearsal jj: %w: %s", err, output)
		}
	} else if err != nil {
		return err
	}
	tools := filepath.Join(root, ".jj", "rehearsal-tools")
	if err := os.MkdirAll(tools, 0700); err != nil {
		return err
	}
	binary, err := os.ReadFile(jj)
	if err != nil {
		return err
	}
	tool := filepath.Join(tools, "jj")
	if installed, err := os.ReadFile(tool); err == nil {
		if !bytes.Equal(installed, binary) {
			return errors.New("rehearsal jj executable changed across restart")
		}
	} else if os.IsNotExist(err) {
		if err := os.WriteFile(tool, binary, 0500); err != nil {
			return err
		}
	} else {
		return err
	}
	return nil
}

// rehearsalJJBinary is the first jj executable on path that is not a script.
// A wrapper (a version manager's shim, a guard) copied into the workspace
// would find itself first on the host's PATH and exec itself forever.
func rehearsalJJBinary(path string) (string, error) {
	for _, dir := range filepath.SplitList(path) {
		candidate := filepath.Join(dir, "jj")
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
			continue
		}
		file, err := os.Open(candidate)
		if err != nil {
			continue
		}
		head := make([]byte, 2)
		_, err = io.ReadFull(file, head)
		_ = file.Close()
		if err == nil && string(head) != "#!" {
			return candidate, nil
		}
	}
	return "", errors.New("no jj executable on PATH")
}

func (r bindingProcessRuntime) StartManagedHost(ctx context.Context, workspaceID string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	file, observed, err := r.binding(ctx, workspaceID)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	if err := provisionRehearsalJJ(observed.Root); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	build := spec.Builder
	spec.Builder = workspaceapi.ManagedHostBuilderFunc(func(ctx context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
		command, err := build.BuildManagedHost(ctx, placement)
		if err != nil {
			return command, err
		}
		// The installed guest Learning binding reads this origin, rather than
		// the CLI URL. Qualify the catalog handed off by real composition.
		if r.productAPIURL != "" && command.Environment["SMITHERS_PRODUCT_API_URL"] != r.productAPIURL {
			return command, fmt.Errorf("guest Learning evidence origin = %q, want install %q", command.Environment["SMITHERS_PRODUCT_API_URL"], r.productAPIURL)
		}
		environment := make(map[string]string, len(command.Environment)+1)
		for name, value := range command.Environment {
			environment[name] = value
		}
		environment["SMITHERS_WORKSPACE_CODING_CONFIG"] = file
		// The process stand-in has no installed guest /usr/local/bin. Use the
		// same current native helper that admitted its source binding; the
		// fixed guest path may name an older server-wide executable.
		environment["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] = os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY")
		environment["PATH"] = filepath.Join(observed.Root, ".jj", "rehearsal-tools") + ":" + os.Getenv("PATH")
		command.Environment = environment
		if token := environment["SMITHERS_JJHUB_TOKEN"]; token != "" {
			if r.hostCredentials != nil {
				r.hostCredentials.Store(workspaceID, token)
			}
			// The native source helper uses the coding host's own delegated
			// repository credential. Daemon admission retired the legacy head
			// publisher; its Git cache cannot provide this host's authority.
			data, err := os.ReadFile(file)
			if err != nil {
				return command, err
			}
			var binding workspaceapi.WorkspaceCodingBinding
			if err = json.Unmarshal(data, &binding); err != nil {
				return command, err
			}
			socket := filepath.Join(observed.Home, ".cache", "smithers", "git-credential", "socket")
			if err = os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
				return command, err
			}
			cache := exec.CommandContext(ctx, "git", "credential-cache", "--timeout=600", "--socket", socket, "store")
			cache.Stdin = strings.NewReader("url=" + binding.GitURL + "\nusername=smithers\npassword=" + token + "\n\n")
			if err = cache.Run(); err != nil {
				return command, fmt.Errorf("coding credential cache: %w", err)
			}
			r.t.Cleanup(func() { _ = exec.Command("git", "credential-cache", "--socket", socket, "exit").Run() })
		}
		return r.confined(placement.Workspace, command, command.Args[0])
	})
	// Host registration now uses the production daemon-backed filesystem.
	// Reconcile its boot before waiting for gateway readiness, or registration
	// and daemon startup wait on each other. A stopped boot must reconcile again.
	if err := r.ensureDaemon(ctx, workspaceID, observed.Root); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	connection, err := r.Runtime.StartManagedHost(ctx, workspaceID, spec)
	if err == nil && r.failNextTodoStart != nil && r.failNextTodoStart.Load() {
		var todo bool
		if lookup := r.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mythical_items WHERE source='todo' AND workspace_id=$1)`, workspaceID).Scan(&todo); lookup != nil {
			return connection, lookup
		}
		if todo && r.failNextTodoStart.CompareAndSwap(true, false) {
			// Lose one readiness acknowledgment after the actual service starts.
			// The production launcher must retire it before a fresh credential
			// can serve this same durable TODO admission on retry.
			err = errors.New("scripted lost readiness acknowledgment")
		}
	}
	if err != nil {
		service, inspectErr := r.InspectService(context.WithoutCancel(ctx), workspaceID, spec.Name)
		output, _ := os.OpenFile(filepath.Join(r.evidence, "coding-host.output.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if output != nil {
			fmt.Fprintf(output, "--- %s workspace=%s %s: %v\ninspect=%v exit=%d truncated=%t\nstdout:\n%s\nstderr:\n%s\n", time.Now().UTC().Format(time.RFC3339), workspaceID, spec.Name, err, inspectErr, service.ExitCode, service.OutputTruncated, service.Stdout, service.Stderr)
			_ = output.Close()
		}
	}

	return connection, err
}
