package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"text/template"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services/workspace_scripts"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// NixOS compute path for kind=vm and kind=desktop workspaces. The container
// kind keeps the OCI base image + apt bootstrap; vm/desktop boot the NixOS
// closure image registered for the repository (or the platform base image)
// with the worker's PID-1 init handoff, skip apt entirely, and run a slimmer
// bootstrap because the toolchain is part of the closure.

// WorkspaceEnvironmentImageResolver resolves the image a workspace boots.
// SandboxEnvironmentImageService implements it.
type WorkspaceEnvironmentImageResolver interface {
	Resolve(ctx context.Context, repositoryID int64, kind string) (runtimeports.SandboxEnvironmentImage, error)
	// Pinned is the ready image with exactly this closure, or unavailable.
	Pinned(ctx context.Context, repositoryID int64, kind, closureHash string) (runtimeports.SandboxEnvironmentImage, error)
}

// WithWorkspaceEnvironmentImages wires the NixOS environment image registry.
func WithWorkspaceEnvironmentImages(resolver WorkspaceEnvironmentImageResolver) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.environmentImages = resolver }
}

// workspaceEnvironmentImageRecorder is the optional querier surface that
// persists the resolved image on the workspace row (generated sqlc has it;
// test fakes need not).
type workspaceEnvironmentImageRecorder interface {
	SetWorkspaceEnvironmentImage(ctx context.Context, arg db.SetWorkspaceEnvironmentImageParams) error
}

var bootstrapNixTmpl = template.Must(template.New("bootstrap-nixos").Parse(workspace_scripts.BootstrapNixOSTemplate))

// workspaceNixActivationCheck is the common readiness contract for every
// interactive/exec path into a NixOS guest: systemd has completed boot and the
// login shell is reachable through the activated system profile. The /bin and
// command -v fallback keeps the check portable across older closure images.
const workspaceNixActivationCheck = `state=$(systemctl is-system-running 2>/dev/null || true); ` +
	`case "$state" in running|degraded) ` +
	`[ -x /run/current-system/sw/bin/bash ] || command -v bash >/dev/null 2>&1;; ` +
	`*) false;; esac`

// The provider runs ReadySignal services once, so the guest-side command owns
// the bounded wait. This keeps workspace/session "running" behind activation
// instead of making every first file, service, or terminal exec rediscover the
// cold-boot race independently.
const workspaceNixActivationWaitCommand = `i=0; until { ` + workspaceNixActivationCheck +
	`; }; do i=$((i + 1)); [ "$i" -lt 240 ] || exit 75; sleep 0.25; done`

// buildWorkspaceNixBootstrapScript renders the NixOS variant of the workspace
// bootstrap: ~/.local links and the npm CLI and Claude packages.
func buildWorkspaceNixBootstrapScript() string {
	claudeInstallScript := strings.Join([]string{
		"set -euo pipefail",
		fmt.Sprintf("export PATH=%q", workspaceLocalBinDir+":/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin"),
		fmt.Sprintf("export NPM_CONFIG_PREFIX=%q", workspaceLocalDir),
		fmt.Sprintf("npm install -g %q >%s 2>&1", workspaceClaudePackage, workspaceClaudeInstallLog),
	}, "; ")

	vars := bootstrapVars{
		User:                defaultWorkspaceUser,
		Home:                defaultWorkspaceHome,
		LocalDir:            workspaceLocalDir,
		LocalBinDir:         workspaceLocalBinDir,
		LocalNodeDir:        workspaceLocalNodeDir,
		NodeInstallLog:      workspaceNodeInstallLog,
		ClaudeInstallScript: claudeInstallScript,
		DownloadScript:      base64.StdEncoding.EncodeToString([]byte(workspace_scripts.DownloadReleaseScript)),
		CodingHostB64Path:   workspaceCodingHostB64Path,
		CodingHostPath:      workspaceCodingHostPath,
		JJExportB64Path:     workspaceJJExportB64Path,
		JJExportPath:        workspaceJJExportPath,
		BunVersion:          workspaceBunVersion,
		CLIPackageB64Path:   workspaceCLIPackageB64Path,
		CLIPackageDir:       workspaceCLIPackageDir,
	}
	var buf bytes.Buffer
	if err := bootstrapNixTmpl.Execute(&buf, vars); err != nil {
		panic("workspace nixos bootstrap template: " + err.Error())
	}
	return buf.String()
}

// resolveWorkspaceImage returns the NixOS image for a vm/desktop workspace.
func (s *WorkspaceService) resolveWorkspaceImage(ctx context.Context, repositoryID int64, kind string) (runtimeports.SandboxEnvironmentImage, error) {
	if s.environmentImages == nil {
		return runtimeports.SandboxEnvironmentImage{}, pkgerrors.EnvironmentImageUnavailable("kind " + normalizeWorkspaceKind(kind) + " workspaces need a registered NixOS environment image; this deployment has no image registry")
	}
	return s.environmentImages.Resolve(ctx, repositoryID, kind)
}

