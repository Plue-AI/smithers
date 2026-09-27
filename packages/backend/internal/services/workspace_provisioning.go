package services

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services/workspace_scripts"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// bootstrapVars holds the dynamic values injected into the bootstrap shell template.
type bootstrapVars struct {
	User                string
	Home                string
	LocalDir            string
	LocalBinDir         string
	LocalNodeDir        string
	JJReleaseAPIURL     string
	NodeDistIndexURL    string
	NodeMajor           string
	NodeInstallLog      string
	ClaudeInstallScript string
	DownloadScript      string // base64-encoded TypeScript
	CLIB64Path          string
	CLIPath             string
	CodingHostB64Path   string
	CodingHostPath      string
	JJExportB64Path     string
	JJExportPath        string
	BunVersion          string
	PackInitScript      string
}

var bootstrapTmpl = template.Must(template.New("bootstrap").Parse(workspace_scripts.BootstrapTemplate))

type workspaceGzipWriteCloser interface {
	io.Writer
	Close() error
}

var newWorkspaceGzipWriter = func(w io.Writer) workspaceGzipWriteCloser {
	return gzip.NewWriter(w)
}

func buildWorkspaceClaudeBootstrapScript() string {
	downloadScript := base64.StdEncoding.EncodeToString([]byte(workspace_scripts.DownloadReleaseScript))

	// These scripts are rendered into `bash -lc {{printf "%q" .Script}}`. Go's %q
	// escapes a newline to the two-character sequence \n, which bash inside a
	// double-quoted -lc argument does NOT re-interpret — it would collapse a
	// newline-joined script into one broken command ("set: pipefailnexport:
	// invalid option name"). Join with "; " so the whole thing is a single valid
	// line; every statement here is a simple command (no comments), so `set -e`
	// semantics are unchanged.
	claudeInstallScript := strings.Join([]string{
		"set -euo pipefail",
		fmt.Sprintf("export PATH=%q", workspaceLocalBinDir+":/usr/local/bin:/usr/bin:/bin"),
		fmt.Sprintf("export NPM_CONFIG_PREFIX=%q", workspaceLocalDir),
		fmt.Sprintf("npm install -g %q >%s 2>&1", workspaceClaudePackage, workspaceClaudeInstallLog),
	}, "; ")

	// Installs the global smithers workflow pack into the developer user's
	// ~/.smithers via the staged CLI binary. PATH includes /usr/local/bin so
	// the pack's default `bun install` finds the bun installed above (init
	// degrades gracefully if bun is missing). SMITHERS_YES=1 is the
	// non-interactive switch for the pinned CLI.
	packInitScript := strings.Join([]string{
		"set -euo pipefail",
		fmt.Sprintf("export PATH=%q", workspaceLocalBinDir+":/usr/local/bin:/usr/bin:/bin"),
		"export SMITHERS_YES=1",
		fmt.Sprintf("%q init --global --no-skill >%s 2>&1", workspaceSmithersCLIPath, workspaceGlobalPackInitLog),
	}, "; ")

	vars := bootstrapVars{
		User:                defaultWorkspaceUser,
		Home:                defaultWorkspaceHome,
		LocalDir:            workspaceLocalDir,
		LocalBinDir:         workspaceLocalBinDir,
		LocalNodeDir:        workspaceLocalNodeDir,
		JJReleaseAPIURL:     workspaceJJReleaseAPIURL,
		NodeDistIndexURL:    workspaceNodeDistIndexURL,
		NodeMajor:           workspaceNodeMajor,
		NodeInstallLog:      workspaceNodeInstallLog,
		ClaudeInstallScript: claudeInstallScript,
		DownloadScript:      downloadScript,
		CLIB64Path:          workspaceSmithersCLIB64Path,
		CLIPath:             workspaceSmithersCLIPath,
		CodingHostB64Path:   workspaceCodingHostB64Path,
		CodingHostPath:      workspaceCodingHostPath,
		JJExportB64Path:     workspaceJJExportB64Path,
		JJExportPath:        workspaceJJExportPath,
		BunVersion:          workspaceBunVersion,
		PackInitScript:      packInitScript,
	}

	var buf bytes.Buffer
	if err := bootstrapTmpl.Execute(&buf, vars); err != nil {
		panic("workspace bootstrap template: " + err.Error())
	}
	return buf.String()
}

func workspaceCLIBinaryPath() string {
	if configured := strings.TrimSpace(os.Getenv(workspaceCLIBinaryEnv)); configured != "" {
		return configured
	}
	return workspaceDefaultCLIPath
}

func addWorkspaceSmithersCLI(files map[string]sandbox.SandboxFile) bool {
	return addWorkspaceExecutable(files, workspaceCLIBinaryPath(), workspaceSmithersCLIB64Path, workspaceCLIBinaryEnv, "cli")
}

func addWorkspaceCodingHost(files map[string]sandbox.SandboxFile) bool {
	path := strings.TrimSpace(os.Getenv(workspaceCodingHostBinaryEnv))
	if path == "" {
		path = workspaceCodingHostPath
	}
	return addWorkspaceExecutable(files, path, workspaceCodingHostB64Path, workspaceCodingHostBinaryEnv, "coding host")
}

// addWorkspaceJJExport stages the native jj helper the coding host's flows exec
// as /usr/local/bin/smithers-jj-export. Missing payloads only warn: the helper
// is a coding-flow dependency, not a provisioning precondition.
func addWorkspaceJJExport(files map[string]sandbox.SandboxFile) bool {
	path := strings.TrimSpace(os.Getenv(workspaceJJExportBinaryEnv))
	if path == "" {
		path = workspaceDefaultJJExportPath
	}
	return addWorkspaceExecutable(files, path, workspaceJJExportB64Path, workspaceJJExportBinaryEnv, "jj export helper")
}

// Both private host and general CLI reuse the existing single-file guest transport.
func addWorkspaceExecutable(files map[string]sandbox.SandboxFile, cliPath, target, env, label string) bool {
	raw, err := os.ReadFile(cliPath)
	if err != nil || len(raw) == 0 {
		reason := "read_failed"
		if err == nil {
			reason = "empty_payload"
		}
		slog.Warn("workspace smithers "+label+" payload unavailable",
			"reason", reason,
			"configured_path", strings.TrimSpace(os.Getenv(env)) != "",
			"error_type", fmt.Sprintf("%T", err),
		)
		return false
	}
	var compressed bytes.Buffer
	gz := newWorkspaceGzipWriter(&compressed)
	if _, err := gz.Write(raw); err != nil {
		_ = gz.Close()
		slog.Warn("workspace smithers "+label+" payload unavailable",
			"reason", "compress_failed",
			"configured_path", strings.TrimSpace(os.Getenv(env)) != "",
			"error_type", fmt.Sprintf("%T", err),
		)
		return false
	}
	if err := gz.Close(); err != nil {
		slog.Warn("workspace smithers "+label+" payload unavailable",
			"reason", "compress_failed",
			"configured_path", strings.TrimSpace(os.Getenv(env)) != "",
			"error_type", fmt.Sprintf("%T", err),
		)
		return false
	}
	files[target] = sandbox.SandboxFile{
		Content: base64.StdEncoding.EncodeToString(compressed.Bytes()),
	}
	slog.Info("workspace smithers "+label+" payload staged", "bytes", len(raw), "compressed_bytes", compressed.Len())
	return true
}

// freshWorkspaceVMRequest is the create request for a brand-new workspace VM:
// it boots from the golden toolchain snapshot when one is ready (bare base
// image otherwise, exactly the old behavior). On snapshot boots the apt deps
// are skipped — they are baked into the image, and re-running sandbox provider's
// post-boot apt would only slow the boot back down.
func (s *WorkspaceService) freshWorkspaceVMRequest(ctx context.Context, repositoryID int64, workspaceID, kind string) (sandbox.CreateRequest, error) {
	snapshotID := s.goldenSnapshots.Current(ctx)
	if sandboxKindForWorkspace(kind) != "container" {
		// Non-empty means "use the closure's golden snapshot if ready"; the
		// container toolchain snapshot never boots a NixOS image.
		snapshotID = "closure"
	}
	req, err := s.buildWorkspaceVMRequest(ctx, snapshotID, nil, repositoryID, workspaceID, kind)
	if err != nil {
		return sandbox.CreateRequest{}, err
	}
	if strings.TrimSpace(req.SnapshotID) != "" {
		req.Packages = nil
	}
	return req, nil
}

// createWorkspaceVMAttempt gives each create attempt a deadline appropriate to
// its work. Snapshot boots have no package install and must leave room for a
// fallback; bare boots synchronously materialize the image and install packages.
// The caller's longer context still owns the complete provision, including a
// golden-snapshot failure followed by a bare-image retry.
func (s *WorkspaceService) createWorkspaceVMAttempt(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	timeout := workspaceBareVMCreateAttemptTimeout
	if strings.TrimSpace(req.SnapshotID) != "" {
		timeout = workspaceGoldenVMCreateAttemptTimeout
	}
	createCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return s.sandbox.CreateSandbox(createCtx, req)
}

// forkWorkspaceSandbox bounds a single fork operation so callers can
// either fail promptly (explicit ForkWorkspace) or retain time for a cold
// create+clone fallback (derived-workspace open).
//
// kind is the workspace kind the child serves. The child is a fresh sandbox,
// so it is sized from the kind exactly like a cold create (see
// workspaceSizeForKind); without that it is admitted and booted at the
// provider defaults, 512 MiB and 1 vCPU.
func (s *WorkspaceService) forkWorkspaceSandbox(ctx context.Context, sourceVMID, kind string, egress *sandbox.EgressProxyPolicy) (sandbox.CreateResult, error) {
	forkCtx, cancel := context.WithTimeout(ctx, workspaceForkTimeout)
	defer cancel()
	memoryMB, vcpuCount := s.workspaceSizeForKind(kind)
	// RFD-004: the child is a fresh sandbox with a fresh network; it needs
	// its own proxy policy or it boots with no proxy at all.
	return s.sandbox.ForkSandbox(forkCtx, sourceVMID, sandbox.ForkRequest{
		IdleTimeoutSeconds: &s.workspaceIdleTimeoutSeconds,
		Persistence: &sandbox.PersistencePolicy{
			Type:     s.workspacePersistence,
			Priority: &s.workspacePersistencePriority,
		},
		Workdir:     defaultWorkspaceClonePath,
		EgressProxy: egress,
		MemSizeMB:   memoryMB,
		VCPUCount:   vcpuCount,
		Kind:        sandboxKindForWorkspace(kind),
	})
}

// workspaceSizeForKind is the guest size a workspace of this kind gets on
// every provisioning path, cold create and fork alike. Desktop sizing lives
// in applyWorkspaceDesktopBoot; desktops never fork.
func (s *WorkspaceService) workspaceSizeForKind(kind string) (memoryMB, vcpuCount *int32) {
	switch normalizeWorkspaceKind(kind) {
	case "vm", "container":
		return &s.workspaceMemoryMB, &s.workspaceVCPUCount
	case "agent":
		return &s.agentMemoryMB, &s.agentVCPUCount
	}
	return nil, nil
}

// workspaceKindForksCleanly reports whether a workspace of this kind can be
// provisioned by forking another guest.
//
// Only containers can. forkWorkspaceSandbox sizes the child from the kind,
// but the fork child still boots under the container sleep-loop entrypoint.
// A NixOS guest (kind=vm/desktop) booted that way is a dead box whatever its
// size, and a desktop additionally loses the smithers-desktop.target bootstrap
// that applyWorkspaceDesktopBoot puts on every desktop create. Declining sends
// the caller to the cold create path, which builds a correctly booted guest
// from the kind.
func workspaceKindForksCleanly(kind string) bool {
	return sandboxKindForWorkspace(kind) == "container"
}

// workspaceProvisionAttempt scopes an attempt label to the workspace's
// provisioning generation, which is what makes a replacement sandbox a NEW
// logical operation instead of a replay of the create that already succeeded.
//
// sandboxProvisionContext hashes (action, resource kind, resource id, attempt)
// into the controller Idempotency-Key. Before the generation was folded in, a
// reprovision after a lost VM re-derived the ORIGINAL create's key — same
// workspace id, same "bare"/"golden-<id>" label — while sending a different
// body (fresh image/closure, fresh sandbox name). The controller compares the
// request digest bound to the key and answered 409 idempotency_conflict, so
// the workspace died 'failed' and every later open reported "workspace VM has
// not been provisioned" forever (prod, 2026-09-15). The generation only
// advances on a reprovision, so a retry WITHIN one attempt still presents the
// same key and converges on a single sandbox.
func workspaceProvisionAttempt(generation int32, attempt string) string {
	return "gen" + strconv.FormatInt(int64(generation), 10) + "-" + attempt
}

