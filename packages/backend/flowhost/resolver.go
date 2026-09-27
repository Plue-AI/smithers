package flowhost

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
)

var (
	catalogKeyPattern  = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
	serviceNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.@:-]{1,128}$`)
)

var reservedEnvironment = map[string]struct{}{
	"SMITHERS_API_KEY": {}, "SMITHERS_GATEWAY_ID": {},
	"SMITHERS_OWNER_GENERATION": {}, "SMITHERS_FLOW_ARTIFACT_SHA256": {},
	"SMITHERS_SOURCE_REVISION": {}, "SMITHERS_REPO": {},
	"SMITHERS_CODING_IMPLEMENT_MODEL": {},
	AccountPoolURLEnv:                 {}, AccountPoolProvidersEnv: {}, AccountPoolKeyEnv: {},
}

// A host shares its workspace with repository commands, so a database
// credential in its environment is readable by that repository. Hosts keep
// their stores in the workspace state directory.
var databaseEnvironment = map[string]struct{}{
	"SMITHERS_POSTGRES_URL": {}, "SMITHERS_POSTGRES_SCHEMA": {}, "DATABASE_URL": {},
	"SMITHERS_DATABASE_URL": {}, "SMITHERS_BACKEND": {},
}

type Resolver struct {
	store    BindingStore
	targets  TargetResolver
	launcher Launcher
	catalogs map[string]Catalog
}

func New(config Config) (*Resolver, error) {
	if config.Store == nil || config.Targets == nil || config.Launcher == nil {
		return nil, errors.New("flow host resolver requires store, target resolver, and launcher")
	}
	catalogs := make(map[string]Catalog, len(config.Catalogs))
	for _, catalog := range config.Catalogs {
		validated, err := validateCatalog(catalog)
		if err != nil {
			return nil, err
		}
		if _, duplicate := catalogs[validated.Key]; duplicate {
			return nil, fmt.Errorf("flow host catalog %q is duplicated", validated.Key)
		}
		catalogs[validated.Key] = validated
	}
	if len(catalogs) == 0 {
		return nil, errors.New("flow host resolver requires at least one catalog")
	}
	return &Resolver{store: config.Store, targets: config.Targets, launcher: config.Launcher, catalogs: catalogs}, nil
}

func validateCatalog(catalog Catalog) (Catalog, error) {
	catalog.Key = strings.TrimSpace(catalog.Key)
	catalog.Family = strings.TrimSpace(catalog.Family)
	catalog.Executable = strings.TrimSpace(catalog.Executable)
	catalog.ServiceName = strings.TrimSpace(catalog.ServiceName)
	catalog.ImplementationModel = strings.TrimSpace(catalog.ImplementationModel)
	if !catalogKeyPattern.MatchString(catalog.Key) {
		return Catalog{}, errors.New("flow host catalog key is invalid")
	}
	if catalog.Family != CatalogCoding && catalog.Family != CatalogLibrarian {
		return Catalog{}, fmt.Errorf("flow host catalog %q has an unsupported family", catalog.Key)
	}
	if !filepath.IsAbs(catalog.Executable) {
		return Catalog{}, fmt.Errorf("flow host catalog %q executable must be absolute", catalog.Key)
	}
	if !serviceNamePattern.MatchString(catalog.ServiceName) {
		return Catalog{}, fmt.Errorf("flow host catalog %q service name is invalid", catalog.Key)
	}
	if !lowerHex(catalog.ArtifactDigest, 64) {
		return Catalog{}, fmt.Errorf("flow host catalog %q immutable identity is invalid", catalog.Key)
	}
	if catalog.ReadyTimeout <= 0 {
		catalog.ReadyTimeout = 30 * time.Second
	}
	if catalog.ImplementationModel != "" && !explicitModel(catalog.ImplementationModel) {
		return Catalog{}, fmt.Errorf("flow host catalog %q model must be provider:model", catalog.Key)
	}
	copyEnvironment := make(map[string]string, len(catalog.Environment))
	for name, value := range catalog.Environment {
		if strings.TrimSpace(name) != name || name == "" || strings.ContainsAny(name, "=\x00") || strings.IndexByte(value, 0) >= 0 {
			return Catalog{}, fmt.Errorf("flow host catalog %q environment is invalid", catalog.Key)
		}
		if _, reserved := reservedEnvironment[name]; reserved {
			return Catalog{}, fmt.Errorf("flow host catalog %q environment replaces reserved identity %s", catalog.Key, name)
		}
		if _, database := databaseEnvironment[name]; database {
			return Catalog{}, fmt.Errorf("flow host catalog %q environment carries database configuration %s", catalog.Key, name)
		}
		copyEnvironment[name] = value
	}
	catalog.Environment = copyEnvironment
	catalog.ModelSeats = slices.Clone(catalog.ModelSeats)
	for name, value := range map[string]string{"model proxy": catalog.ModelProxyURL, "account pool": catalog.AccountPoolURL} {
		if value == "" {
			continue
		}
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" {
			return Catalog{}, fmt.Errorf("flow host catalog %q %s URL is invalid", catalog.Key, name)
		}
	}
	return catalog, nil
}

func explicitModel(value string) bool {
	provider, model, ok := strings.Cut(value, ":")
	return ok && provider != "" && model != "" && !strings.ContainsAny(value, " \t\r\n")
}

func lowerHex(value string, length int) bool {
	if len(value) != length || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validateAuthority(target flowruntime.Target, authority Authority) error {
	if authority.Target != target || strings.TrimSpace(target.TenantID) == "" || strings.TrimSpace(target.PrincipalID) == "" ||
		strings.TrimSpace(target.BindingKind) == "" || strings.TrimSpace(target.BindingID) == "" {
		return failure{code: "runtime_target_forbidden"}
	}
	if authority.RepositoryID <= 0 || authority.UserID <= 0 || strings.TrimSpace(authority.WorkspaceID) == "" || strings.TrimSpace(authority.CatalogKey) == "" {
		return failure{code: "runtime_target_invalid"}
	}
	workspaceID, err := uuid.Parse(authority.WorkspaceID)
	if err != nil || workspaceID.String() != authority.WorkspaceID {
		return failure{code: "runtime_target_invalid"}
	}
	if authority.SourceRevision != "" && !lowerHex(authority.SourceRevision, 40) {
		return failure{code: "runtime_source_revision_invalid"}
	}
	if target.WorkspaceID != "" && target.WorkspaceID != authority.WorkspaceID {
		return failure{code: "runtime_workspace_replaced"}
	}
	return nil
}

func (resolver *Resolver) ResolveFlowRuntime(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
	return resolver.resolve(ctx, target, false)
}

func (resolver *Resolver) ResolveExistingFlowRuntime(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
	return resolver.resolve(ctx, target, true)
}

func (resolver *Resolver) resolve(ctx context.Context, target flowruntime.Target, existingOnly bool) (flowruntime.Runtime, error) {
	if resolver == nil || resolver.store == nil || resolver.targets == nil || resolver.launcher == nil {
		return nil, failure{code: "runtime_resolver_unavailable", retryable: true}
	}
	authority, err := resolver.targets.ResolveFlowHostTarget(ctx, target)
	if err != nil {
		return nil, refuse(ctx, "runtime_binding_unavailable", err, Binding{WorkspaceID: target.WorkspaceID})
	}
	if err := validateAuthority(target, authority); err != nil {
		return nil, err
	}
	catalog, ok := resolver.catalogs[authority.CatalogKey]
	if !ok {
		return nil, failure{code: "runtime_catalog_unavailable"}
	}
	acquire := resolver.store.Acquire
	if existingOnly {
		store, ok := resolver.store.(ExistingBindingStore)
		if !ok {
			return nil, failure{code: "runtime_read_unavailable"}
		}
		acquire = store.AcquireExisting
	}
	lease, err := acquire(ctx, authority, catalog)
	if errors.Is(err, ErrHostNotRunning) {
		return nil, failure{code: "runtime_host_not_running"}
	}
	if !existingOnly && errors.Is(err, ErrSourceRevisionRequired) {
		source, ok := resolver.launcher.(SourceResolver)
		if !ok {
			return nil, failure{code: "runtime_source_revision_unavailable"}
		}
		authority.SourceRevision, err = source.ResolveFlowHostSource(ctx, authority)
		if err != nil {
			return nil, refuse(ctx, "runtime_source_revision_unavailable", err, Binding{WorkspaceID: authority.WorkspaceID, CatalogKey: authority.CatalogKey})
		}
		if !lowerHex(authority.SourceRevision, 40) {
			return nil, failure{code: "runtime_source_revision_invalid"}
		}
		lease, err = resolver.store.Acquire(ctx, authority, catalog)
	}
	if err != nil {
		return nil, refuse(ctx, "runtime_binding_unavailable", err, Binding{WorkspaceID: authority.WorkspaceID, CatalogKey: authority.CatalogKey})
	}
	defer lease.Close() // best effort: caller error takes precedence over unlock diagnostics.

	binding := lease.Binding()
	if superseded, ok := lease.Supersedes(); ok {
		if existingOnly {
			return nil, failure{code: "runtime_upgrade_required"}
		}
		binding, err = resolver.rebind(ctx, lease, superseded)
		if err != nil {
			return nil, err
		}
	}
	connection, inspectErr := resolver.launcher.InspectFlowHost(ctx, HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: lease.Credential()})
	if inspectErr == nil {
		client, err := resolver.verifiedClient(ctx, connection, lease.Credential(), binding)
		if err != nil {
			// A process answered at this binding, so starting another would create
			// two owners. Retry/probe or surface its identity refusal instead.
			return nil, err
		}
		if !existingOnly {
			if err := lease.MarkRunning(ctx); err != nil {
				return nil, failure{code: "runtime_binding_checkpoint_failed", retryable: true}
			}
		}
		return client, nil
	}
	if !errors.Is(inspectErr, ErrHostNotRunning) {
		return nil, refuse(ctx, "runtime_inspection_failed", inspectErr, binding)
	}
	if existingOnly {
		return nil, failure{code: "runtime_host_not_running"}
	}

	replaceOwner := binding.State == "running" || binding.State == "failed"
	binding, err = lease.PrepareStart(ctx, replaceOwner)
	if err != nil {
		return nil, refuse(ctx, "runtime_owner_fence_failed", err, binding)
	}
	connection, err = resolver.launcher.StartFlowHost(ctx, HostLaunch{
		Binding: binding, Authority: authority, Catalog: catalog, Credential: lease.Credential(),
	})
	if err != nil {
		return nil, startFailed(ctx, lease, binding, refuse(ctx, "runtime_start_failed", err, binding))
	}
	client, err := resolver.verifiedClient(ctx, connection, lease.Credential(), binding)
	if err != nil {
		return nil, startFailed(ctx, lease, binding, err)
	}
	if err := lease.MarkRunning(ctx); err != nil {
		return nil, failure{code: "runtime_binding_checkpoint_failed", retryable: true}
	}
	return client, nil
}

// rebind replaces a host whose pinned identity drifted from the catalog (for
// example a host-bundle upgrade). The superseded service is stopped before the
// row moves, so the new owner never meets a live process under its name with
// an older fingerprint. Runs pinned to the old identity fail typed in dispatch.
func (resolver *Resolver) rebind(ctx context.Context, lease BindingLease, superseded Binding) (Binding, error) {
	stopper, ok := resolver.launcher.(RetirementStopper)
	if !ok {
		return superseded, refuse(ctx, "runtime_upgrade_unsupported", failure{code: "runtime_upgrade_unsupported"}, superseded)
	}
	if err := stopper.StopFlowHost(ctx, superseded); err != nil {
		return superseded, refuse(ctx, "runtime_upgrade_stop_failed", err, superseded)
	}
	binding, err := lease.Rebind(ctx)
	if err != nil {
		return superseded, refuse(ctx, "runtime_owner_fence_failed", err, superseded)
	}
	slog.InfoContext(ctx, "flow host rebound", "binding_id", binding.ID, "workspace_id", binding.WorkspaceID,
		"catalog", binding.CatalogKey, "old_artifact", superseded.RuntimeArtifactDigest, "new_artifact", binding.RuntimeArtifactDigest,
		"old_service", superseded.ServiceName, "new_service", binding.ServiceName,
		"old_source_revision", superseded.SourceRevision, "new_source_revision", binding.SourceRevision,
		"owner_generation", binding.OwnerGeneration)
	return binding, nil
}

func (resolver *Resolver) verifiedClient(ctx context.Context, connection Connection, credential string, binding Binding) (*runtimebridge.Client, error) {
	client, err := runtimebridge.New(runtimebridge.Config{
		Endpoint: connection.Endpoint, Credential: credential, HTTPClient: connection.HTTPClient,
	})
	if err != nil {
		return nil, failure{code: "runtime_endpoint_invalid"}
	}
	identity, err := client.Identity(ctx)
	if err != nil {
		return nil, refuse(ctx, "runtime_identity_unavailable", err, binding)
	}
	if identity.Protocol != flowruntime.Protocol || identity.RuntimeArtifactDigest != binding.RuntimeArtifactDigest ||
		identity.SourceRevision != binding.SourceRevision || identity.OwnerGeneration != binding.OwnerGeneration {
		slog.ErrorContext(ctx, "flow host identity conflict", "binding_id", binding.ID, "workspace_id", binding.WorkspaceID,
			"want_generation", binding.OwnerGeneration, "got_generation", identity.OwnerGeneration,
			"want_artifact", binding.RuntimeArtifactDigest, "got_artifact", identity.RuntimeArtifactDigest)
		return nil, failure{code: "runtime_identity_conflict"}
	}
	return client, nil
}

// startFailed durably records a failed start so the next start bumps the
// owner generation and fences any host that comes up late.
func startFailed(ctx context.Context, lease BindingLease, binding Binding, result error) error {
	code := "runtime_start_failed"
	var known flowruntime.Failure
	if errors.As(result, &known) {
		code = known.FlowRuntimeCode()
	}
	if err := lease.MarkFailed(context.WithoutCancel(ctx), code); err != nil {
		slog.ErrorContext(ctx, "flow host failure checkpoint failed", "binding_id", binding.ID,
			"workspace_id", binding.WorkspaceID, "owner_generation", binding.OwnerGeneration, "error", err)
	}
	return result
}

// logFailure keeps the server-side cause that sanitizeFailure hides from
// callers, with the binding that failed.
func logFailure(ctx context.Context, result error, cause error, binding Binding) {
	slog.ErrorContext(ctx, "flow host failed", "code", result.Error(), "binding_id", binding.ID,
		"workspace_id", binding.WorkspaceID, "catalog", binding.CatalogKey,
		"owner_generation", binding.OwnerGeneration, "error", cause)
}

// refuse sanitizes err for the caller and logs the cause server-side.
func refuse(ctx context.Context, fallback string, err error, binding Binding) error {
	result := sanitizeFailure(fallback, err)
	logFailure(ctx, result, err, binding)
	return result
}

type failure struct {
	code      string
	retryable bool
}

func (value failure) Error() string              { return "flow host: " + value.code }
func (value failure) FlowRuntimeCode() string    { return value.code }
func (value failure) FlowRuntimeRetryable() bool { return value.retryable }

func sanitizeFailure(fallback string, err error) error {
	var known flowruntime.Failure
	if errors.As(err, &known) {
		code := strings.TrimSpace(known.FlowRuntimeCode())
		if code == "" {
			code = fallback
		}
		return failure{code: code, retryable: known.FlowRuntimeRetryable()}
	}
	return failure{code: fallback, retryable: true}
}

var _ flowruntime.Resolver = (*Resolver)(nil)
var _ flowruntime.Failure = failure{}
