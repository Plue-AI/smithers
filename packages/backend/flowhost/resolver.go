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
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

var (
	catalogKeyPattern  = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
	systemFlowPattern  = regexp.MustCompile(`^[a-z][a-z0-9._-]*(/[a-z][a-z0-9._-]*)*$`)
	serviceNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.@:-]{1,128}$`)
)

var reservedEnvironment = map[string]struct{}{
	SystemFlowsEnv:     {},
	"SMITHERS_API_KEY": {}, "SMITHERS_GATEWAY_ID": {},
	"SMITHERS_OWNER_GENERATION": {}, "SMITHERS_FLOW_ARTIFACT_SHA256": {},
	"SMITHERS_SOURCE_REVISION": {}, "SMITHERS_REPO": {},
	"SMITHERS_CODING_IMPLEMENT_MODEL": {},
	AccountPoolURLEnv:                 {}, AccountPoolProvidersEnv: {}, AccountPoolKeyEnv: {},
}

// startCredentialEnvironment is what a start supplies and no catalog may:
// the box's landing credential and its build-cache read credential
// (HostLaunch.Environment). They are reserved like reservedEnvironment.
var startCredentialEnvironment = map[string]struct{}{
	"SMITHERS_JJHUB_TOKEN": {}, "SMITHERS_JJHUB_API_URL": {},
	"SMITHERS_CACHE_TOKEN": {}, "SMITHERS_CACHE_URL": {},
}

func reservedName(name string) bool {
	_, reserved := reservedEnvironment[name]
	_, minted := startCredentialEnvironment[name]
	return reserved || minted
}

// A host shares its workspace with repository commands, so a database
// credential in its environment is readable by that repository. Hosts keep
// their stores in the workspace state directory.
var databaseEnvironment = map[string]struct{}{
	"SMITHERS_POSTGRES_URL": {}, "SMITHERS_POSTGRES_SCHEMA": {}, "DATABASE_URL": {},
	"SMITHERS_DATABASE_URL": {}, "SMITHERS_BACKEND": {},
}

// Provider credentials reach a host only as the per-binding model credential
// BuildProcessSpec derives for the catalog's proxy seats. A raw provider key
// in the catalog environment would be readable by repository commands (#2187).
func providerCredentialName(name string) bool {
	for _, suffix := range []string{"_API_KEY", "_API_TOKEN", "_AUTH_TOKEN", "_OAUTH_TOKEN", "_ACCESS_TOKEN"} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

type Resolver struct {
	allowTrustedProcessForTests bool
	store                       BindingStore
	targets                     TargetResolver
	launcher                    Launcher
	catalogs                    map[string]Catalog
	activeRuns                  ActiveRuns
	journals                    Journals
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
	return &Resolver{store: config.Store, targets: config.Targets, launcher: config.Launcher, catalogs: catalogs,
		activeRuns: config.ActiveRuns, journals: config.Journals, allowTrustedProcessForTests: config.AllowTrustedProcessForTests}, nil
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
	if catalog.Family != CatalogCoding {
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
	if len(catalog.SystemFlows) == 0 {
		return Catalog{}, failure{code: "runtime_catalog_invalid", cause: fmt.Errorf("flow host catalog %q requires system flow names", catalog.Key)}
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
		if reservedName(name) {
			return Catalog{}, fmt.Errorf("flow host catalog %q environment replaces reserved identity %s", catalog.Key, name)
		}
		if _, database := databaseEnvironment[name]; database {
			return Catalog{}, fmt.Errorf("flow host catalog %q environment carries database configuration %s", catalog.Key, name)
		}
		if providerCredentialName(name) {
			return Catalog{}, fmt.Errorf("flow host catalog %q environment carries provider credential %s; use platform model keys", catalog.Key, name)
		}
		copyEnvironment[name] = value
	}
	catalog.Environment = copyEnvironment
	catalog.ModelSeats = slices.Clone(catalog.ModelSeats)
	catalog.SystemFlows = slices.Clone(catalog.SystemFlows)
	names := make(map[string]struct{}, len(catalog.SystemFlows))
	for _, name := range catalog.SystemFlows {
		if len(name) > 256 || !systemFlowPattern.MatchString(name) {
			return Catalog{}, fmt.Errorf("flow host catalog %q system flow name is invalid", catalog.Key)
		}
		if _, duplicate := names[name]; duplicate {
			return Catalog{}, fmt.Errorf("flow host catalog %q system flow name %q is duplicated", catalog.Key, name)
		}
		names[name] = struct{}{}
	}
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
	isolation, ok := resolver.launcher.(IsolationLauncher)
	if !ok || !allowedIsolation(isolation.Isolation(), resolver.allowTrustedProcessForTests) {
		return nil, failure{code: "isolation_required"}
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
	if errors.Is(err, ErrHostBusy) {
		return nil, failure{code: "runtime_host_starting", retryable: true}
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
		client, kept, err := resolver.keepSuperseded(ctx, lease, superseded, authority, catalog)
		if kept || err != nil {
			return client, err
		}
		if existingOnly {
			return nil, failure{code: "runtime_upgrade_required"}
		}
		binding, err = resolver.rebind(ctx, lease, superseded)
		if err != nil {
			return nil, err
		}
	}
	launch := HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: lease.Credential()}
	if resolver.journals != nil {
		if launch.Journal, err = resolver.journals.Describe(binding.WorkspaceID); err != nil {
			return nil, refuse(ctx, "runtime_journal_unavailable", err, binding)
		}
	}
	connection, inspectErr := resolver.launcher.InspectFlowHost(ctx, launch)
	if inspectErr == nil {
		client, err := resolver.verifiedClient(ctx, connection, lease.Credential(), binding)
		if err != nil {
			// A process answered at this binding, so starting another would create
			// two owners. Retry/probe or surface its identity refusal instead.
			return nil, err
		}
		if !existingOnly {
			if err := lease.MarkRunning(ctx, hostServiceIdentity(launch)); err != nil {
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
	launch = HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: lease.Credential()}
	if resolver.journals != nil {
		// The workspace's database and role exist before its host opens them.
		if launch.Journal, err = resolver.journals.Provision(ctx, binding.WorkspaceID); err != nil {
			return nil, startFailed(ctx, lease, binding, refuse(ctx, "runtime_journal_unavailable", err, binding))
		}
	}
	connection, err = resolver.launcher.StartFlowHost(ctx, launch)
	if err != nil {
		return nil, startFailed(ctx, lease, binding, refuse(ctx, "runtime_start_failed", err, binding))
	}
	client, err := resolver.verifiedClient(ctx, connection, lease.Credential(), binding)
	if err != nil {
		resolver.abandon(ctx, binding)
		return nil, startFailed(ctx, lease, binding, err)
	}
	if err := lease.MarkRunning(ctx, hostServiceIdentity(launch)); err != nil {
		resolver.abandon(ctx, binding)
		return nil, failure{code: "runtime_binding_checkpoint_failed", retryable: true}
	}
	return client, nil
}

// StartAbandoner releases what a launcher gave a start the resolver then
// refused (its per-start credentials), whether or not the process stays up.
type StartAbandoner interface {
	AbandonFlowHostStart(context.Context, Binding)
}

func (resolver *Resolver) abandon(ctx context.Context, binding Binding) {
	if abandoner, ok := resolver.launcher.(StartAbandoner); ok {
		abandoner.AbandonFlowHostStart(context.WithoutCancel(ctx), binding)
	}
}

// keepSuperseded serves a superseded host while a run or an approval-parked
// plan depends on it (plue#538), so an upgrade never stops live work. It
// reports kept=false when the host may be replaced now: no work depends on
// it, it is already gone, or it predates recorded service identities.
// Work for another source revision cannot use the old host, so it waits,
// retryably, until the dependent work settles.
func (resolver *Resolver) keepSuperseded(ctx context.Context, lease BindingLease, superseded Binding, authority Authority, catalog Catalog) (flowruntime.Runtime, bool, error) {
	if resolver.activeRuns == nil {
		return nil, false, nil
	}
	active, err := resolver.activeRuns.ActiveFlowRuns(ctx, superseded)
	if err != nil {
		return nil, false, refuse(ctx, "runtime_activity_unavailable", err, superseded)
	}
	if !active {
		return nil, false, nil
	}
	if superseded.ServiceIdentity == "" {
		slog.WarnContext(ctx, "flow host upgrade replaces a host with active runs; it has no recorded service identity",
			"binding_id", superseded.ID, "workspace_id", superseded.WorkspaceID)
		return nil, false, nil
	}
	connection, err := resolver.launcher.InspectFlowHost(ctx, HostLaunch{
		Binding: superseded, Authority: authority, Catalog: catalog, Credential: lease.Credential(), Superseded: true,
	})
	if errors.Is(err, ErrHostNotRunning) {
		return nil, false, nil
	}
	if errors.Is(err, ErrHostIdentityConflict) {
		// The recorded identity does not name the live process, so it can
		// never be reached; waiting would wedge the run that depends on it.
		slog.WarnContext(ctx, "flow host upgrade replaces a host with active runs; its recorded service identity is stale",
			"binding_id", superseded.ID, "workspace_id", superseded.WorkspaceID)
		return nil, false, nil
	}
	if err != nil {
		return nil, false, refuse(ctx, "runtime_inspection_failed", err, superseded)
	}
	if authority.SourceRevision != "" && authority.SourceRevision != superseded.SourceRevision {
		return nil, false, failure{code: "runtime_upgrade_pending", retryable: true}
	}
	client, err := resolver.verifiedClient(ctx, connection, lease.Credential(), superseded)
	if err != nil {
		return nil, false, err
	}
	return client, true, nil
}

// rebind replaces a host whose pinned identity drifted from the catalog (for
// example a host-bundle upgrade) once no run depends on it. The superseded
// service is stopped before the row moves, so the new owner never meets a live
// process under its name with an older fingerprint. A run pinned to a host
// that was already gone fails typed in dispatch.
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
	// cause is the refusal a launcher answered, kept for a caller that
	// renders a product refusal (a plan limit). Error never includes it.
	cause error
}

func (value failure) Error() string { return "flow host: " + value.code }
func (value failure) Unwrap() error { return value.cause }
func (value failure) FlowRuntimeClass() string {
	if value.code == "isolation_required" || value.code == "runtime_catalog_invalid" {
		return "infra"
	}
	return ""
}
func (value failure) FlowRuntimeCode() string    { return value.code }
func (value failure) FlowRuntimeRetryable() bool { return value.retryable }

func sanitizeFailure(fallback string, err error) error {
	var known flowruntime.Failure
	if errors.As(err, &known) {
		code := strings.TrimSpace(known.FlowRuntimeCode())
		if code == "" {
			code = fallback
		}
		return failure{code: code, retryable: known.FlowRuntimeRetryable(), cause: err}
	}
	return failure{code: fallback, retryable: true, cause: err}
}

var _ flowruntime.Resolver = (*Resolver)(nil)
var _ flowruntime.Failure = failure{}

// Test configuration permits only the known process adapter, never an unknown
// deployment whose isolation contract is absent or incomplete.
func allowedIsolation(level workspaceapi.IsolationLevel, allowTrustedProcessForTests bool) bool {
	return level == workspaceapi.IsolationSandboxed ||
		(allowTrustedProcessForTests && level == workspaceapi.IsolationTrustedProcess)
}