// createFreshWorkspaceVM boots a brand-new workspace VM from the golden
// snapshot, falling back to the bare base image when the snapshot boot fails —
// golden snapshots are an accelerator, not a dependency, so a bad snapshot must
// never fail a provision. If the bare boot succeeds after a snapshot-specific
// create failure, the snapshot is implicated and invalidated.
func (s *WorkspaceService) createFreshWorkspaceVM(ctx context.Context, repositoryID int64, workspaceID string, generation int32, kind string, bindings ...*workspaceProviderBinding) (sandbox.CreateResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	req, err := s.freshWorkspaceVMRequest(ctx, repositoryID, workspaceID, kind)
	if err != nil {
		return sandbox.CreateResult{}, err
	}
	if len(bindings) > 0 {
		bindings[0].apply(&req)
	}
	attempt := "bare"
	if strings.TrimSpace(req.SnapshotID) != "" {
		attempt = "golden-" + req.SnapshotID
	}
	createCtx := sandboxProvisionContext(ctx, "create", "workspace", workspaceID, workspaceProvisionAttempt(generation, attempt))
	vm, err := s.createWorkspaceVMAttempt(createCtx, req)
	if err == nil || strings.TrimSpace(req.SnapshotID) == "" {
		return vm, err
	}
	slog.Warn("golden snapshot vm create failed; retrying from bare image", "snapshot_id", req.SnapshotID, "error", err)
	// Defense in depth: the sandbox client reaps a partially created VM itself
	// before returning an error, but the interface cannot enforce that
	// contract — if an ID survived the failure, reap it before retrying so the
	// snapshot attempt never leaks a VM.
	s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
	// Rebuild the bare request from scratch (keeps Packages) rather than clearing
	// SnapshotID on req, which had them stripped for the snapshot boot.
	bareCtx := sandboxProvisionContext(ctx, "create", "workspace", workspaceID, workspaceProvisionAttempt(generation, "bare"))
	bareReq, bareReqErr := s.buildWorkspaceVMRequest(ctx, "", nil, repositoryID, workspaceID, kind)
	if bareReqErr != nil {
		return sandbox.CreateResult{}, bareReqErr
	}
	if len(bindings) > 0 {
		bindings[0].apply(&bareReq)
	}
	bareVM, bareErr := s.createWorkspaceVMAttempt(bareCtx, bareReq)
	if bareErr != nil {
		return bareVM, bareErr // both failed → sandbox provider problem, do not invalidate
	}
	if goldenSnapshotCreateErrorIsSnapshotSpecific(err, req.SnapshotID) {
		if sandboxKindForWorkspace(kind) == "container" {
			s.goldenSnapshots.MarkBad(ctx, req.SnapshotID)
		} else if image, resolveErr := s.resolveWorkspaceImage(ctx, repositoryID, kind); resolveErr == nil {
			s.goldenSnapshots.MarkBadFor(ctx, goldenSnapshotKeyForImage(image.Kind, image.ClosureHash), req.SnapshotID)
		}
	}
	return bareVM, nil
}

// snapshotRejectionErrorCodes is the closed set of machine-readable provider
// error codes that name the snapshot as the rejected resource. Matching a
// closed set of `code` fields is deliberate: the previous implementation
// substring-matched the human-readable message, and when the controller
// answered a missing snapshot with the generic prose "sandbox resource was not
// found" the word "snapshot" never appeared, MarkBad never fired, and a golden
// pointer stayed `ready` while dangling for 8 days — every workspace create
// paying a wasted snapshot boot plus VM delete. Error prose is not an API;
// these codes are.
var snapshotRejectionErrorCodes = map[string]bool{
	"snapshot_not_found":    true,
	"snapshot_missing":      true,
	"snapshot_invalid":      true,
	"snapshot_unavailable":  true,
	"invalid_snapshot":      true,
	"snapshot_import_error": true,
}

// goldenSnapshotCreateErrorIsSnapshotSpecific reports whether a failed
// snapshot-backed VM create implicates the snapshot itself (so the golden
// pointer must be retired) rather than the sandbox tier as a whole.
//
// snapshotID is the snapshot the failed request actually carried; an empty one
// can never implicate a snapshot. Classification is layered and never reads
// error prose:
//
//  1. An exact machine-readable code from snapshotRejectionErrorCodes, at any
//     4xx status. This is the contract a current controller emits.
//  2. Structural: ANY 404 answering a create that carried a snapshot id. A
//     create request references exactly one pre-existing resource — the
//     snapshot — so a not-found can only mean the snapshot. This arm is what
//     lets an already-deployed controller (which answers with the generic
//     `not_found` code) self-heal without waiting for a controller rollout.
//
// Everything else — 5xx, and generic 400s such as invalid_json,
// image_required or idempotency_key_required — is a tier or request fault and
// must NOT retire a healthy golden snapshot.
func goldenSnapshotCreateErrorIsSnapshotSpecific(err error, snapshotID string) bool {
	if strings.TrimSpace(snapshotID) == "" {
		return false
	}
	var statusErr *sandbox.StatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	if statusErr.StatusCode < 400 || statusErr.StatusCode >= 500 {
		return false
	}
	for _, code := range []string{statusErr.ErrorCode, statusErr.Code} {
		if snapshotRejectionErrorCodes[strings.ToLower(strings.TrimSpace(code))] {
			return true
		}
	}
	return statusErr.StatusCode == http.StatusNotFound
}

// GoldenBakeVMRequest is the request the golden-snapshot baker boots its
// builder VM from: the exact bare-image workspace request, so the baked disk
// is byte-for-byte what a workspace would have built for itself.
func (s *WorkspaceService) GoldenBakeVMRequest() sandbox.CreateRequest {
	// repositoryID 0: the baked golden disk is repo-agnostic and must NEVER carry
	// any repository's secrets.
	// repositoryID 0 binds no secret, so the request cannot fail.
	req, _ := s.buildWorkspaceVMRequest(context.Background(), "", nil, 0, "", "container")
	return req
}

// workspaceProxyBoundSecretsLoader is the optional provider surface that
// yields the repository's egress-bound secrets shaped for the sandbox.
// AgentEnvironmentService implements it; test fakes need not.
type workspaceProxyBoundSecretsLoader interface {
	LoadProxyBoundSecrets(ctx context.Context, repositoryID int64) ([]sandbox.EgressProxySecret, error)
}

// outsiderWorkspaceReader reads the permanent outsider_workspaces mark.
type outsiderWorkspaceReader interface {
	IsOutsiderWorkspace(ctx context.Context, workspaceID string) (bool, error)
}

// outsiderWorkspace reports whether a workspace ran work started from an
// outsider's text. A store that cannot hold the mark has no marked workspace.
func (s *WorkspaceService) outsiderWorkspace(ctx context.Context, workspaceID string) (bool, error) {
	reader, ok := s.q.(outsiderWorkspaceReader)
	if !ok || strings.TrimSpace(workspaceID) == "" {
		return false, nil
	}
	return reader.IsOutsiderWorkspace(ctx, workspaceID)
}

// outsiderFork reports whether either side of a fork ran, or is to run,
// outsider-started work (or its mark cannot be read). Such a workspace boots
// cold: a fork would carry the other box's disk, and any person's credential
// stored there, across that line.
func (s *WorkspaceService) outsiderFork(ctx context.Context, child, source db.Workspace) bool {
	for _, id := range []string{child.ID, source.ID} {
		if outsider, err := s.outsiderWorkspace(ctx, id); err != nil || outsider {
			return true
		}
	}
	return false
}

// workspaceEgressProxy builds the egress-proxy policy for a workspace VM.
// Every workspace gets the per-sandbox proxy as its only egress path, with or
// without bound secrets, exactly like agent sandboxes. Bound repository
// secrets travel once, inside the create request, to the worker that seeds
// the proxy process; the guest sees NAME=NAME. repositoryID 0 (the golden
// bake) binds nothing so the baked disk never carries a repository's secrets.
func (s *WorkspaceService) workspaceEgressProxy(ctx context.Context, repositoryID int64, workspaceID string) (*sandbox.EgressProxyPolicy, error) {
	policy := &sandbox.EgressProxyPolicy{Enabled: true}
	// A workspace that ran work started from an outsider's text reaches
	// GitHub only for code: that work reads its approved copy, never the
	// live issue or conversation.
	if outsider, err := s.outsiderWorkspace(ctx, workspaceID); err != nil {
		return nil, pkgerrors.Internal("read the workspace's outsider mark").WithCause(err)
	} else if outsider {
		policy.HostRules = sandbox.ConversationWithheldHostRules()
	}
	loader, ok := s.agentEnvironment.(workspaceProxyBoundSecretsLoader)
	if !ok || repositoryID <= 0 {
		return policy, nil
	}
	bound, err := loader.LoadProxyBoundSecrets(ctx, repositoryID)
	if err != nil {
		// Fail closed: a workspace must not boot with fewer bindings than the
		// repository declared, or the setup run would see a placeholder the
		// proxy never swaps.
		return nil, pkgerrors.Internal("load repository secrets for workspace egress proxy").WithCause(err)
	}
	policy.Secrets = bound
	if err := policy.Validate(); err != nil {
		return nil, pkgerrors.Internal("invalid repository secret binding: " + err.Error())
	}
	return policy, nil
}

func (s *WorkspaceService) buildWorkspaceVMRequest(ctx context.Context, snapshotID string, gitRepos []sandbox.GitRepositorySpec, repositoryID int64, workspaceID, kind string) (sandbox.CreateRequest, error) {
	return s.buildWorkspaceVMRequestWithImage(ctx, snapshotID, gitRepos, repositoryID, workspaceID, kind, nil)
}

// buildWorkspaceVMRequestWithImage is buildWorkspaceVMRequest with the NixOS
// image fixed by the caller (the golden baker) instead of resolved from the
// registry. For kind=vm/desktop the request boots the closure image via the
// worker's init handoff; snapshotID non-empty means "boot the closure's
// golden snapshot when one is ready" (the container-kind id is never reused).
func (s *WorkspaceService) buildWorkspaceVMRequestWithImage(ctx context.Context, snapshotID string, gitRepos []sandbox.GitRepositorySpec, repositoryID int64, workspaceID, kind string, fixedImage *runtimeports.SandboxEnvironmentImage) (sandbox.CreateRequest, error) {
	req, err := s.buildContainerWorkspaceVMRequest(ctx, snapshotID, gitRepos, repositoryID, workspaceID, kind)
	if err != nil {
		return sandbox.CreateRequest{}, err
	}
	if sandboxKindForWorkspace(kind) == "container" {
		return req, nil
	}
	var image runtimeports.SandboxEnvironmentImage
	if fixedImage != nil {
		image = *fixedImage
	} else {
		image, err = s.resolveWorkspaceImage(ctx, repositoryID, kind)
		if err != nil {
			return sandbox.CreateRequest{}, err
		}
	}
	wantSnapshot := strings.TrimSpace(snapshotID) != ""
	golden := ""
	if wantSnapshot {
		golden = s.nixGoldenSnapshotFor(ctx, image)
	}
	s.applyNixGuest(&req, image, wantSnapshot, golden)
	// The incoming "closure" hint is resolved above; only an actual snapshot
	// has a fixed disk. Bare development guests need monorepo build space.
	if normalizeWorkspaceKind(kind) == "vm" && req.SnapshotID == "" {
		disk := int64(32 * 1024)
		req.RootfsSizeMB = &disk
	}
	return req, nil
}

