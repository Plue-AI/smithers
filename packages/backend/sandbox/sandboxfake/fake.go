// Package sandboxfake is an in-memory sandbox.Provider for tests. A machine
// holds a file tree; a snapshot copies it; a machine created from a snapshot
// starts with that copy. Every lifecycle call is recorded for assertions.
package sandboxfake

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"sync"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Name is the provider name the fake reports.
const Name sandbox.ProviderName = "fake"

// Machine is one fake sandbox.
type Machine struct {
	ID    string
	State sandbox.State
	// Files is the guest tree, path to contents.
	Files map[string]string
	// Request is the create request that booted the machine; a fork records
	// its source as SnapshotID.
	Request sandbox.CreateRequest
}

// Exec is one recorded command.
type Exec struct {
	SandboxID string
	Command   string
}

// Provider is the in-memory provider. The zero value is not ready; use New.
type Provider struct {
	mu        sync.Mutex
	next      int
	machines  map[string]*Machine
	snapshots map[string]map[string]string
	creates   []sandbox.CreateRequest
	deleted   []string
	released  []string
	execs     []Exec

	// ExecFunc answers Execute; it may edit the machine's files. Nil exits 0.
	ExecFunc func(machine *Machine, req sandbox.ExecRequest) (sandbox.ExecResult, error)
	// CreateErr, when it returns an error, fails CreateSandbox before a machine exists.
	CreateErr func(req sandbox.CreateRequest) error
	// SnapshotErr fails SnapshotSandbox.
	SnapshotErr error
	// DeleteErr, when it returns an error, fails DeleteSandbox and keeps the machine.
	DeleteErr func(id string) error
	// DeleteSnapshotErr fails DeleteSnapshot and keeps the snapshot.
	DeleteSnapshotErr error
}

var _ sandbox.Provider = (*Provider)(nil)

// New returns an empty provider.
func New() *Provider {
	return &Provider{machines: map[string]*Machine{}, snapshots: map[string]map[string]string{}}
}

// Boot adds a running machine holding files, as if a workspace were already live.
func (p *Provider) Boot(files map[string]string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.add(maps.Clone(files), sandbox.CreateRequest{}).ID
}

func (p *Provider) add(files map[string]string, req sandbox.CreateRequest) *Machine {
	p.next++
	if files == nil {
		files = map[string]string{}
	}
	machine := &Machine{ID: fmt.Sprintf("fake-vm-%d", p.next), State: sandbox.StateRunning, Files: files, Request: req}
	p.machines[machine.ID] = machine
	return machine
}

func notFound(kind, id string) error {
	return fmt.Errorf("%w: %s %s", sandbox.ErrNotFound, kind, id)
}

func (p *Provider) Name() sandbox.ProviderName { return Name }

func (p *Provider) Capabilities() sandbox.Capabilities {
	return sandbox.Capabilities{
		sandbox.CapabilityExecution: true, sandbox.CapabilityColdLifecycle: true,
		sandbox.CapabilityColdSnapshots: true, sandbox.CapabilityFileTransfer: true,
	}
}

