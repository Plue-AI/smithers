package compose

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This Linux rehearsal adapter confines review commands and the packaged host
// to their ephemeral machine using an unprivileged user/mount namespace. It
// shares the rehearsal's admission queue; it does not qualify a Mac microVM.
type rehearsalReviewRuntime struct {
	*rehearsalAdmissionRuntime
	t                                                       *testing.T
	tools, bubblewrap, node, helper, host, evidence, daemon string
	daemons                                                 *machined.Registry
	stops                                                   sync.Map
}

func newRehearsalReviewRuntime(t *testing.T, runtime *rehearsalAdmissionRuntime, node, helper, host, evidence, daemon string, daemons *machined.Registry) *rehearsalReviewRuntime {
	t.Helper()
	bwrap, err := exec.LookPath("bwrap")
	require.NoError(t, err)
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	tools := t.TempDir()
	data, err := os.ReadFile(jj)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(tools, "jj"), data, 0700))
	data, err = os.ReadFile(bwrap)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(tools, "bwrap"), data, 0700))
	return &rehearsalReviewRuntime{rehearsalAdmissionRuntime: runtime, t: t, tools: tools, bubblewrap: bwrap, node: node, helper: helper, host: host, evidence: evidence, daemon: daemon, daemons: daemons}
}

func (r *rehearsalReviewRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}