// buildContainerWorkspaceVMRequest is the legacy OCI workspace request every
// kind starts from; vm/desktop then swap the image, packages, and bootstrap.
func (s *WorkspaceService) buildContainerWorkspaceVMRequest(ctx context.Context, snapshotID string, gitRepos []sandbox.GitRepositorySpec, repositoryID int64, workspaceID, kind string) (sandbox.CreateRequest, error) {
	egress, err := s.workspaceEgressProxy(ctx, repositoryID, workspaceID)
	if err != nil {
		return sandbox.CreateRequest{}, err
	}
	waitForReady := true
	readySignalTimeout := workspaceReadyTimeoutSeconds
	remainAfterExit := true
	emitReadySignal := true
	files := map[string]sandbox.SandboxFile{
		workspaceClaudeScriptPath: {
			Content:    buildWorkspaceClaudeBootstrapScript(),
			Executable: true,
		},
	}
	addWorkspaceSmithersCLI(files)
	addWorkspaceCodingHost(files)
	addWorkspaceJJExport(files)

	memoryMB, vcpuCount := s.workspaceSizeForKind(kind)
	return sandbox.CreateRequest{
		MemSizeMB:          memoryMB,
		VCPUCount:          vcpuCount,
		Kind:               sandboxKindForWorkspace(kind),
		SnapshotID:         snapshotID,
		GitRepos:           gitRepos,
		Packages:           append([]string(nil), defaultWorkspacePackages...),
		Firewall:           localMicrosandboxHostFirewall(s.gitBaseURL),
		EgressProxy:        egress,
		Files:              files,
		IdleTimeoutSeconds: &s.workspaceIdleTimeoutSeconds,
		Persistence: &sandbox.PersistencePolicy{
			Type:     s.workspacePersistence,
			Priority: &s.workspacePersistencePriority,
		},
		Init: &sandbox.ServiceConfig{
			Enabled: true,
			Services: []sandbox.ServiceSpec{
				{
					Name:            workspaceClaudeService,
					Mode:            sandbox.ServiceModeOneshot,
					Exec:            []string{workspaceClaudeScriptPath},
					User:            "root",
					After:           []string{"network-online.target"},
					WantedBy:        []string{"multi-user.target"},
					RemainAfterExit: &remainAfterExit,
				},
				{
					// The ready-signal emitter WaitForReady blocks on.
					// Deliberately trivial and independent of the claude/node/jj
					// bootstrap: ready means "VM booted with networking up, SSH and
					// exec reachable", which is all the terminal needs. Gating on
					// the bootstrap instead would tie readiness to multi-minute
					// npm/node downloads (and any bootstrap failure), starving the
					// 90s ready timeout and reintroducing the prod hang where
					// CreateSandbox waited on a signal that never fired.
					Name:            workspaceReadyService,
					Mode:            sandbox.ServiceModeOneshot,
					Exec:            []string{"/bin/true"},
					User:            "root",
					After:           []string{"network-online.target"},
					WantedBy:        []string{"multi-user.target"},
					RemainAfterExit: &remainAfterExit,
					ReadySignal:     &emitReadySignal,
				},
			},
		},
		Users: []sandbox.LinuxUserSpec{
			{
				Name:  s.workspaceUsername,
				Home:  defaultWorkspaceHome,
				Shell: "/bin/bash",
			},
		},
		WaitForReady:        &waitForReady,
		ReadyTimeoutSeconds: &readySignalTimeout,
		// Use the home directory as the initial workdir so SSH still opens even if repo clone fails.
		Workdir: defaultWorkspaceHome,
	}, nil
}

// localMicrosandboxHostFirewall permits the SDK's explicit host gateway only
// when the configured API URL uses its reserved hostname. The default remains
// public-only everywhere else; this lets a loopback-only local Plue API serve
// repository clones to a real VM without widening the host listener.
func localMicrosandboxHostFirewall(gitBaseURL string) *sandbox.FirewallPolicy {
	parsed, err := url.Parse(strings.TrimSpace(gitBaseURL))
	if err != nil || !strings.EqualFold(parsed.Hostname(), "host.microsandbox.internal") {
		return nil
	}
	return &sandbox.FirewallPolicy{EgressAllow: []sandbox.FirewallEgressRule{{Host: "host"}}}
}

// CreateWorkspace creates or resumes a first-class workspace resource.
func (s *WorkspaceService) CreateWorkspace(ctx context.Context, input CreateWorkspaceInput) (out WorkspaceResponse, retErr error) {
	defer func() { s.observeWorkspaceLifecycle("create", retErr) }()
	if s.q == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace store unavailable")
	}
	if s.runtime == nil && s.sandbox == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace runtime unavailable")
	}
	if err := validateWorkspaceCreateMetadata(input); err != nil {
		return WorkspaceResponse{}, err
	}
	kind, environment := workspaceCreateParamsMetadata(input)
	bookmark, defaultBookmark, err := s.resolveWorkspaceBookmark(ctx, input.RepositoryID, input.SourceBookmark)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	input.SourceBookmark = bookmark

	var workspace db.Workspace

	if strings.TrimSpace(input.SnapshotID) == "" {
		if bookmark == defaultBookmark {
			workspace, err = s.findOrCreatePrimaryWorkspace(ctx, input.RepositoryID, input.UserID, strings.TrimSpace(input.Name), bookmark, workspaceCreateMetadata{kind: kind, environment: environment})
		} else {
			workspace, err = s.findOrCreateDerivedWorkspaceForBookmark(ctx, input.RepositoryID, input.UserID, strings.TrimSpace(input.Name), bookmark, workspaceCreateMetadata{kind: kind, environment: environment})
		}
		if err != nil {
			return WorkspaceResponse{}, err
		}
		workspace, err = s.ensureWorkspaceRunning(ctx, workspace, CreateWorkspaceSessionInput{
			RepositoryID:   input.RepositoryID,
			UserID:         input.UserID,
			RepoOwner:      input.RepoOwner,
			RepoName:       input.RepoName,
			SourceBookmark: input.SourceBookmark,
		})
		if err != nil {
			return WorkspaceResponse{}, err
		}
		return s.toWorkspaceResponse(workspace), nil
	}

	// Snapshot-restore is a NEW workspace row — enforce the per-user cap
	// before we insert. Ticket 0105.
	if err := s.enforceWorkspaceQuota(ctx, input.UserID); err != nil {
		return WorkspaceResponse{}, err
	}

	snapshot, err := s.loadOwnedWorkspaceSnapshot(ctx, strings.TrimSpace(input.SnapshotID), input.RepositoryID, input.UserID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	if err := s.refuseRebuildRequiredSnapshot(snapshot); err != nil {
		return WorkspaceResponse{}, err
	}
	if s.runtime != nil {
		if _, err := s.runtimeSnapshots(); err != nil {
			return WorkspaceResponse{}, err
		}
	}

	workspace, err = s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		RepositoryID:           input.RepositoryID,
		UserID:                 input.UserID,
		Name:                   strings.TrimSpace(input.Name),
		IsFork:                 true,
		ParentWorkspaceID:      pgtype.UUID{},
		SourceSnapshotID:       stringToUUID(snapshot.ID),
		TargetBookmark:         bookmark,
		Kind:                   kind,
		EnvironmentSource:      environment.Source,
		EnvironmentRevision:    environment.Revision,
		EnvironmentClosureHash: environment.ClosureHash,
		Status:                 "starting",
	})
	if err != nil {
		return WorkspaceResponse{}, mapWorkspaceCreateError(err, "create snapshot workspace")
	}
	if s.runtime != nil {
		workspace, err = s.restoreRuntimeWorkspaceSnapshot(ctx, workspace, snapshot, input.UserID)
		if err != nil {
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
			return WorkspaceResponse{}, err
		}
		return s.toWorkspaceResponse(workspace), nil
	}

	workspace, err = s.createWorkspaceVMFromSnapshot(ctx, workspace, snapshot)
	if err != nil {
		return WorkspaceResponse{}, err
	}

	return s.toWorkspaceResponse(workspace), nil
}

// CreateWorkspaceAsync creates or reuses the workspace row immediately and
// provisions its configured execution runtime in the background. Browser
// routes use this path so startup can exceed proxy/client deadlines without
// canceling the real operation.
func (s *WorkspaceService) CreateWorkspaceAsync(ctx context.Context, input CreateWorkspaceInput) (out WorkspaceResponse, retErr error) {
	defer func() { s.observeWorkspaceLifecycle("create", retErr) }()
	if s.q == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace store unavailable")
	}
	if s.runtime == nil && s.sandbox == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace runtime unavailable")
	}
	if err := validateWorkspaceCreateMetadata(input); err != nil {
		return WorkspaceResponse{}, err
	}
	kind, environment := workspaceCreateParamsMetadata(input)
	bookmark, defaultBookmark, err := s.resolveWorkspaceBookmark(ctx, input.RepositoryID, input.SourceBookmark)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	input.SourceBookmark = bookmark

	var workspace db.Workspace

	if strings.TrimSpace(input.SnapshotID) == "" {
		if bookmark == defaultBookmark {
			workspace, err = s.findOrCreatePrimaryWorkspace(ctx, input.RepositoryID, input.UserID, strings.TrimSpace(input.Name), bookmark, workspaceCreateMetadata{kind: kind, environment: environment})
		} else {
			workspace, err = s.findOrCreateDerivedWorkspaceForBookmark(ctx, input.RepositoryID, input.UserID, strings.TrimSpace(input.Name), bookmark, workspaceCreateMetadata{kind: kind, environment: environment})
		}
		if err != nil {
			return WorkspaceResponse{}, err
		}
		s.provisionWorkspaceAsync(ctx, workspace, CreateWorkspaceSessionInput{
			RepositoryID:   input.RepositoryID,
			UserID:         input.UserID,
			RepoOwner:      input.RepoOwner,
			RepoName:       input.RepoName,
			SourceBookmark: input.SourceBookmark,
		})
		return s.toWorkspaceResponse(workspace), nil
	}

	if err := s.enforceWorkspaceQuota(ctx, input.UserID); err != nil {
		return WorkspaceResponse{}, err
	}

	snapshot, err := s.loadOwnedWorkspaceSnapshot(ctx, strings.TrimSpace(input.SnapshotID), input.RepositoryID, input.UserID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	if err := s.refuseRebuildRequiredSnapshot(snapshot); err != nil {
		return WorkspaceResponse{}, err
	}
	if s.runtime != nil {
		if _, err := s.runtimeSnapshots(); err != nil {
			return WorkspaceResponse{}, err
		}
	}

	workspace, err = s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		RepositoryID:           input.RepositoryID,
		UserID:                 input.UserID,
		Name:                   strings.TrimSpace(input.Name),
		IsFork:                 true,
		ParentWorkspaceID:      pgtype.UUID{},
		SourceSnapshotID:       stringToUUID(snapshot.ID),
		TargetBookmark:         bookmark,
		Kind:                   kind,
		EnvironmentSource:      environment.Source,
		EnvironmentRevision:    environment.Revision,
		EnvironmentClosureHash: environment.ClosureHash,
		Status:                 "starting",
	})
	if err != nil {
		return WorkspaceResponse{}, mapWorkspaceCreateError(err, "create snapshot workspace")
	}

	s.provisionSnapshotWorkspaceAsync(ctx, workspace, snapshot)
	return s.toWorkspaceResponse(workspace), nil
}

// ForkWorkspace forks a workspace into a new derived workspace.
func (s *WorkspaceService) ForkWorkspace(ctx context.Context, input ForkWorkspaceInput) (WorkspaceResponse, error) {
	if s.q == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace store unavailable")
	}
	if s.runtime != nil {
		return s.forkRuntimeWorkspace(ctx, input)
	}
	if s.sandbox == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("sandbox provider unavailable")
	}

	// Fork creates a new derived workspace row — counts against the
	// per-user cap (ticket 0105).
	if err := s.enforceWorkspaceQuota(ctx, input.UserID); err != nil {
		return WorkspaceResponse{}, err
	}

	source, err := s.loadOwnedWorkspace(ctx, input.WorkspaceID, input.RepositoryID, input.UserID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	// Resume-then-fork: a suspended source VM is resumed before ForkSandbox. When the
	// source was never provisioned (empty VmID) we skip the resume — there is
	// nothing to run — and forkWorkspaceVM takes the provision-on-empty branch,
	// binding a fresh VM to the fork instead of 409ing.
	if strings.TrimSpace(source.VmID) != "" {
		source, err = s.ensureExistingWorkspaceRunning(ctx, source)
		if err != nil {
			return WorkspaceResponse{}, err
		}
	}

	created, err := s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		RepositoryID:           source.RepositoryID,
		UserID:                 source.UserID,
		Name:                   strings.TrimSpace(input.Name),
		IsFork:                 true,
		ParentWorkspaceID:      stringToUUID(source.ID),
		SourceSnapshotID:       source.SourceSnapshotID,
		TargetBookmark:         source.TargetBookmark,
		Kind:                   source.Kind,
		EnvironmentSource:      source.EnvironmentSource,
		EnvironmentRevision:    source.EnvironmentRevision,
		EnvironmentClosureHash: source.EnvironmentClosureHash,
		Status:                 "starting",
	})
	if err != nil {
		return WorkspaceResponse{}, mapWorkspaceCreateError(err, "create fork workspace")
	}

	created, err = s.forkWorkspaceVM(ctx, created, source)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	return s.toWorkspaceResponse(created), nil
}

