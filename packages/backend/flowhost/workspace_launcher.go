package flowhost

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type workspaceLauncher struct {
	allowTrustedProcessForTests bool
	runtime                     workspaceapi.WorkspaceRuntime
	hosts                       workspaceapi.WorkspaceManagedHosts
	source                      workspaceapi.WorkspaceSourceRevisionResolver
}

// NewWorkspaceLauncher connects the common durable binding to the runtime's
// existing managed-service lifecycle. Only the runtime allocates addresses,
// supplies guest paths, owns processes, and opens isolated control transports.
func NewWorkspaceLauncher(runtime workspaceapi.WorkspaceRuntime, configs ...WorkspaceLauncherConfig) (Launcher, error) {
	if runtime == nil {
		return nil, errors.New("flow host launcher requires a workspace runtime")
	}
	if len(configs) > 1 {
		return nil, errors.New("flow host launcher accepts at most one configuration")
	}
	allowTrustedProcessForTests := len(configs) == 1 && configs[0].AllowTrustedProcessForTests
	if !allowedIsolation(runtime.Isolation(), allowTrustedProcessForTests) {
		return nil, failure{code: "isolation_required"}
	}
	hosts, ok := runtime.(workspaceapi.WorkspaceManagedHosts)
	if !ok || !runtime.Capabilities().ManagedHTTPHosts {
		return nil, errors.New("workspace runtime does not support managed HTTP hosts")
	}
	source, ok := runtime.(workspaceapi.WorkspaceSourceRevisionResolver)
	if !ok || !runtime.Capabilities().SourceRevision {
		return nil, errors.New("workspace runtime does not resolve source revisions")
	}
	return &workspaceLauncher{runtime: runtime, hosts: hosts, source: source, allowTrustedProcessForTests: allowTrustedProcessForTests}, nil
}

func (launcher *workspaceLauncher) Isolation() workspaceapi.IsolationLevel {
	return launcher.runtime.Isolation()
}

func (launcher *workspaceLauncher) requireIsolation() error {
	if !allowedIsolation(launcher.Isolation(), launcher.allowTrustedProcessForTests) {
		return failure{code: "isolation_required"}
	}
	return nil
}

func (launcher *workspaceLauncher) InspectFlowHost(ctx context.Context, launch HostLaunch) (Connection, error) {
	if err := launcher.requireIsolation(); err != nil {
		return Connection{}, err
	}
	spec, err := workspaceHostSpec(launch)
	if err != nil {
		return Connection{}, err
	}
	connection, err := launcher.hosts.InspectManagedHost(hostOperation(ctx, launch.Binding.UserID, launch.Binding.ID, "inspect", launch.Binding.OwnerGeneration), launch.Binding.WorkspaceID, spec)
	if errors.Is(err, workspaceapi.ErrManagedHostNotRunning) {
		return Connection{}, ErrHostNotRunning
	}
	if errors.Is(err, workspaceapi.ErrManagedHostIdentityConflict) {
		return Connection{}, fmt.Errorf("%w: %w", ErrHostIdentityConflict, err)
	}
	return Connection{Endpoint: connection.Endpoint, HTTPClient: connection.HTTPClient}, err
}

func (launcher *workspaceLauncher) StartFlowHost(ctx context.Context, launch HostLaunch) (Connection, error) {
	if err := launcher.requireIsolation(); err != nil {
		return Connection{}, err
	}
	if launch.Superseded {
		return Connection{}, errors.New("a superseded flow host is never started")
	}
	spec, err := workspaceHostSpec(launch)
	if err != nil {
		return Connection{}, err
	}
	connection, err := launcher.hosts.StartManagedHost(hostOperation(ctx, launch.Binding.UserID, launch.Binding.ID, "start", launch.Binding.OwnerGeneration), launch.Binding.WorkspaceID, spec)
	return Connection{Endpoint: connection.Endpoint, HTTPClient: connection.HTTPClient}, err
}

func (launcher *workspaceLauncher) ResolveFlowHostSource(ctx context.Context, authority Authority) (string, error) {
	if err := launcher.requireIsolation(); err != nil {
		return "", err
	}
	if err := validateAuthority(authority.Target, authority); err != nil {
		return "", err
	}
	revision, err := launcher.source.ResolveWorkspaceSourceRevision(hostOperation(ctx, authority.UserID, authority.WorkspaceID, "source", 0), authority.WorkspaceID)
	if err != nil {
		return "", err
	}
	if !lowerHex(revision, 40) {
		return "", errors.New("workspace runtime returned an invalid source revision")
	}
	return revision, nil
}