func (p *Provider) CreateSandbox(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	if p.CreateErr != nil {
		if err := p.CreateErr(req); err != nil {
			return sandbox.CreateResult{}, err
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.creates = append(p.creates, req)
	files := map[string]string{}
	if req.SnapshotID != "" {
		snapshot, ok := p.snapshots[req.SnapshotID]
		if !ok {
			return sandbox.CreateResult{}, notFound("snapshot", req.SnapshotID)
		}
		files = maps.Clone(snapshot)
	}
	for path, file := range req.Files {
		files[path] = file.Content
	}
	return sandbox.CreateResult{ID: p.add(files, req).ID}, nil
}

func (p *Provider) ForkSandbox(_ context.Context, sourceID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	source, ok := p.machines[sourceID]
	if !ok {
		return sandbox.CreateResult{}, notFound("sandbox", sourceID)
	}
	files := maps.Clone(source.Files)
	for path, file := range req.Files {
		files[path] = file.Content
	}
	return sandbox.CreateResult{ID: p.add(files, sandbox.CreateRequest{Kind: req.Kind, SnapshotID: sourceID}).ID}, nil
}

func (p *Provider) InspectSandbox(_ context.Context, id string) (sandbox.Sandbox, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	machine, ok := p.machines[id]
	if !ok {
		return sandbox.Sandbox{}, notFound("sandbox", id)
	}
	return sandbox.Sandbox{ID: id, RuntimeID: id, State: machine.State}, nil
}

func (p *Provider) DeleteSandbox(_ context.Context, id string) error {
	if p.DeleteErr != nil {
		if err := p.DeleteErr(id); err != nil {
			return err
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.machines[id]; !ok {
		return notFound("sandbox", id)
	}
	delete(p.machines, id)
	p.deleted = append(p.deleted, id)
	return nil
}

func (p *Provider) setState(id string, state sandbox.State) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	machine, ok := p.machines[id]
	if !ok {
		return notFound("sandbox", id)
	}
	machine.State = state
	return nil
}

func (p *Provider) StartSandbox(_ context.Context, id string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
	return sandbox.StartResult{ID: id, RuntimeID: id}, p.setState(id, sandbox.StateRunning)
}

func (p *Provider) StopSandbox(_ context.Context, id string) (sandbox.StopResult, error) {
	return sandbox.StopResult{SandboxID: id, RuntimeID: id}, p.setState(id, sandbox.StateStopped)
}

func (p *Provider) SuspendSandbox(_ context.Context, id string) (sandbox.SuspendResult, error) {
	return sandbox.SuspendResult{ID: id, RuntimeID: id}, p.setState(id, sandbox.StateStopped)
}

func (p *Provider) Execute(_ context.Context, id string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	machine, ok := p.machines[id]
	if !ok {
		return sandbox.ExecResult{}, notFound("sandbox", id)
	}
	p.execs = append(p.execs, Exec{SandboxID: id, Command: req.Command})
	if p.ExecFunc != nil {
		return p.ExecFunc(machine, req)
	}
	status := int32(0)
	return sandbox.ExecResult{StatusCode: &status}, nil
}

func (p *Provider) SnapshotSandbox(_ context.Context, id string, _ sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	if p.SnapshotErr != nil {
		return sandbox.SnapshotResult{}, p.SnapshotErr
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	machine, ok := p.machines[id]
	if !ok {
		return sandbox.SnapshotResult{}, notFound("sandbox", id)
	}
	p.next++
	snapshotID := fmt.Sprintf("fake-snap-%d", p.next)
	p.snapshots[snapshotID] = maps.Clone(machine.Files)
	return sandbox.SnapshotResult{SnapshotID: snapshotID, SourceSandboxID: id, SourceRuntimeID: id}, nil
}

func (p *Provider) CreateSnapshot(_ context.Context, req sandbox.CreateSnapshotRequest) (sandbox.CreateSnapshotResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.next++
	snapshotID := fmt.Sprintf("fake-snap-%d", p.next)
	files := map[string]string{}
	for path, file := range req.Template.Files {
		files[path] = file.Content
	}
	p.snapshots[snapshotID] = files
	return sandbox.CreateSnapshotResponse{SnapshotID: snapshotID}, nil
}

func (p *Provider) DeleteSnapshot(_ context.Context, id string) error {
	if p.DeleteSnapshotErr != nil {
		return p.DeleteSnapshotErr
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.snapshots[id]; !ok {
		return notFound("snapshot", id)
	}
	delete(p.snapshots, id)
	p.released = append(p.released, id)
	return nil
}

func (p *Provider) WriteFile(_ context.Context, id, path string, req sandbox.WriteFileRequest) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	machine, ok := p.machines[id]
	if !ok {
		return notFound("sandbox", id)
	}
	machine.Files[path] = req.Content
	return nil
}

func (p *Provider) CreateService(_ context.Context, _ string, spec sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	return sandbox.CreateServiceResult{Success: true, ServiceName: spec.Name}, nil
}

func (p *Provider) CreateIdentity(context.Context) (sandbox.Identity, error) {
	return sandbox.Identity{ID: "fake-identity", Managed: true}, nil
}

func (p *Provider) GrantAccess(_ context.Context, _, _ string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	return sandbox.AccessGrant{ID: "fake-grant", AllowedUsers: req.AllowedUsers}, nil
}

func (p *Provider) CreateIdentityToken(_ context.Context, identityID string) (sandbox.CreatedToken, error) {
	return sandbox.CreatedToken{ID: identityID + "-token", Token: "fake-token"}, nil
}

func (p *Provider) PublishIngress(_ context.Context, _ string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
	return sandbox.IngressRoute{ID: "fake-route", SandboxID: req.SandboxID, Port: req.Port}, nil
}

func (p *Provider) RevokeIngress(context.Context, string) error { return nil }

// Machine returns a copy of a live machine.
func (p *Provider) Machine(id string) (Machine, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	machine, ok := p.machines[id]
	if !ok {
		return Machine{}, false
	}
	copied := *machine
	copied.Files = maps.Clone(machine.Files)
	return copied, true
}

// Live returns the ids of every machine not deleted, sorted.
func (p *Provider) Live() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Sorted(maps.Keys(p.machines))
}

// Snapshots returns the ids of every snapshot not deleted, sorted.
func (p *Provider) Snapshots() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Sorted(maps.Keys(p.snapshots))
}

// Creates returns every create request, in order.
func (p *Provider) Creates() []sandbox.CreateRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.creates)
}

// Deleted returns the ids of deleted machines, in order.
func (p *Provider) Deleted() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.deleted)
}

// Released returns the ids of deleted snapshots, in order.
func (p *Provider) Released() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.released)
}

// Execs returns every executed command, in order.
func (p *Provider) Execs() []Exec {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.execs)
}