// CreateWorkspaceSnapshot creates a reusable snapshot from a workspace.
func (s *WorkspaceService) CreateWorkspaceSnapshot(ctx context.Context, input CreateWorkspaceSnapshotInput) (WorkspaceSnapshotResponse, error) {
	if s.q == nil {
		return WorkspaceSnapshotResponse{}, pkgerrors.Internal("workspace store unavailable")
	}
	// Validate the name BEFORE any external side effect: sandbox provider happily
	// creates a snapshot for a name our own text validation then rejects, and
	// the early return would leak that external snapshot forever.
	snapshotName := strings.TrimSpace(input.Name)
	if err := validateSafeText("WorkspaceSnapshot", "name", snapshotName); err != nil {
		return WorkspaceSnapshotResponse{}, err
	}
	if s.runtime != nil {
		return s.createRuntimeWorkspaceSnapshot(ctx, input, snapshotName)
	}
	if s.sandbox == nil {
		return WorkspaceSnapshotResponse{}, pkgerrors.Internal("sandbox provider unavailable")
	}

	workspace, err := s.loadOwnedWorkspace(ctx, input.WorkspaceID, input.RepositoryID, input.UserID)
	if err != nil {
		return WorkspaceSnapshotResponse{}, err
	}
	workspace, err = s.ensureExistingWorkspaceRunning(ctx, workspace)
	if err != nil {
		return WorkspaceSnapshotResponse{}, err
	}

	snapshotResp, err := s.sandbox.SnapshotSandbox(ctx, workspace.VmID, sandbox.SnapshotRequest{
		Name: snapshotName,
	})
	if err != nil {
		return WorkspaceSnapshotResponse{}, pkgerrors.Internal("create sandbox workspace snapshot: " + err.Error())
	}

	snapshot, err := s.q.CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{
		RepositoryID: workspace.RepositoryID,
		UserID:       workspace.UserID,
		WorkspaceID:  workspace.ID,
		Name:         snapshotName,
		SnapshotID:   snapshotResp.SnapshotID,
	})
	if err != nil {
		_ = s.sandbox.DeleteSnapshot(ctx, snapshotResp.SnapshotID)
		return WorkspaceSnapshotResponse{}, pkgerrors.Internal("persist workspace snapshot: " + err.Error())
	}

	return toWorkspaceSnapshotResponse(snapshot), nil
}

// GetWorkspaceSnapshot returns a stored workspace snapshot by ID.
func (s *WorkspaceService) GetWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) (WorkspaceSnapshotResponse, error) {
	if s.q == nil {
		return WorkspaceSnapshotResponse{}, pkgerrors.Internal("workspace store unavailable")
	}

	snapshot, err := s.loadOwnedWorkspaceSnapshot(ctx, snapshotID, repositoryID, userID)
	if err != nil {
		return WorkspaceSnapshotResponse{}, err
	}
	return toWorkspaceSnapshotResponse(snapshot), nil
}

// ListWorkspaceSnapshots returns paginated workspace snapshots for a repository.
func (s *WorkspaceService) ListWorkspaceSnapshots(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]WorkspaceSnapshotResponse, int64, error) {
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

	rows, err := s.q.ListWorkspaceSnapshotsByRepo(ctx, db.ListWorkspaceSnapshotsByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
		PageOffset:   ClampInt32(offset),
		PageSize:     int32(perPage),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("list workspace snapshots: " + err.Error())
	}

	total, err := s.q.CountWorkspaceSnapshotsByRepo(ctx, db.CountWorkspaceSnapshotsByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("count workspace snapshots: " + err.Error())
	}

	result := make([]WorkspaceSnapshotResponse, 0, len(rows))
	for _, row := range rows {
		result = append(result, toWorkspaceSnapshotResponse(row))
	}
	return result, total, nil
}

// DeleteWorkspaceSnapshot removes a stored workspace snapshot and deletes it from the sandbox.
func (s *WorkspaceService) DeleteWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) error {
	if s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}

	snapshot, err := s.loadOwnedWorkspaceSnapshot(ctx, snapshotID, repositoryID, userID)
	if err != nil {
		return err
	}
	if s.runtime != nil {
		if err := s.deleteRuntimeWorkspaceSnapshot(ctx, snapshot, userID); err != nil {
			return err
		}
	} else if s.sandbox != nil && strings.TrimSpace(snapshot.SnapshotID) != "" {
		if err := s.sandbox.DeleteSnapshot(ctx, snapshot.SnapshotID); err != nil {
			var statusErr *sandbox.StatusError
			if !errors.As(err, &statusErr) || statusErr.StatusCode != 404 {
				return pkgerrors.Internal("delete sandbox workspace snapshot: " + err.Error())
			}
		}
	}
	if err := s.q.DeleteWorkspaceSnapshot(ctx, snapshotID); err != nil {
		return pkgerrors.Internal("delete workspace snapshot: " + err.Error())
	}
	return nil
}

func (s *WorkspaceService) findOrCreateWorkspaceForBookmark(ctx context.Context, repositoryID, userID int64, name, targetBookmark string, metadata workspaceCreateMetadata) (db.Workspace, error) {
	targetBookmark = targetWorkspaceBookmark(targetBookmark)
	if isPrimaryWorkspaceBookmark(targetBookmark) {
		return s.findOrCreatePrimaryWorkspace(ctx, repositoryID, userID, name, targetBookmark, metadata)
	}
	return s.findOrCreateDerivedWorkspaceForBookmark(ctx, repositoryID, userID, name, targetBookmark, metadata)
}

func (s *WorkspaceService) findOrCreatePrimaryWorkspace(ctx context.Context, repositoryID, userID int64, name, targetBookmark string, metadata workspaceCreateMetadata) (db.Workspace, error) {
	metadata = normalizeWorkspaceCreateMetadata(metadata)
	if err := s.failStalePendingWorkspacesForRepoUser(ctx, repositoryID, userID); err != nil {
		return db.Workspace{}, err
	}

	workspace, err := s.q.GetActiveWorkspaceForUserRepoKind(ctx, db.GetActiveWorkspaceForUserRepoKindParams{
		RepositoryID: repositoryID,
		UserID:       userID,
		Kind:         metadata.kind,
	})
	if err == nil {
		if s.shouldReplaceZombieWorkspace(workspace, time.Now()) {
			if _, failErr := s.failWorkspace(ctx, workspace, errors.New("workspace provisioning timed out")); failErr != nil {
				return db.Workspace{}, failErr
			}
			return s.createPrimaryWorkspace(ctx, repositoryID, userID, name, targetBookmark, metadata)
		}
		if err := s.refuseRebuildRequired(workspace); err != nil {
			return db.Workspace{}, err
		}
		workspace, err = s.ensureWorkspaceTargetBookmark(ctx, workspace, targetBookmark)
		if err != nil {
			return db.Workspace{}, err
		}
		return workspace, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.Workspace{}, pkgerrors.Internal("load workspace: " + err.Error())
	}
	return s.createPrimaryWorkspace(ctx, repositoryID, userID, name, targetBookmark, metadata)
}

func (s *WorkspaceService) findOrCreateDerivedWorkspaceForBookmark(ctx context.Context, repositoryID, userID int64, name, targetBookmark string, metadata workspaceCreateMetadata) (db.Workspace, error) {
	metadata = normalizeWorkspaceCreateMetadata(metadata)
	if err := s.failStalePendingWorkspacesForRepoUser(ctx, repositoryID, userID); err != nil {
		return db.Workspace{}, err
	}

	workspaces, err := s.q.ListWorkspacesByRepo(ctx, db.ListWorkspacesByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
		PageSize:     100,
		PageOffset:   0,
	})
	if err != nil {
		return db.Workspace{}, pkgerrors.Internal("list workspaces: " + err.Error())
	}
	for _, workspace := range workspaces {
		if targetWorkspaceBookmark(workspace.TargetBookmark) != targetBookmark || workspace.Kind != metadata.kind {
			continue
		}
		if s.shouldReplaceZombieWorkspace(workspace, time.Now()) {
			if _, failErr := s.failWorkspace(ctx, workspace, errors.New("workspace provisioning timed out")); failErr != nil {
				return db.Workspace{}, failErr
			}
			break
		}
		if err := s.refuseRebuildRequired(workspace); err != nil {
			return db.Workspace{}, err
		}
		return workspace, nil
	}
	return s.createDerivedWorkspaceForBookmark(ctx, repositoryID, userID, name, targetBookmark, metadata)
}

func (s *WorkspaceService) createPrimaryWorkspace(ctx context.Context, repositoryID, userID int64, name, targetBookmark string, metadata workspaceCreateMetadata) (db.Workspace, error) {
	// Ticket 0105: quota check fires here, NOT in findOrCreatePrimaryWorkspace,
	// because that function also handles the reuse path (returning an
	// existing active workspace). Reuse must not count against the cap.
	if err := s.enforceWorkspaceQuota(ctx, userID); err != nil {
		return db.Workspace{}, err
	}
	metadata = normalizeWorkspaceCreateMetadata(metadata)
	workspace, err := s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		RepositoryID:           repositoryID,
		UserID:                 userID,
		Name:                   name,
		IsFork:                 false,
		ParentWorkspaceID:      pgtype.UUID{},
		SourceSnapshotID:       pgtype.UUID{},
		TargetBookmark:         targetWorkspaceBookmark(targetBookmark),
		Kind:                   metadata.kind,
		EnvironmentSource:      metadata.environment.Source,
		EnvironmentRevision:    metadata.environment.Revision,
		EnvironmentClosureHash: metadata.environment.ClosureHash,
		Status:                 "starting",
	})
	if err != nil {
		return db.Workspace{}, mapWorkspaceCreateError(err, "create workspace")
	}
	return workspace, nil
}

func (s *WorkspaceService) createDerivedWorkspaceForBookmark(ctx context.Context, repositoryID, userID int64, name, targetBookmark string, metadata workspaceCreateMetadata) (db.Workspace, error) {
	if err := s.enforceWorkspaceQuota(ctx, userID); err != nil {
		return db.Workspace{}, err
	}
	metadata = normalizeWorkspaceCreateMetadata(metadata)
	workspace, err := s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		RepositoryID:           repositoryID,
		UserID:                 userID,
		Name:                   name,
		IsFork:                 true,
		ParentWorkspaceID:      pgtype.UUID{},
		SourceSnapshotID:       pgtype.UUID{},
		TargetBookmark:         targetWorkspaceBookmark(targetBookmark),
		Kind:                   metadata.kind,
		EnvironmentSource:      metadata.environment.Source,
		EnvironmentRevision:    metadata.environment.Revision,
		EnvironmentClosureHash: metadata.environment.ClosureHash,
		Status:                 "starting",
	})
	if err != nil {
		return db.Workspace{}, mapWorkspaceCreateError(err, "create branch workspace")
	}
	return workspace, nil
}

func (s *WorkspaceService) ensureWorkspaceTargetBookmark(ctx context.Context, workspace db.Workspace, targetBookmark string) (db.Workspace, error) {
	targetBookmark = targetWorkspaceBookmark(targetBookmark)
	if strings.TrimSpace(workspace.TargetBookmark) == targetBookmark {
		return workspace, nil
	}
	updated, err := s.q.UpdateWorkspaceTargetBookmark(ctx, db.UpdateWorkspaceTargetBookmarkParams{
		ID:             workspace.ID,
		TargetBookmark: targetBookmark,
	})
	if err != nil {
		return db.Workspace{}, pkgerrors.Internal("update workspace target bookmark: " + err.Error())
	}
	return updated, nil
}

func targetWorkspaceBookmark(bookmark string) string {
	if bookmark = strings.TrimSpace(bookmark); bookmark != "" {
		return bookmark
	}
	return "main"
}

func isPrimaryWorkspaceBookmark(bookmark string) bool {
	return targetWorkspaceBookmark(bookmark) == "main"
}

// mapWorkspaceCreateError converts a CreateWorkspace insert failure into an
// API error. The per-user cap is enforced atomically by the database
// (trg_workspaces_user_quota); enforceWorkspaceQuota is only a friendly
// pre-check, so a request that races past it surfaces here as a check
// violation and must still read as quota_exceeded, not a 500.
func mapWorkspaceCreateError(err error, action string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.ConstraintName == "workspaces_user_quota" {
		return pkgerrors.QuotaExceeded(fmt.Sprintf(
			"sandbox limit reached: %d workspaces in use — delete one to continue",
			MaxActiveWorkspacesPerUser,
		))
	}
	return pkgerrors.Internal(action + ": " + err.Error())
}

