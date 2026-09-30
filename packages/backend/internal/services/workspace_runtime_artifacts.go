package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Isolated runtime creation persists its sandbox placement independently of
// the product row loaded by the caller. Re-read that placement before using
// the shared artifact installer; readiness is evidence from the guest, not
// merely a running VM. Trusted process runtimes use the operator's toolchain.
func (s *WorkspaceService) ensureRuntimeWorkspaceArtifacts(ctx context.Context, row db.Workspace, requesterID int64) error {
	if s.runtime.Isolation() != workspaceapi.IsolationSandboxed {
		return nil
	}
	// Without a compute provider, the isolated runtime owns its toolchain
	// (the single-owner microVM adapter stages its packaged host itself).
	if s.sandbox == nil {
		return nil
	}
	current, err := s.currentRuntimeWorkspaceLocked(ctx, row)
	if err != nil {
		return err
	}
	client, ok := s.sandbox.(workspaceArtifactClient)
	if !ok || client == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace artifact transport unavailable")
	}
	if strings.TrimSpace(current.VmID) == "" {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace sandbox placement unavailable")
	}
	bootstrapCtx, err := s.workspaceRuntimeContext(ctx, current, requesterID, workspaceLifecycleOperation(current, "bootstrap"))
	if err != nil {
		return err
	}
	bootstrapCtx, cancel := context.WithTimeout(bootstrapCtx, workspaceResumeProvisionTimeout)
	defer cancel()
	command := workspaceRuntimeCLIProbe()
	// A healthy running guest keeps its installed release. API deploys must
	// not replace tools beneath an active coding host. An unbootstrapped old
	// guest is repaired; suspended guests refresh on their next resume.
	if current.Status == "running" {
		probe := "if test -f " + shellQuote(workspaceArtifactCurrent+"/bootstrap.done") + " && (" + command + ") >/dev/null 2>&1; then printf ready; else printf missing; fi"
		result, err := artifactCommand(bootstrapCtx, client, current.VmID, probe, 30_000)
		if err != nil {
			return workspaceArtifactRuntimeFailure(bootstrapCtx, "inspect workspace artifacts", err)
		}
		if strings.TrimSpace(result.Stdout) == "ready" {
			return nil
		}
	}
	for _, artifact := range workspaceArtifactSources() {
		// The interactive coding host is optional; hosted Flow composition
		// ships its own host. CLI and native export remain required here.
		if artifact.target == path.Base(workspaceCodingHostB64Path) {
			continue
		}
		info, err := os.Stat(artifact.source)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, fmt.Sprintf("workspace %s artifact unavailable on host", artifact.label)).WithCause(err)
		}
	}
	guestKind := "container"
	if strings.TrimSpace(current.EnvironmentClosureHash) != "" {
		guestKind = current.Kind
	}
	if err := finishWorkspaceArtifacts(bootstrapCtx, client, current.VmID, workspaceBootstrapScriptForKind(guestKind)); err != nil {
		return workspaceArtifactRuntimeFailure(bootstrapCtx, "stage workspace artifacts", err)
	}
	if err := waitForWorkspaceArtifactBootstrap(bootstrapCtx, client, current.VmID); err != nil {
		return workspaceArtifactRuntimeFailure(bootstrapCtx, "bootstrap workspace artifacts", err)
	}
	if _, err := artifactCommand(bootstrapCtx, client, current.VmID, command, 30_000); err != nil {
		return workspaceArtifactRuntimeFailure(bootstrapCtx, "verify workspace CLI", err)
	}
	return nil
}

func workspaceArtifactRuntimeFailure(ctx context.Context, operation string, err error) error {
	if cancelled := ctx.Err(); cancelled != nil {
		if errors.Is(cancelled, context.DeadlineExceeded) {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace bootstrap timed out").WithCause(cancelled)
		}
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace bootstrap cancelled").WithCause(cancelled)
	}
	if lost := lostWorkerError(err); lost != nil {
		return lost
	}
	return pkgerrors.New(pkgerrors.CodeServiceUnavailable, operation+": "+workspaceBootstrapDiagnostic(err.Error())).WithCause(err)
}

func workspaceRuntimeCLIProbe() string {
	return "PATH=" + shellQuote(workspaceLocalBinDir+":/usr/local/bin") + ":$PATH; export PATH; " +
		"if ! test -x " + shellQuote(workspaceLocalBinDir+"/smithers") + " || ! test -x " + shellQuote(workspaceLocalBinDir+"/smthrs") + "; then echo 'workspace CLI missing: smithers or smthrs' >&2; exit 1; fi; " + shellQuote(workspaceLocalBinDir+"/smithers") + " --version"
}