func (launcher *workspaceLauncher) StopFlowHost(ctx context.Context, binding Binding) error {
	if binding.UserID <= 0 || binding.WorkspaceID == "" || binding.ID == "" || !serviceNamePattern.MatchString(binding.ServiceName) {
		return errors.New("flow host retirement binding is invalid")
	}
	// Use the retained workspace owner, without querying a deleted product row.
	// Runtime NotFound means the actual execution workspace is absent.
	err := launcher.runtime.StopService(hostOperation(ctx, binding.UserID, binding.ID, "retire", binding.OwnerGeneration), binding.WorkspaceID, binding.ServiceName)
	if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return nil
	}
	return err
}

func hostOperation(ctx context.Context, userID int64, id, action string, generation int64) context.Context {
	// Match WorkspaceService's common owner/requester identity. Product Flow
	// target tenant strings (repository:N) are not execution tenant identities.
	user := strconv.FormatInt(userID, 10)
	return workspaceapi.WithOperation(ctx, workspaceapi.Operation{TenantID: user, PrincipalID: user, OperationID: fmt.Sprintf("flow-host:%s:g%d:%s", id, generation, action)})
}

func workspaceHostSpec(launch HostLaunch) (workspaceapi.ManagedHostSpec, error) {
	catalog, err := validateCatalog(launch.Catalog)
	if err != nil {
		return workspaceapi.ManagedHostSpec{}, err
	}
	launch.Catalog = catalog
	if err = validateAuthority(launch.Authority.Target, launch.Authority); err != nil {
		return workspaceapi.ManagedHostSpec{}, err
	}
	identity := hostServiceIdentity(launch)
	if launch.Superseded {
		// The current catalog did not start this host; its recorded
		// fingerprint names it, and the authenticated probe still checks it.
		if err = authorityMatches(launch.Binding, launch.Authority, catalog); err != nil {
			return workspaceapi.ManagedHostSpec{}, err
		}
		if launch.Binding.ServiceIdentity == "" {
			return workspaceapi.ManagedHostSpec{}, errors.New("superseded flow host has no recorded service identity")
		}
		identity = launch.Binding.ServiceIdentity
	} else if err = bindingMatches(launch.Binding, launch.Authority, catalog); err != nil {
		return workspaceapi.ManagedHostSpec{}, err
	}
	if strings.TrimSpace(launch.Credential) == "" {
		return workspaceapi.ManagedHostSpec{}, errors.New("flow host credential is required")
	}
	return workspaceapi.ManagedHostSpec{
		ID: launch.Binding.ID, Name: launch.Binding.ServiceName, Identity: identity, ReadyTimeout: catalog.ReadyTimeout,
		Expected: workspaceapi.ManagedHostIdentity{Protocol: flowruntime.Protocol, ArtifactDigest: launch.Binding.RuntimeArtifactDigest, SourceRevision: launch.Binding.SourceRevision, OwnerGeneration: launch.Binding.OwnerGeneration},
		Builder: workspaceapi.ManagedHostBuilderFunc(func(_ context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
			if placement.Workspace.ID != launch.Binding.WorkspaceID {
				return workspaceapi.Command{}, errors.New("flow host placement belongs to another workspace")
			}
			spec, err := BuildProcessSpec(launch, WorkspacePaths{Root: placement.Workspace.Root, StateDir: placement.StateDir, Host: placement.Host}, placement.Port)
			if err != nil {
				return workspaceapi.Command{}, err
			}
			if spec.ReadyAddress != placement.Address {
				return workspaceapi.Command{}, errors.New("flow host placement address is inconsistent")
			}
			return workspaceapi.Command{Args: spec.Args, Environment: spec.Environment}, nil
		}),
		Probe: workspaceapi.ManagedHostProbeFunc(func(ctx context.Context, connection workspaceapi.ManagedHostConnection) (workspaceapi.ManagedHostIdentity, error) {
			client, err := runtimebridge.New(runtimebridge.Config{Endpoint: connection.Endpoint, HTTPClient: connection.HTTPClient, Credential: launch.Credential})
			if err != nil {
				return workspaceapi.ManagedHostIdentity{}, err
			}
			identity, err := client.Identity(ctx)
			return workspaceapi.ManagedHostIdentity{Protocol: identity.Protocol, ArtifactDigest: identity.RuntimeArtifactDigest, SourceRevision: identity.SourceRevision, OwnerGeneration: identity.OwnerGeneration}, err
		}),
	}, nil
}

var _ IsolationLauncher = (*workspaceLauncher)(nil)
var _ Launcher = (*workspaceLauncher)(nil)
var _ SourceResolver = (*workspaceLauncher)(nil)
var _ RetirementStopper = (*workspaceLauncher)(nil)