// enforceWorkspaceQuota returns a quota_exceeded error if the user already
// owns MaxActiveWorkspacesPerUser non-deleted, non-failed workspaces. Counts
// are served by idx_workspaces_user_active (partial index WHERE deleted_at IS
// NULL) so this is cheap even for noisy users who cycle many workspaces.
// Failed rows are excluded so provisioning failures cannot permanently eat
// quota and drive retries into quota_exceeded.
//
// Ticket 0105. Called from every create-path: createPrimaryWorkspace,
// CreateWorkspace (snapshot-restore branch), and ForkWorkspace. Reuse of
// an existing primary workspace does NOT invoke this check. The database
// backstops it with trg_workspaces_user_quota, which serializes concurrent
// inserts per user and re-counts, closing the check-then-insert race across
// concurrent create/fork/snapshot-restore requests.
func (s *WorkspaceService) enforceWorkspaceQuota(ctx context.Context, userID int64) error {
	if err := authorizeSandboxStartForUser(ctx, s.billing, userID); err != nil {
		return err
	}
	count, err := s.q.CountActiveWorkspacesByUser(ctx, userID)
	if err != nil {
		return pkgerrors.Internal("count active workspaces: " + err.Error())
	}
	if count >= MaxActiveWorkspacesPerUser {
		return pkgerrors.QuotaExceeded(fmt.Sprintf(
			"sandbox limit reached: %d of %d workspaces in use — delete one to continue",
			count, MaxActiveWorkspacesPerUser,
		))
	}
	return nil
}

func (s *WorkspaceService) failStalePendingWorkspacesForRepoUser(ctx context.Context, repositoryID, userID int64) error {
	if s.durableProvisioning() {
		return s.ReconcileWorkspaceProvisioning(ctx)
	}
	total, err := s.q.CountWorkspacesByRepo(ctx, db.CountWorkspacesByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
	})
	if err != nil {
		return pkgerrors.Internal("count workspaces: " + err.Error())
	}
	if total == 0 {
		return nil
	}

	rows, err := s.q.ListWorkspacesByRepo(ctx, db.ListWorkspacesByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
		PageOffset:   0,
		PageSize:     int32(total),
	})
	if err != nil {
		return pkgerrors.Internal("list workspaces: " + err.Error())
	}
	now := time.Now()
	for _, workspace := range rows {
		if !workspace.IsFork && s.shouldReplaceZombieWorkspace(workspace, now) {
			if _, failErr := s.failWorkspace(ctx, workspace, errors.New("workspace provisioning timed out")); failErr != nil {
				return failErr
			}
		}
	}
	return nil
}

func (s *WorkspaceService) shouldReplaceZombieWorkspace(workspace db.Workspace, now time.Time) bool {
	if workspace.Status != "pending" && workspace.Status != "starting" {
		return false
	}
	if strings.TrimSpace(workspace.VmID) != "" {
		return false
	}
	staleSince := workspace.UpdatedAt
	if staleSince.IsZero() {
		staleSince = workspace.CreatedAt
	}
	return !staleSince.IsZero() && now.Sub(staleSince) > workspaceStaleAfter
}

type workspaceUnchangedFailureQuerier interface {
	FailWorkspaceIfUnchanged(ctx context.Context, arg db.FailWorkspaceIfUnchangedParams) (db.Workspace, error)
}

type workspaceProvisioningFailureQuerier interface {
	FailProvisioningWorkspaceIfCurrent(ctx context.Context, arg db.FailProvisioningWorkspaceIfCurrentParams) (db.Workspace, error)
}

// workspaceProvisioningFailureCode is what a box's failure_code column holds
// when nothing more specific is known. It is a registry member, so a row
// written today reads back through ParseCode with a fault.
const workspaceProvisioningFailureCode = pkgerrors.CodeProvisioningFailed

type workspaceFailureDetails struct {
	Code    pkgerrors.Code
	Message string
}

func workspaceFailureDetailsFor(cause error) workspaceFailureDetails {
	details := workspaceFailureDetails{
		Code:    workspaceProvisioningFailureCode,
		Message: "workspace provisioning failed",
	}
	if cause == nil {
		return details
	}

	details.Message = strings.TrimSpace(cause.Error())
	var apiErr *pkgerrors.APIError
	if errors.As(cause, &apiErr) {
		if apiErr.Code != "" {
			details.Code = apiErr.Code
		}
		if message := strings.TrimSpace(apiErr.Message); message != "" {
			details.Message = message
		}
	}

	var statusErr *sandbox.StatusError
	if errors.As(cause, &statusErr) {
		// The controller's code arrives as a string from another process, so
		// it goes through ParseCode — the one reviewed ingress — rather than
		// being converted at the call site. Code is the controller's explicit
		// machine-readable field; ErrorCode carries the same value for nested
		// controller envelopes and remains the fallback for older provider
		// responses. An unrecognized code is not persisted as itself: the
		// column would then hold a verdict no client can interpret.
		if code, ok := pkgerrors.ParseCode(statusErr.Code); ok {
			details.Code = code
		} else if code, ok := pkgerrors.ParseCode(statusErr.ErrorCode); ok {
			details.Code = code
		}
		if message := strings.TrimSpace(statusErr.Message); message != "" {
			details.Message = message
		}
	}
	if details.Message == "" {
		details.Message = "workspace provisioning failed"
	}
	return details
}

// workspaceProvisioningError turns a provisioning cause into the answer the
// caller gets.
//
// A FULL POOL IS NOT A PROVISIONING FAILURE. The controller refuses the
// reservation before it touches a guest, so nothing was created, deleted or
// broken — the pool is simply busy. Answering 500 with the wrapped cause chain
// told the caller two lies at once: that plue was broken (it is not; the
// condition clears itself in seconds) and, in plue's own words, that "create
// sandbox: microsandbox api returned status 503 (no_capacity): no healthy
// Microsandbox worker has sufficient capacity" — an internal sentence naming
// an internal component. The resume path already answered this honestly
// (refuseResumeForNoCapacity); the create path now does too, through the same
// constructor and the same user-facing sentence.
//
// Everything else keeps the 500 and the action-prefixed cause: a provisioning
// cause is never the caller's request being wrong, and its text is sanitized
// by writeRouteError before it leaves the process.
func workspaceProvisioningError(action string, cause error) *pkgerrors.APIError {
	var planErr *pkgerrors.APIError
	if errors.As(cause, &planErr) && planErr.Code == pkgerrors.CodePlanLimitExceeded {
		return planErr
	}

	if isNoCapacityError(cause) {
		return pkgerrors.NoCapacity(workspaceNoCapacityMessage)
	}
	details := workspaceFailureDetailsFor(cause)
	if details.Code == pkgerrors.CodeHostLeaseLost {
		// Inspection has already identified a lost worker. Preserve its prompt
		// unavailable response without suggesting a replacement workspace or
		// disguising durable recovery as an unexpected provisioning defect.
		return pkgerrors.New(details.Code, details.Message)
	}
	message := details.Message
	if action = strings.TrimSpace(action); action != "" {
		if cause != nil {
			message = action + ": " + strings.TrimSpace(cause.Error())
		} else {
			message = action
		}
	}
	failure := pkgerrors.New(details.Code, message)
	// The registry's status belongs to the code on ITS OWN surface (the
	// controller answers stale_generation 409, not_found 404). A failure to
	// BUILD a box is answered 500 whatever the controller called it, so the
	// status is pinned here and only the code and the fault are borrowed.
	//
	// A 500 is never the caller's fault: plue drove that request, not them. A
	// code the registry marks `user` therefore reports `bug` on this path —
	// plue asked its own controller for something the controller refused,
	// which is a defect in plue.
	failure.Status = http.StatusInternalServerError
	if failure.Fault == pkgerrors.FaultUser {
		failure.Fault = pkgerrors.FaultBug
	}
	failure.RetryAfter = 0
	return failure
}

func (s *WorkspaceService) failProvisioningWorkspaceIfCurrent(ctx context.Context, workspace db.Workspace, failure workspaceFailureDetails) (db.Workspace, bool, error) {
	if conditional, ok := s.q.(workspaceProvisioningFailureQuerier); ok {
		updated, err := conditional.FailProvisioningWorkspaceIfCurrent(ctx, db.FailProvisioningWorkspaceIfCurrentParams{
			FailureCode:       string(failure.Code),
			FailureMessage:    failure.Message,
			ID:                workspace.ID,
			ExpectedStatus:    workspace.Status,
			ExpectedVmID:      workspace.VmID,
			ExpectedUpdatedAt: workspace.UpdatedAt,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return workspace, false, nil
		}
		return updated, err == nil, err
	}

	// Compatibility fallback for test doubles. Production *db.Queries always
	// implements the VM/status-fenced transition above.
	updated, err := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{
		ID:     workspace.ID,
		Status: "failed",
	})
	return updated, err == nil, err
}

func (s *WorkspaceService) failWorkspace(ctx context.Context, workspace db.Workspace, cause error) (out db.Workspace, retErr error) {
	defer func() { s.observeWorkspaceLifecycle("fail", retErr) }()
	failure := workspaceFailureDetailsFor(cause)
	if conditional, ok := s.q.(workspaceUnchangedFailureQuerier); ok {
		updated, err := conditional.FailWorkspaceIfUnchanged(ctx, db.FailWorkspaceIfUnchangedParams{
			FailureCode:       string(failure.Code),
			FailureMessage:    failure.Message,
			ID:                workspace.ID,
			ExpectedStatus:    workspace.Status,
			ExpectedVmID:      workspace.VmID,
			ExpectedUpdatedAt: workspace.UpdatedAt,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			// The stale snapshot lost to a newer lifecycle transition. That
			// transition owns the row; cleanup must neither fail nor notify it.
			return workspace, nil
		}
		if err != nil {
			return db.Workspace{}, pkgerrors.Internal("mark workspace failed: " + err.Error())
		}
		s.meterWorkspaceUsage(ctx, workspace, "failed")
		s.notifyWorkspace(ctx, workspace.ID, "failed", failure)
		return updated, nil
	}

	// Test doubles and compatibility stores that predate the conditional query
	// retain the existing interface. Production *db.Queries always takes the
	// fenced path above.
	updated, err := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{
		ID:     workspace.ID,
		Status: "failed",
	})
	if err != nil {
		return db.Workspace{}, pkgerrors.Internal("mark workspace failed: " + err.Error())
	}
	s.meterWorkspaceUsage(ctx, workspace, "failed")
	s.notifyWorkspace(ctx, workspace.ID, "failed", failure)
	return updated, nil
}

func canProvisionWorkspace(input CreateWorkspaceSessionInput) bool {
	return input.UserID > 0 && strings.TrimSpace(input.RepoOwner) != "" && strings.TrimSpace(input.RepoName) != ""
}

type workspaceVMRegistrar interface {
	RegisterWorkspaceVM(ctx context.Context, arg db.RegisterWorkspaceVMParams) (db.Workspace, error)
}

func (s *WorkspaceService) registerNewWorkspaceVM(ctx context.Context, workspace db.Workspace, vmID, status string) (db.Workspace, bool, error) {
	if registrar, ok := s.q.(workspaceVMRegistrar); ok {
		updated, err := registrar.RegisterWorkspaceVM(ctx, db.RegisterWorkspaceVMParams{
			ID:     workspace.ID,
			VmID:   vmID,
			Status: status,
		})
		if err == nil {
			return updated, false, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return db.Workspace{}, false, err
		}
		winner, loadErr := s.q.GetWorkspace(ctx, workspace.ID)
		if loadErr != nil {
			// An unknown registration outcome cannot justify deleting the VM.
			return db.Workspace{}, true, loadErr
		}
		if winner.VmID == vmID {
			return winner, true, nil
		}
		s.deleteOrphanedWorkspaceVM(ctx, vmID)
		if strings.TrimSpace(winner.VmID) != "" {
			return winner, true, nil
		}
		return db.Workspace{}, true, err
	}

	updated, err := s.q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{
		ID:     workspace.ID,
		VmID:   vmID,
		Status: status,
	})
	return updated, false, err
}