// applyNixGuest turns the container request into the NixOS boot for the
// given image: closure image, no apt packages, golden snapshot keyed by the
// closure (only when the caller asked for a snapshot boot), the NixOS
// bootstrap script, and for desktops the streamed session bootstrap.
func (s *WorkspaceService) applyNixGuest(req *sandbox.CreateRequest, image runtimeports.SandboxEnvironmentImage, wantSnapshot bool, snapshotID string) {
	req.Kind = sandboxKindForWorkspace(req.Kind)
	req.Image = strings.TrimSpace(image.Image)
	req.Packages = nil
	req.SnapshotID = ""
	if wantSnapshot {
		req.SnapshotID = strings.TrimSpace(snapshotID)
	}
	if req.Files == nil {
		req.Files = map[string]sandbox.SandboxFile{}
	}
	req.Files[workspaceClaudeScriptPath] = sandbox.SandboxFile{
		Content:    buildWorkspaceNixBootstrapScript(),
		Executable: true,
	}
	for i := range req.Init.Services {
		if req.Init.Services[i].Name == workspaceReadyService {
			req.Init.Services[i].Exec = []string{"/bin/sh", "-lc", workspaceNixActivationWaitCommand}
		}
	}
	if req.Kind == "desktop" {
		applyWorkspaceDesktopBoot(req, s.desktopMemoryMB, s.desktopVCPUCount)
	}
}

// nixGoldenSnapshotsEnabled gates closure-keyed golden snapshots for NixOS
// guests. OFF: Microsandbox 0.6.15 restores a disk snapshot under its own
// init, ignoring WithInit — the restored guest has no systemd, no
// /run/current-system, and every login shell (/run/current-system/sw/bin/bash)
// is missing (prod 2026-09-03 04:35Z: kind=vm workspace booted from
// msbs_… with PID 1 = init, terminal closed at once). Bare boots of a cached
// image take ~6 s, so the snapshot buys little; flip this on once the
// runtime honors the init handoff for snapshot boots.
const nixGoldenSnapshotsEnabled = false

// nixGoldenSnapshotFor returns the ready closure-keyed snapshot for an image,
// or "" — and in that case starts the bake (once per key, cluster-wide) so
// the next boot of the closure clones a disk. Registration already bakes;
// this covers images registered before snapshots were wired or whose bake
// failed.
func (s *WorkspaceService) nixGoldenSnapshotFor(ctx context.Context, image runtimeports.SandboxEnvironmentImage) string {
	if s.goldenSnapshots == nil || !nixGoldenSnapshotsEnabled {
		return ""
	}
	key := goldenSnapshotKeyForImage(image.Kind, image.ClosureHash)
	if id := s.goldenSnapshots.CurrentFor(ctx, key); id != "" {
		return id
	}
	bakeImage := image
	s.goldenSnapshots.EnsureBake(ctx, key, func() sandbox.CreateRequest { return s.NixBakeVMRequest(bakeImage) })
	return ""
}

// NixBakeVMRequest is the builder request for a closure image's golden
// snapshot: the exact kind=vm/desktop workspace request booting that image,
// repository-agnostic (repositoryID 0 binds no secret), bare (no snapshot).
func (s *WorkspaceService) NixBakeVMRequest(image runtimeports.SandboxEnvironmentImage) sandbox.CreateRequest {
	req, _ := s.buildWorkspaceVMRequestWithImage(context.Background(), "", nil, 0, "", image.Kind, &image)
	return req
}

// recordWorkspaceEnvironment persists the resolved image on the workspace row.
func (s *WorkspaceService) recordWorkspaceEnvironment(ctx context.Context, workspaceID string, image runtimeports.SandboxEnvironmentImage) {
	recorder, ok := s.q.(workspaceEnvironmentImageRecorder)
	if !ok || strings.TrimSpace(workspaceID) == "" {
		return
	}
	_ = recorder.SetWorkspaceEnvironmentImage(ctx, db.SetWorkspaceEnvironmentImageParams{
		ID:                     workspaceID,
		EnvironmentRevision:    image.SourceRevision,
		EnvironmentClosureHash: image.ClosureHash,
		EnvironmentImage:       image.Image,
	})
}

// recordResolvedWorkspaceEnvironment resolves and records the image for a
// freshly created vm/desktop workspace VM. Container workspaces are untouched.
func (s *WorkspaceService) recordResolvedWorkspaceEnvironment(ctx context.Context, workspace db.Workspace) {
	if sandboxKindForWorkspace(workspace.Kind) == "container" {
		return
	}
	image, err := s.resolveWorkspaceImage(ctx, workspace.RepositoryID, workspace.Kind)
	if err != nil {
		return
	}
	s.recordWorkspaceEnvironment(ctx, workspace.ID, image)
}

// CIGuestVMRequest is the create request for one Cloud CI task guest: the
// exact kind=vm workspace request for this repository, with the repository
// checked out at the trigger revision.
//
// Owner decision (2026-09-15): CI machines are the same NixOS machines
// workspaces boot. Sharing this builder — not a parallel one — is what makes
// that true: image resolution (the repository's registered closure, else the
// platform base), the closure-keyed golden snapshot, the per-sandbox egress
// proxy with the repository's bound secrets, the staged smithers CLI / coding
// host / jj-export helpers, and the SMITHERS_SANDBOX_WORKSPACE_* sizing knobs
// all come from one place. A second definition of the machine is exactly the
// Debian runner image this replaces.
func (s *WorkspaceService) CIGuestVMRequest(ctx context.Context, repositoryID int64, gitRepos []sandbox.GitRepositorySpec) (sandbox.CreateRequest, error) {
	// "closure" is the sentinel freshWorkspaceVMRequest uses: boot the
	// closure's golden snapshot when one is ready, the bare image otherwise.
	return s.buildWorkspaceVMRequestWithImage(ctx, "closure", gitRepos, repositoryID, "", "vm", nil)
}