func (r *rehearsalReviewRuntime) confined(current workspaceapi.Workspace, command workspaceapi.Command) workspaceapi.Command {
	// Each PID namespace has its own process table. Reusing the host name
	// makes a restarted host's PID 2 look like the prior live owner to the
	// production liveness probe. Give each namespace its own machine identity.
	args := []string{r.bubblewrap, "--tmpfs", "/", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--ro-bind", "/etc", "/etc", "--proc", "/proc", "--dev", "/dev", "--unshare-user", "--uid", "19998", "--gid", "19998", "--unshare-pid", "--unshare-uts", "--hostname", fmt.Sprintf("rehearsal-%d", time.Now().UnixNano()), "--die-with-parent"}
	// Bind only approved executables, never the host home or lane checkout.
	for _, path := range []string{r.node, r.helper, r.host, r.tools} {
		if path != "" {
			args = append(args, "--ro-bind", path, path)
		}
	}
	machine := filepath.Dir(current.Root)
	args = append(args, "--bind", machine, machine, "--chdir", current.Root, "--")
	args = append(args, command.Args...)
	command.Args = args
	if command.Environment == nil {
		command.Environment = map[string]string{}
	}
	command.Environment["PATH"] = "/usr/bin:/bin"
	if r.tools != "" {
		command.Environment["PATH"] = r.tools + ":" + command.Environment["PATH"]
	}
	return command
}

func (r *rehearsalReviewRuntime) ExecuteCommand(ctx context.Context, id string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	current, err := r.InspectWorkspace(ctx, id)
	if err != nil {
		return workspaceapi.CommandResult{}, err
	}
	result, err := r.Runtime.ExecuteCommand(ctx, id, r.confined(current, command))
	if err != nil || result.ExitCode != 0 {
		log, openErr := os.OpenFile(filepath.Join(r.evidence, "review-machine.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if openErr == nil {
			fmt.Fprintf(log, "%s: exit=%d error=%v stderr=%s\n", command.Args[0], result.ExitCode, err, result.Stderr)
			_ = log.Close()
		}
	}
	return result, err
}

func (r *rehearsalReviewRuntime) ResolveWorkspaceSourceRevision(ctx context.Context, id string) (string, error) {
	return workspaceapi.ResolveSourceRevision(ctx, r, id)
}

func (r *rehearsalReviewRuntime) StartManagedHost(ctx context.Context, id string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	current, err := r.InspectWorkspace(ctx, id)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	// Explicit scratch authority enables native readiness without assigning a
	// TODO or any host publishing binding to this ephemeral review machine.
	if _, err := r.daemons.Current(id); err != nil {
		if err := startRehearsalMachined(r.t, ctx, r.daemons, id, current.Root, r.evidence, r.daemon, &machined.ItemBinding{}, func(stop func()) {
			prior, loaded := r.stops.LoadOrStore(id, stop)
			if loaded {
				r.stops.Store(id, func() { prior.(func())(); stop() })
			}
		}); err != nil {
			return workspaceapi.ManagedHostConnection{}, fmt.Errorf("review daemon: %w", err)
		}
	}
	builder := spec.Builder
	spec.Builder = workspaceapi.ManagedHostBuilderFunc(func(ctx context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
		command, err := builder.BuildManagedHost(ctx, placement)
		if err != nil {
			return command, err
		}
		// The Linux namespace has the same provisioned helper as coding;
		// the fixed guest install path does not exist in this fixture.
		if command.Environment == nil {
			command.Environment = map[string]string{}
		}
		command.Environment["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] = r.helper
		return r.confined(placement.Workspace, command), nil
	})
	connection, err := r.Runtime.StartManagedHost(ctx, id, spec)
	if err != nil {
		observed, inspectErr := r.Runtime.InspectService(context.WithoutCancel(ctx), id, spec.Name)
		if inspectErr == nil {
			_ = os.WriteFile(filepath.Join(r.evidence, "review-host.log"), []byte(observed.Stdout+"\n"+observed.Stderr), 0600)
		}
	}
	return connection, err
}

// HTTP proof without waiting for J10's unrelated multi-TODO GitHub scenarios.
func TestJ10MemberReviewRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J10_REHEARSAL", "C-J10", "j10-review-")

	runtime := r.options.ReviewWorkspace.(*rehearsalReviewRuntime)
	machine, err := runtime.CreateWorkspace(r.ctx, workspaceapi.WorkspaceSpec{ID: "review-confinement"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(r.ctx, machine.ID)
	require.NoError(t, err)
	result, err := runtime.ExecuteCommand(r.ctx, machine.ID, workspaceapi.Command{Args: []string{"id", "-u"}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stderr)
	require.Equal(t, "19998\n", result.Stdout)
	secret := filepath.Join(t.TempDir(), "host-secret")
	require.NoError(t, os.WriteFile(secret, []byte("review-must-not-read-host"), 0600))
	result, err = runtime.ExecuteCommand(r.ctx, machine.ID, workspaceapi.Command{Args: []string{"cat", secret}})
	require.NoError(t, err)
	require.NotEqual(t, 0, result.ExitCode)
	require.NotContains(t, result.Stdout, "review-must-not-read-host")
	require.NoError(t, runtime.DeleteWorkspace(r.ctx, machine.ID))
	if !r.install("Install through Machine ready") {
		return
	}
	ben, err := r.member("ben", 201, "maintain")
	require.NoError(t, err)
	_, err = r.member("alice", 202, "write")
	require.NoError(t, err)
	r.j10BuiltinReviewActive()
	r.j10MemberReview(ben, "rehearsal-owner/app")
}

// The existing rehearsal admission adapter models three slots, without claiming
// reference-host capacity evidence. Both TODO eligibility and review demand are
// guarded by its shared mutex. Production uses microsandbox's admission queue.
func (r *rehearsalReviewRuntime) FreeDisk(context.Context) (int64, error) { return 400 << 30, nil }
func (r *rehearsalReviewRuntime) WaitAdmission(ctx context.Context, p microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	row := microsandbox.AdmissionRequest{Class: class, Holder: holder, Actor: actor, Reason: reason, State: "waiting"}
	if err := p.Ready(ctx, row); err != nil {
		return ctx, err
	}
	for {
		r.admissionMu.Lock()
		if r.reviewRequests == nil {
			r.reviewRequests = map[string]microsandbox.AdmissionRequest{}
		}
		if existing := r.reviewRequests[holder]; existing.State == "granted" && existing.Actor == actor {
			r.admissionMu.Unlock()
			return ctx, nil
		}
		used := 0
		for _, eligible := range r.eligible {
			if eligible {
				used++
			}
		}
		for _, request := range r.reviewRequests {
			if request.State == "granted" {
				used++
			}
		}
		if used < 3 {
			row.State = "granted"
		}
		r.reviewRequests[holder] = row
		r.admissionMu.Unlock()
		if row.State == "granted" {
			return ctx, nil
		}
		select {
		case <-ctx.Done():
			return ctx, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
		if err := p.Ready(ctx, row); err != nil {
			return ctx, err
		}
	}
}
func (r *rehearsalReviewRuntime) CancelFailedAdmission(holder, actor string) {
	r.admissionMu.Lock()
	defer r.admissionMu.Unlock()
	row := r.reviewRequests[holder]
	if row.Actor == actor {
		row.State = "released"
		r.reviewRequests[holder] = row
	}
}
func (r *rehearsalReviewRuntime) AdmissionSnapshot() []microsandbox.AdmissionRequest {
	r.admissionMu.Lock()
	defer r.admissionMu.Unlock()
	rows := make([]microsandbox.AdmissionRequest, 0, len(r.reviewRequests))
	for _, row := range r.reviewRequests {
		rows = append(rows, row)
	}
	return rows
}

func (r *rehearsalReviewRuntime) DeleteWorkspace(ctx context.Context, id string) error {
	// Retain the terminal engine journal before this ephemeral machine disappears.
	if current, err := r.InspectWorkspace(ctx, id); err == nil {
		_ = r.Runtime.StopService(ctx, id, "smithers-coding-host")
		_ = filepath.WalkDir(current.StateDir, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			name := entry.Name()
			if name != "engine.db" && name != "engine.db-wal" && name != "control.db" && name != "control.db-wal" {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			dir := filepath.Join(r.evidence, "review-engine-"+id)
			if err = os.MkdirAll(dir, 0700); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(dir, name), data, 0600)
		})
	}
	if stop, found := r.stops.LoadAndDelete(id); found {
		stop.(func())()
	}
	return r.Runtime.DeleteWorkspace(ctx, id)
}