// deleteOrphanedWorkspaceVM best-effort deletes a sandbox provider VM that booted but
// could not be registered against a workspace row. sandbox provider can return a VM id
// alongside an error: the VM is running on their side even though our create
// call failed (e.g. the ready signal never arrived and the request context was
// canceled at the ~125s proxy deadline). Without this the VM leaks — a running
// 4-vCPU/8GB box plue never learns the id of — which eventually drives the user
// into quota_exceeded. Deletion runs on a detached, time-bounded context so it
// still fires even when the failure was request cancellation itself.
func (s *WorkspaceService) deleteOrphanedWorkspaceVM(ctx context.Context, vmID string) {
	vmID = strings.TrimSpace(vmID)
	if s.sandbox == nil || vmID == "" {
		return
	}
	deleteCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := s.sandbox.DeleteSandbox(deleteCtx, vmID); err != nil {
		slog.Warn("failed to delete orphaned workspace vm", "vm_id", vmID, "error", err)
	}
}

func (s *WorkspaceService) markWorkspaceProvisionFailed(ctx context.Context, workspace db.Workspace, cause error) {
	if s.q == nil {
		return
	}

	updateCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()

	failure := workspaceFailureDetailsFor(cause)
	_, transitioned, err := s.failProvisioningWorkspaceIfCurrent(updateCtx, workspace, failure)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn(
			"failed to mark workspace provisioning failure",
			"workspace_id",
			workspace.ID,
			"error",
			err,
			"cause",
			cause,
		)
		return
	}
	if transitioned {
		s.observeWorkspaceLifecycle("fail", nil)
		s.meterWorkspaceUsage(updateCtx, workspace, "failed")
		s.notifyWorkspace(updateCtx, workspace.ID, "failed", failure)
	}
}

func (s *WorkspaceService) createWorkspaceVM(ctx context.Context, workspace db.Workspace, input CreateWorkspaceSessionInput) (db.Workspace, error) {
	return s.provisionWorkspaceVM(ctx, workspace, input, false)
}

// provisionWorkspaceVM creates, or with reuse resumes, a workspace VM. Reuse
// keeps a registered vm_id so a restarted provisioner finishes the guest it
// already allocated instead of allocating a second one.
func (s *WorkspaceService) provisionWorkspaceVM(ctx context.Context, workspace db.Workspace, input CreateWorkspaceSessionInput, reuse bool) (out db.Workspace, retErr error) {
	if !reuse {
		workspace.VmID = ""
	}
	s = s.withWorkspaceIdleTimeout(workspace)
	defer func() { s.observeWorkspaceLifecycle("start", retErr) }()
	// Fast path: a NEW derived (branch) workspace forks the repo's already-warm
	// PRIMARY workspace VM — which has the toolchain baked and the repo cloned —
	// and switches the fork onto the target bookmark with a fast local jj fetch,
	// instead of cold-creating a VM and re-cloning the whole repo. Verified live
	// at ~5s (fork ~3.6s + jj switch ~1.3s) vs. the ~200s cold clone. Any
	// decline or failure falls through to the cold create+clone path below, so
	// the fork can never make provisioning worse than before.
	if workspace.VmID == "" {
		if forked, ok := s.tryForkDerivedFromPrimary(ctx, workspace, input); ok {
			return forked, nil
		}
	}

	var (
		cloneURL       string
		tempCloneToken temporaryRepoCloneToken
	)
	if !workspace.SourceSnapshotID.Valid && strings.TrimSpace(input.RepoOwner) != "" && strings.TrimSpace(input.RepoName) != "" {
		issued, err := issueTemporaryRepoCloneToken(ctx, s.q, input.UserID, "sandbox-workspace-clone")
		if err != nil {
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
			return workspace, workspaceProvisioningError("create repo clone token", err)
		}
		tempCloneToken = issued
		defer revokeTemporaryRepoCloneToken(ctx, s.q, input.UserID, tempCloneToken.ID)

		parsedCloneURL, err := buildRepoCloneURL(s.gitBaseURL, input.RepoOwner, input.RepoName)
		if err != nil {
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
			return workspace, workspaceProvisioningError("build repo clone url", err)
		}
		cloneURL = parsedCloneURL.String()
	}

	startedAt := time.Now()
	binding, err := s.resolveWorkspaceProviderBindings(ctx, workspace)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return workspace, err
	}
	vm := sandbox.CreateResult{ID: workspace.VmID}
	if vm.ID == "" {
		vm, err = s.createFreshWorkspaceVM(ctx, workspace.RepositoryID, workspace.ID, workspace.ProvisioningGeneration, workspace.Kind, binding)
	}
	duration := time.Since(startedAt)
	if s.sandboxMetrics != nil {
		status := "success"
		if err != nil {
			status = "error"
		}
		s.sandboxMetrics.ObserveSandboxVMCreate("workspace", status, duration.Seconds())
	}
	if err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		slog.Error("sandbox creation failed", "error", err, "type", "workspace")
		return workspace, workspaceProvisioningError("create sandbox", err)
	}

	// Persist the sandbox id before the in-sandbox clone runs. A clone failure
	// must leave an attributable row so cleanup can find the allocation.
	registered, wonElsewhere := workspace, false
	if workspace.VmID == "" {
		registered, wonElsewhere, err = s.registerNewWorkspaceVM(ctx, workspace, vm.ID, "starting")
	}
	if err != nil {
		if !wonElsewhere {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			if isWorkspaceActiveUniqueViolation(err) {
				return s.reuseWinningWorkspaceAfterActivationConflict(ctx, workspace)
			}
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
		}
		return workspace, workspaceProvisioningError("store sandbox info", err)
	}
	if wonElsewhere {
		return registered, nil
	}
	workspace = registered
	s.recordResolvedWorkspaceEnvironment(ctx, workspace)

	if strings.TrimSpace(cloneURL) != "" {
		if err := s.cloneWorkspaceRepository(ctx, vm.ID, cloneURL, tempCloneToken.Plaintext, input.SourceBookmark, s.workspaceCloneDepth(ctx, workspace.RepositoryID)); err != nil {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
			slog.Error("workspace repository clone failed", "error", err, "type", "workspace")
			return workspace, workspaceProvisioningError("", err)
		}
		revokeTemporaryRepoCloneToken(ctx, s.q, input.UserID, tempCloneToken.ID)
		tempCloneToken = temporaryRepoCloneToken{}
	}

	if err := s.runWorkspaceAgentEnvironmentSetup(ctx, workspace, vm.ID, binding); err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		slog.Error("workspace agent environment setup failed", "workspace_id", workspace.ID, "type", "workspace")
		return workspace, workspaceProvisioningError("", err)
	}

	workspace = s.installWorkspaceHeadReporterBestEffort(ctx, workspace, vm.ID)
	updated, err := s.q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{
		ID:     workspace.ID,
		VmID:   vm.ID,
		Status: "running",
	})
	if err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		if isWorkspaceActiveUniqueViolation(err) {
			return s.reuseWinningWorkspaceAfterActivationConflict(ctx, workspace)
		}
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return workspace, workspaceProvisioningError("store sandbox info", err)
	}
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", 1)
	}
	_ = s.q.TouchWorkspaceActivity(ctx, workspace.ID)
	_ = s.ensureWorkspaceDesktop(ctx, updated)
	s.meterWorkspaceUsage(ctx, workspace, "running")
	s.notifyWorkspace(ctx, updated.ID, "running")
	slog.Info("sandbox created", "vm_id", vm.ID, "type", "workspace", "duration_ms", duration.Milliseconds())
	return updated, nil
}

// recoverAsyncProvision converts a panic in a detached provisioning goroutine
// into a logged error + a failed workspace, instead of crashing the whole API
// process — chi's Recoverer middleware does NOT cover goroutines we spawn.
func (s *WorkspaceService) recoverAsyncProvision(ctx context.Context, workspace db.Workspace, stage string) {
	if r := recover(); r != nil {
		slog.Error("panic in async workspace provisioning", "workspace_id", workspace.ID, "stage", stage, "panic", r)
		failCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		s.markWorkspaceProvisionFailed(failCtx, workspace, fmt.Errorf("panic during %s provisioning: %v", stage, r))
	}
}

func (s *WorkspaceService) provisionWorkspaceAsync(ctx context.Context, workspace db.Workspace, input CreateWorkspaceSessionInput) {
	if s.runtime == nil && workspace.Status == "running" && strings.TrimSpace(workspace.VmID) != "" {
		s.completeRecoveredSessions(ctx, workspace.ID)
		return
	}
	if s.provisionTasks != nil {
		if _, loaded := s.provisionTasks.active.LoadOrStore(workspace.ID, true); loaded {
			return
		}
	}
	done := s.trackProvision()
	go func() {
		defer done()
		if s.provisionTasks != nil {
			defer s.provisionTasks.active.Delete(workspace.ID)
		}
		defer s.recoverAsyncProvision(ctx, workspace, "async")
		provisionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), workspaceProvisionTimeout)
		defer cancel()
		if _, err := s.ensureWorkspaceRunning(provisionCtx, workspace, input); err != nil {
			if errors.Is(err, errWorkspaceProvisionInProgress) {
				return
			}
			slog.Error("async workspace provisioning failed", "workspace_id", workspace.ID, "error", err)
			// A full pool is not a provisioning failure when the box already
			// HAS a VM: that guest is intact and suspended, and it comes back
			// on the next open. 'failed' is a terminal verdict — the UI renders
			// a dead box and the stranded-'starting' reaper DELETES a failed
			// row's VM — so the box would be lost to a condition that clears
			// itself. Park it instead. A box with no VM yet has nothing to
			// keep, so it still fails below.
			if isNoCapacityError(err) && strings.TrimSpace(workspace.VmID) != "" {
				s.suspendWorkspaceAfterNoCapacity(provisionCtx, workspace)
				return
			}
			// Drive the row to a TERMINAL 'failed' status. Without this the row
			// keeps its non-terminal status and pollers (the multi client only
			// stops on state 'failed'/'error') hang until their own 4-minute
			// deadline. markWorkspaceProvisionFailed derives its own
			// context.WithoutCancel timeout, so the provisionCtx expiring cannot
			// swallow the write.
			s.markWorkspaceProvisionFailed(provisionCtx, workspace, err)
		} else {
			s.completeRecoveredSessions(provisionCtx, workspace.ID)
		}
	}()
}

func (s *WorkspaceService) provisionSnapshotWorkspaceAsync(ctx context.Context, workspace db.Workspace, snapshot db.WorkspaceSnapshot) {
	done := s.trackProvision()
	go func() {
		defer done()
		defer s.recoverAsyncProvision(ctx, workspace, "async-snapshot")
		provisionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), workspaceProvisionTimeout)
		defer cancel()
		_, err := s.withWorkspaceProvisionLock(provisionCtx, workspace, func(current db.Workspace) (db.Workspace, error) {
			if s.runtime != nil {
				return s.restoreRuntimeWorkspaceSnapshot(provisionCtx, current, snapshot, current.UserID)
			}
			return s.createWorkspaceVMFromSnapshot(provisionCtx, current, snapshot)
		})
		if errors.Is(err, errWorkspaceProvisionInProgress) {
			return
		}
		if err != nil {
			slog.Error("async snapshot workspace provisioning failed", "workspace_id", workspace.ID, "snapshot_id", snapshot.ID, "error", err)
			s.markWorkspaceProvisionFailed(provisionCtx, workspace, err)
		}
	}()
}

// tryForkDerivedFromPrimary provisions a NEW derived (branch) workspace by
// forking the repo's primary workspace VM and switching the fork onto the
// target bookmark, avoiding the cold path's full repo re-clone. It returns
// (workspace, true) only when it fully brought the workspace to running; on
// any decline (not a derived workspace, no forkable primary) or failure it
// cleans up and returns (workspace, false) so createWorkspaceVM falls back to
// the cold create+clone path. It never leaves the workspace worse than the
// cold path would.
func (s *WorkspaceService) tryForkDerivedFromPrimary(ctx context.Context, workspace db.Workspace, input CreateWorkspaceSessionInput) (db.Workspace, bool) {
	// Only derived workspaces fork; the primary IS the repo's source of truth
	// and must clone. A fork also needs the bookmark to switch onto and repo
	// identity for the fetch auth.
	if !workspace.IsFork {
		return workspace, false
	}
	// Only containers fork (see workspaceKindForksCleanly). A vm/desktop box
	// takes the cold create path, which is the only one that sizes and boots a
	// NixOS guest correctly.
	if !workspaceKindForksCleanly(workspace.Kind) {
		return workspace, false
	}
	bookmark := strings.TrimSpace(input.SourceBookmark)
	if bookmark == "" || strings.TrimSpace(input.RepoOwner) == "" || strings.TrimSpace(input.RepoName) == "" {
		return workspace, false
	}

	// The repo's primary (is_fork=FALSE, active) workspace of the same kind is
	// the fork source. Different kinds are distinct computers and may use
	// incompatible sandbox images.
	source, err := s.q.GetActiveWorkspaceForUserRepoKind(ctx, db.GetActiveWorkspaceForUserRepoKindParams{
		RepositoryID: workspace.RepositoryID,
		UserID:       workspace.UserID,
		Kind:         workspace.Kind,
	})
	if err != nil || strings.TrimSpace(source.VmID) == "" || source.ID == workspace.ID ||
		!workspaceKindForksCleanly(source.Kind) || s.outsiderFork(ctx, workspace, source) {
		return workspace, false // no forkable primary → cold path
	}

	// Resume-then-fork: the primary is usually suspended between opens.
	source, err = s.ensureExistingWorkspaceRunning(ctx, source)
	if err != nil || strings.TrimSpace(source.VmID) == "" {
		slog.Warn("fork source resume failed; falling back to cold clone", "source_workspace_id", source.ID, "error", err)
		return workspace, false
	}

	startedAt := time.Now()
	forkCtx := sandboxProvisionContext(ctx, "fork", "workspace", workspace.ID, workspaceProvisionAttempt(workspace.ProvisioningGeneration, "primary-"+source.ID))
	binding, err := s.resolveWorkspaceProviderBindings(ctx, workspace)
	if err != nil {
		slog.Warn("fork egress policy unavailable; falling back to cold clone", "workspace_id", workspace.ID, "error", err)
		return workspace, false
	}
	vm, err := s.forkWorkspaceSandbox(forkCtx, source.VmID, workspace.Kind, binding.egress)
	if err != nil {
		// Interface implementations can return a VM id alongside an error even
		// though the real client reaps partial responses itself. Never let that
		// ambiguous fork escape unregistered.
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		slog.Warn("fork-from-primary failed; falling back to cold clone", "source_vm", source.VmID, "error", err)
		return workspace, false
	}

	// Switch the fork onto the target bookmark BEFORE registering its VM id, so
	// a switch failure just deletes the fork and falls back to cold with the
	// workspace row untouched (no stale vm_id to reconcile).
	if err := s.switchForkedWorkspaceBookmark(ctx, vm.ID, input); err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		slog.Warn("fork bookmark switch failed; falling back to cold clone", "fork_vm", vm.ID, "error", err)
		return workspace, false
	}

	if err := s.runWorkspaceAgentEnvironmentSetup(ctx, workspace, vm.ID, binding); err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		return workspace, false
	}
	updated, wonElsewhere, err := s.registerNewWorkspaceVM(ctx, workspace, vm.ID, "running")
	if err != nil {
		if !wonElsewhere {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		}
		slog.Warn("register forked workspace failed; falling back to cold clone", "fork_vm", vm.ID, "error", err)
		return workspace, false
	}
	if wonElsewhere {
		return updated, true
	}
	updated = s.installWorkspaceHeadReporterBestEffort(ctx, updated, vm.ID)

	if s.sandboxMetrics != nil {
		s.sandboxMetrics.ObserveSandboxVMCreate("workspace", "success", time.Since(startedAt).Seconds())
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", 1)
	}
	_ = s.q.TouchWorkspaceActivity(ctx, updated.ID)
	s.meterWorkspaceUsage(ctx, workspace, "running")
	s.notifyWorkspace(ctx, updated.ID, "running")
	slog.Info("workspace provisioned by fork-from-primary",
		"vm_id", vm.ID, "source_vm", source.VmID, "bookmark", bookmark,
		"duration_ms", time.Since(startedAt).Milliseconds())
	return updated, true
}

// switchForkedWorkspaceBookmark points a freshly forked VM's working copy at
// the target bookmark. The fork inherits the primary's full repo, so this is a
// fast LOCAL operation — a delta git fetch (not a re-clone) plus jj bookmark
// ops. A short-lived repo read token authenticates the fetch.
func (s *WorkspaceService) switchForkedWorkspaceBookmark(ctx context.Context, vmID string, input CreateWorkspaceSessionInput) error {
	bookmark := strings.TrimSpace(input.SourceBookmark)
	return s.runForkedWorkspaceCommand(ctx, vmID, input.UserID, func(token string) string {
		return buildForkBookmarkSwitchCommand(token, bookmark)
	})
}

// buildForkBookmarkSwitchCommand switches a forked workspace's colocated jj
// repo onto `bookmark`. Because the fork already has every git object, the
// fetch is a small delta (the server-created landing bookmark), not a
// 179MB clone. Primary workspaces without a source bookmark are plain Git
// clones, so their forks need a colocated jj repo initialized before the
// bookmark switch. Existing jj metadata is chowned because jj's secure config
// check rejects a stray root-owned .jj/repo/config-id file.
func buildForkBookmarkSwitchCommand(token, bookmark string) string {
	path := defaultWorkspaceClonePath
	user := defaultWorkspaceUser
	// jj resolves its config under $HOME/.config/jj; runuser -u does NOT set
	// HOME, so without this jj lands in root's HOME (/workspace/.config), which
	// the developer user cannot access — jj's secure-config check then fails
	// with "Permission denied". Pin HOME to the developer's own home.
	asDev := "runuser -u " + shellQuote(user) + " -- env -u JJ_CONFIG HOME=" + shellQuote(defaultWorkspaceHome) + " XDG_CONFIG_HOME=" + shellQuote(defaultWorkspaceHome+"/.config") + " USER=" + shellQuote(user) + " LOGNAME=" + shellQuote(user) + " "
	lines := []string{
		"set -euo pipefail",
		// RFD-004: the child's disk carries the parent's head reporter; stop it
		// before the first jj operation here can land on the parent's ref.
		"systemctl stop " + workspaceHeadReporterService + ".service >/dev/null 2>&1 || true",
		"if ! command -v jj >/dev/null 2>&1; then " + shellQuote(workspaceClaudeScriptPath) + "; fi",
		"command -v jj >/dev/null 2>&1",
	}
	// The bearer credential rides GIT_CONFIG_* env vars (invisible in
	// /proc/<pid>/cmdline), never an `-c http.extraHeader=…` argv flag.
	// Install jj before exporting these variables so the bootstrap process and
	// its network calls never inherit a repository credential.
	lines = append(lines, gitBearerAuthEnvExports(token)...)
	lines = append(lines,
		"if [ -d "+shellQuote(path+"/.jj")+" ]; then chown -R "+shellQuote(user)+":"+shellQuote(user)+" "+shellQuote(path+"/.jj")+"; else "+asDev+"jj git init --colocate "+shellQuote(path)+"; fi",
		asDev+"git -C "+shellQuote(path)+" fetch origin",
		asDev+"jj -R "+shellQuote(path)+" git import",
		asDev+"jj -R "+shellQuote(path)+" bookmark track "+shellQuote(bookmark+"@origin")+" 2>/dev/null || true",
		asDev+"jj -R "+shellQuote(path)+" bookmark set "+shellQuote(bookmark)+" -r "+shellQuote(bookmark+"@origin"),
		asDev+"jj -R "+shellQuote(path)+" new "+shellQuote(bookmark),
	)
	return strings.Join(lines, "\n")
}

func (s *WorkspaceService) cloneWorkspaceRepository(ctx context.Context, vmID, cloneURL, token, sourceBookmark string, depth int) error {
	cloneClient, ok := s.sandbox.(interface {
		Execute(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error)
	})
	if !ok {
		return pkgerrors.Internal("sandbox exec client unavailable")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return pkgerrors.Internal("git clone token is required")
	}
	timeoutMS := int64(180000)
	execCtx, cancel := context.WithTimeout(ctx, workspaceCloneTimeout)
	defer cancel()
	resp, err := cloneClient.Execute(execCtx, vmID, sandbox.ExecRequest{
		Command:   workspaceCloneOnce(buildWorkspaceCloneCommand(cloneURL, token, sourceBookmark, depth), workspaceCloneMarker),
		TimeoutMS: &timeoutMS,
	})
	if err != nil {
		return pkgerrors.Internal("clone workspace repository: " + err.Error())
	}
	if resp.StatusCode != nil && *resp.StatusCode != 0 {
		// Surface the VM-side stderr/stdout so a non-zero clone is diagnosable
		// (a bare status code hides which command failed, e.g. a 127).
		detail := strings.TrimSpace(resp.Stderr)
		if out := strings.TrimSpace(resp.Stdout); out != "" {
			if detail != "" {
				detail += "\n"
			}
			detail += out
		}
		if len(detail) > 1000 {
			detail = detail[len(detail)-1000:]
		}
		if detail == "" {
			return pkgerrors.Internal(fmt.Sprintf("clone workspace repository failed with status %d", *resp.StatusCode))
		}
		return pkgerrors.Internal(fmt.Sprintf("clone workspace repository failed with status %d: %s", *resp.StatusCode, detail))
	}
	return nil
}

// workspaceCloneDepthStore is the optional querier surface the per-repository
// clone-depth setting needs. *db.Queries implements it; narrow test doubles
// may omit it and get the platform default.
type workspaceCloneDepthStore interface {
	GetRepositoryCloneDepth(ctx context.Context, id int64) (int32, error)
}

// workspaceCloneDepth reads the repository's clone-depth opt-out. Any failure
// falls back to the platform default rather than to a full-history clone: a
// missing setting must not silently cost minutes of provisioning latency.
func (s *WorkspaceService) workspaceCloneDepth(ctx context.Context, repositoryID int64) int {
	store, ok := s.q.(workspaceCloneDepthStore)
	if !ok || repositoryID == 0 {
		return 0
	}
	depth, err := store.GetRepositoryCloneDepth(ctx, repositoryID)
	if err != nil {
		return 0
	}
	return int(depth)
}

// buildWorkspaceCloneCommand clones the repository into a fresh workspace VM.
//
// The clone is shallow by default. A workspace agent reads at most the coding
// flows' 100-commit history window, and `git fetch --deepen` fetches more on
// demand when a flow asks past the shallow boundary, so the whole history is latency
// nobody spends. Measured on the GitHub mirror of smithersai/plue on
// 2026-09-15: 154.1s full against 29.1s at --depth 200. `depth` follows
// sandbox.ResolveCloneDepth — zero is the platform default, negative is the
// per-repository opt-out back to full history.
func buildWorkspaceCloneCommand(cloneURL, token, sourceBookmark string, depth int) string {
	bookmark := targetWorkspaceBookmark(sourceBookmark)
	cloneFlags := "--branch " + shellQuote(bookmark)
	if resolved := sandbox.ResolveCloneDepth(depth); resolved > 0 {
		cloneFlags = "--depth " + strconv.Itoa(resolved) + " " + cloneFlags
	}
	lines := []string{"set -euo pipefail", workspaceRuntimeReadyCommand()}
	// The bearer credential rides GIT_CONFIG_* env vars (invisible in
	// /proc/<pid>/cmdline), never an `-c http.extraHeader=…` argv flag.
	lines = append(lines, gitBearerAuthEnvExports(token)...)
	// runuser -u does NOT set HOME; jj resolves its config under $HOME/.config/jj
	// and its secure-config check fails "Permission denied" when that lands in
	// root's HOME (/workspace/.config) instead of the developer-owned home. Pin
	// HOME (git config resolution wants it too) on every developer command.
	// The exec environment of an agent guest also carries XDG_CONFIG_HOME under
	// /workspace, which HOME alone does not override (jj prefers it), so pin the
	// config dir explicitly and drop any inherited JJ_CONFIG.
	asDev := "runuser -u " + shellQuote(defaultWorkspaceUser) + " -- env -u JJ_CONFIG HOME=" + shellQuote(defaultWorkspaceHome) + " XDG_CONFIG_HOME=" + shellQuote(defaultWorkspaceHome+"/.config") + " USER=" + shellQuote(defaultWorkspaceUser) + " LOGNAME=" + shellQuote(defaultWorkspaceUser) + " "
	lines = append(lines,
		"install -d -o "+shellQuote(defaultWorkspaceUser)+" -g "+shellQuote(defaultWorkspaceUser)+" "+shellQuote(defaultWorkspaceHome),
		"rm -rf "+shellQuote(defaultWorkspaceClonePath),
		asDev+"git clone "+cloneFlags+" -- "+shellQuote(cloneURL)+" "+shellQuote(defaultWorkspaceClonePath),
		"if ! command -v jj >/dev/null 2>&1; then "+shellQuote(workspaceClaudeScriptPath)+"; fi",
		"command -v jj >/dev/null 2>&1",
		// `jj git init` INITIALIZES a repo, so it must NOT be given `-R` (which
		// addresses an already-existing jj repo) — `jj -R <path> git init`
		// fails "There is no jj repo in <path>". Pass the dir as the init
		// destination instead. The later bookmark ops DO use -R (repo exists).
		asDev+"jj git init --colocate "+shellQuote(defaultWorkspaceClonePath),
		asDev+"jj -R "+shellQuote(defaultWorkspaceClonePath)+" bookmark track "+shellQuote(bookmark+"@origin"),
		asDev+"jj -R "+shellQuote(defaultWorkspaceClonePath)+" bookmark set "+shellQuote(bookmark)+" -r "+shellQuote(bookmark+"@origin"),
		asDev+"jj -R "+shellQuote(defaultWorkspaceClonePath)+" new "+shellQuote(bookmark),
	)
	return strings.Join(lines, "\n")
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func (s *WorkspaceService) createWorkspaceVMFromSnapshot(ctx context.Context, workspace db.Workspace, snapshot db.WorkspaceSnapshot) (out db.Workspace, retErr error) {
	s = s.withWorkspaceIdleTimeout(workspace)
	defer func() { s.observeWorkspaceLifecycle("start", retErr) }()
	startedAt := time.Now()
	createCtx := sandboxProvisionContext(ctx, "create", "workspace", workspace.ID, workspaceProvisionAttempt(workspace.ProvisioningGeneration, "resume-snapshot-"+snapshot.ID))
	req, err := s.buildWorkspaceVMRequest(ctx, snapshot.SnapshotID, nil, workspace.RepositoryID, workspace.ID, workspace.Kind)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return workspace, workspaceProvisioningError("", err)
	}
	binding, err := s.resolveWorkspaceProviderBindings(ctx, workspace)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return workspace, err
	}
	binding.apply(&req)
	vm, err := s.sandbox.CreateSandbox(createCtx, req)
	duration := time.Since(startedAt)
	if s.sandboxMetrics != nil {
		status := "success"
		if err != nil {
			status = "error"
		}
		s.sandboxMetrics.ObserveSandboxVMCreate("workspace", status, duration.Seconds())
	}
	if err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		slog.Error("sandbox creation failed", "error", err, "type", "workspace")
		return workspace, workspaceProvisioningError("create sandbox from snapshot", err)
	}

	registrationStatus := "running"
	if s.agentEnvironment != nil || s.providerConnections != nil || s.providerBootstrap {
		registrationStatus = "starting"
	}
	updated, wonElsewhere, err := s.registerNewWorkspaceVM(ctx, workspace, vm.ID, registrationStatus)
	if err != nil {
		if !wonElsewhere {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			if isWorkspaceActiveUniqueViolation(err) {
				return s.reuseWinningWorkspaceAfterActivationConflict(ctx, workspace)
			}
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
		}
		return workspace, workspaceProvisioningError("store sandbox info", err)
	}
	if wonElsewhere {
		return updated, nil
	}
	if s.agentEnvironment != nil || s.providerConnections != nil || s.providerBootstrap {
		workspace = updated
		if err := s.runWorkspaceAgentEnvironmentSetup(ctx, workspace, vm.ID, binding); err != nil {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
			slog.Error("workspace agent environment setup failed", "workspace_id", workspace.ID, "type", "workspace-snapshot")
			return workspace, workspaceProvisioningError("", err)
		}
		updated, err = s.q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{
			ID:     workspace.ID,
			VmID:   vm.ID,
			Status: "running",
		})
		if err != nil {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
			return workspace, workspaceProvisioningError("store sandbox info", err)
		}
	}
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", 1)
	}
	_ = s.q.TouchWorkspaceActivity(ctx, updated.ID)
	updated = s.installWorkspaceHeadReporterBestEffort(ctx, updated, vm.ID)
	s.meterWorkspaceUsage(ctx, workspace, "running")
	s.notifyWorkspace(ctx, updated.ID, "running")
	slog.Info("sandbox created", "vm_id", vm.ID, "type", "workspace", "duration_ms", duration.Milliseconds())
	return updated, nil
}

func (s *WorkspaceService) forkWorkspaceVM(ctx context.Context, workspace, source db.Workspace) (out db.Workspace, retErr error) {
	s = s.withWorkspaceIdleTimeout(workspace)
	defer func() { s.observeWorkspaceLifecycle("start", retErr) }()
	if strings.TrimSpace(source.VmID) == "" {
		// Provision-on-empty (Smithers Pair): the source workspace was never
		// provisioned, so there is nothing to fork from. Rather than 409, bind
		// a fresh VM to the fork workspace — forking nothing yields a new
		// sandbox for the session. The source row is never mutated.
		return s.provisionForkVMOnEmptySource(ctx, workspace)
	}
	if s.outsiderFork(ctx, workspace, source) {
		return s.provisionForkVMOnEmptySource(ctx, workspace)
	}
	if !workspaceKindForksCleanly(source.Kind) || !workspaceKindForksCleanly(workspace.Kind) {
		// A NixOS guest cannot be forked (see workspaceKindForksCleanly): the
		// child would boot the container defaults and be dead on arrival. Take
		// the same cold create the empty-source case takes — it sizes and boots
		// the guest from the fork workspace's own kind.
		slog.Info("fork source is not a container; cold-creating a sized sandbox instead",
			"workspace_id", workspace.ID, "workspace_kind", workspace.Kind,
			"source_workspace_id", source.ID, "source_kind", source.Kind)
		return s.provisionForkVMOnEmptySource(ctx, workspace)
	}

	startedAt := time.Now()
	forkCtx := sandboxProvisionContext(ctx, "fork", "workspace", workspace.ID, workspaceProvisionAttempt(workspace.ProvisioningGeneration, "source-"+source.ID))
	binding, err := s.resolveWorkspaceProviderBindings(ctx, workspace)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return workspace, err
	}
	vm, err := s.forkWorkspaceSandbox(forkCtx, source.VmID, workspace.Kind, binding.egress)
	duration := time.Since(startedAt)
	if s.sandboxMetrics != nil {
		status := "success"
		if err != nil {
			status = "error"
		}
		s.sandboxMetrics.ObserveSandboxVMCreate("workspace", status, duration.Seconds())
	}
	if err != nil {
		// Forking is an optimization (see workspaceForkTimeout), not the
		// session's whole job: a slow snapshot import or wedged fork request
		// must not fail the pair session. Reap any partial child and bind a
		// fresh VM to the fork workspace instead — the same cold fallback the
		// derived-workspace open path takes when its fork attempt dies.
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		slog.Warn("pair fork failed; provisioning fresh sandbox for the fork workspace",
			"source_vm", source.VmID, "error", err, "type", "workspace")
		return s.provisionForkVMOnEmptySource(ctx, workspace)
	}

	if err := s.runWorkspaceAgentEnvironmentSetup(ctx, workspace, vm.ID, binding); err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		return workspace, err
	}
	updated, wonElsewhere, err := s.registerNewWorkspaceVM(ctx, workspace, vm.ID, "running")
	if err != nil {
		if !wonElsewhere {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			if isWorkspaceActiveUniqueViolation(err) {
				return s.reuseWinningWorkspaceAfterActivationConflict(ctx, workspace)
			}
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
		}
		return workspace, workspaceProvisioningError("store forked workspace vm info", err)
	}
	if wonElsewhere {
		return updated, nil
	}
	updated = s.installWorkspaceHeadReporterBestEffort(ctx, updated, vm.ID)
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", 1)
	}
	_ = s.q.TouchWorkspaceActivity(ctx, updated.ID)
	s.meterWorkspaceUsage(ctx, workspace, "running")
	s.notifyWorkspace(ctx, updated.ID, "running")
	slog.Info("sandbox created", "vm_id", vm.ID, "type", "workspace", "duration_ms", duration.Milliseconds())
	return updated, nil
}

// provisionForkVMOnEmptySource creates a fresh sandbox provider VM for a fork whose
// source was never provisioned. It mirrors the create-fresh-VM path (no in-VM
// repo clone — the fork's lineage row already records its parent) so a pair
// session started from a cold workspace still lands a real sandbox.
func (s *WorkspaceService) provisionForkVMOnEmptySource(ctx context.Context, workspace db.Workspace) (db.Workspace, error) {
	startedAt := time.Now()
	binding, err := s.resolveWorkspaceProviderBindings(ctx, workspace)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		return workspace, err
	}
	vm, err := s.createFreshWorkspaceVM(ctx, workspace.RepositoryID, workspace.ID, workspace.ProvisioningGeneration, workspace.Kind, binding)
	duration := time.Since(startedAt)
	if s.sandboxMetrics != nil {
		status := "success"
		if err != nil {
			status = "error"
		}
		s.sandboxMetrics.ObserveSandboxVMCreate("workspace", status, duration.Seconds())
	}
	if err != nil {
		s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
		s.markWorkspaceProvisionFailed(ctx, workspace, err)
		slog.Error("sandbox creation failed", "error", err, "type", "workspace", "path", "fork-on-empty")
		return workspace, workspaceProvisioningError("create sandbox for empty-source fork", err)
	}

	registrationStatus := "running"
	if s.agentEnvironment != nil || s.providerConnections != nil || s.providerBootstrap {
		registrationStatus = "starting"
	}
	updated, wonElsewhere, err := s.registerNewWorkspaceVM(ctx, workspace, vm.ID, registrationStatus)
	if err != nil {
		if !wonElsewhere {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			if isWorkspaceActiveUniqueViolation(err) {
				return s.reuseWinningWorkspaceAfterActivationConflict(ctx, workspace)
			}
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
		}
		return workspace, workspaceProvisioningError("store sandbox info", err)
	}
	if wonElsewhere {
		return updated, nil
	}
	if s.agentEnvironment != nil || s.providerConnections != nil || s.providerBootstrap {
		workspace = updated
		if err := s.runWorkspaceAgentEnvironmentSetup(ctx, workspace, vm.ID, binding); err != nil {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
			slog.Error("workspace agent environment setup failed", "workspace_id", workspace.ID, "type", "workspace", "path", "fork-on-empty")
			return workspace, workspaceProvisioningError("", err)
		}
		updated, err = s.q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{
			ID:     workspace.ID,
			VmID:   vm.ID,
			Status: "running",
		})
		if err != nil {
			s.deleteOrphanedWorkspaceVM(ctx, vm.ID)
			s.markWorkspaceProvisionFailed(ctx, workspace, err)
			return workspace, workspaceProvisioningError("store sandbox info", err)
		}
	}
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", 1)
	}
	_ = s.q.TouchWorkspaceActivity(ctx, updated.ID)
	updated = s.installWorkspaceHeadReporterBestEffort(ctx, updated, vm.ID)
	s.meterWorkspaceUsage(ctx, workspace, "running")
	s.notifyWorkspace(ctx, updated.ID, "running")
	slog.Info("sandbox created", "vm_id", vm.ID, "type", "workspace", "path", "fork-on-empty", "duration_ms", duration.Milliseconds())
	return updated, nil
}

func (s *WorkspaceService) reuseWinningWorkspaceAfterActivationConflict(ctx context.Context, workspace db.Workspace) (db.Workspace, error) {
	// provisioning_stage updates may have refreshed updated_at after this
	// snapshot was returned. The activation-conflict loser is still safely
	// identified by its status+VM pair, not the stale-cleanup timestamp CAS.
	failure := workspaceFailureDetailsFor(errors.New("workspace activation lost to concurrent workspace"))
	if _, _, failErr := s.failProvisioningWorkspaceIfCurrent(ctx, workspace, failure); failErr != nil {
		return workspace, pkgerrors.Internal("mark workspace failed: " + failErr.Error())
	}

	active, err := s.q.GetActiveWorkspaceForUserRepoKind(ctx, db.GetActiveWorkspaceForUserRepoKindParams{
		RepositoryID: workspace.RepositoryID,
		UserID:       workspace.UserID,
		Kind:         workspace.Kind,
	})
	if err != nil {
		return workspace, pkgerrors.Internal("load winning workspace: " + err.Error())
	}
	if err := s.refuseRebuildRequired(active); err != nil {
		return workspace, err
	}
	return active, nil
}

func isWorkspaceActiveUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505" && pgErr.ConstraintName == "uq_workspaces_active"
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "uq_workspaces_active") || (strings.Contains(lower, "duplicate key") && strings.Contains(lower, "workspaces"))
}
