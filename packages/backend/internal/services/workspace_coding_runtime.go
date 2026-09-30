package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// workspaceHelperRefreshRoot holds a helper replacement's transfer parts in
// the guest until they are installed. Like the helper, it is root-owned.
const workspaceHelperRefreshRoot = "/var/lib/smithers/workspace-helper"

// workspaceHelperTransferName names the parts of one helper transfer.
const workspaceHelperTransferName = "smithers-jj-export.b64"

// ensureWorkspaceCodingRuntime checks that a running guest carries exactly the
// helper of this backend release and names the expected owner. A box keeps the
// helper of the release that created it, so a missing or older helper is
// replaced in place and checked again (#3111).
func (s *WorkspaceService) ensureWorkspaceCodingRuntime(ctx context.Context, workspace db.Workspace) error {
	check := func() error {
		current, err := s.loadOwnedWorkspace(ctx, workspace.ID, workspace.RepositoryID, workspace.UserID)
		if err != nil {
			return err
		}
		if current.ID != workspace.ID || current.RepositoryID != workspace.RepositoryID || current.UserID != workspace.UserID ||
			current.VmID != workspace.VmID || current.VmID == "" || current.Status != "running" || current.DeletedAt.Valid {
			return codingHostUnavailable("workspace changed before native runtime verification; retry")
		}
		return nil
	}
	if err := check(); err != nil {
		return err
	}
	source := strings.TrimSpace(os.Getenv(workspaceJJExportBinaryEnv))
	if source == "" {
		return codingHostUnavailable("workspace helper binary is not configured")
	}
	expected, err := workspaceHelperDigest(source)
	if err != nil {
		return err
	}
	client, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return codingHostUnavailable("workspace helper cannot be verified")
	}
	user := strings.TrimSpace(s.workspaceUsername)
	if user == "" {
		user = defaultWorkspaceUser
	}
	installed, configured, err := inspectWorkspaceHelper(ctx, client, workspace, user)
	if err != nil {
		return err
	}
	if installed != expected {
		started := time.Now()
		if err := refreshWorkspaceHelper(ctx, s.sandbox, workspace.VmID, source, expected); err != nil {
			slog.Warn("workspace helper refresh failed", "workspace_id", workspace.ID, "vm_id", workspace.VmID,
				"previous_sha256", installed, "sha256", expected, "error", err)
			return codingHostUnavailable("workspace helper could not be refreshed; retry")
		}
		slog.Info("workspace helper refreshed", "workspace_id", workspace.ID, "vm_id", workspace.VmID,
			"previous_sha256", installed, "sha256", expected, "duration_ms", time.Since(started).Milliseconds())
		if installed, configured, err = inspectWorkspaceHelper(ctx, client, workspace, user); err != nil {
			return err
		}
		if installed != expected {
			// Another backend release replaced it again (a rolling deploy).
			return codingHostUnavailable("workspace helper changed while it was refreshed; retry")
		}
	}
	if !configured {
		return codingHostUnavailable("workspace coding configuration does not name this workspace")
	}
	return check()
}

// workspaceHelperDigest is the SHA-256 of this release's helper, the one every
// guest must run.
func workspaceHelperDigest(source string) (string, error) {
	file, err := os.Open(source)
	if err != nil {
		return "", codingHostUnavailable("workspace helper binary is unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 64<<20 {
		return "", codingHostUnavailable("workspace helper binary has an invalid size or type")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", codingHostUnavailable("workspace helper binary could not be verified")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// inspectWorkspaceHelper answers the digest of the guest's helper ("" when it
// has none) and whether that helper accepts the box's coding configuration.
func inspectWorkspaceHelper(ctx context.Context, client sandboxExecClient, workspace db.Workspace, user string) (string, bool, error) {
	timeout := int64(15000)
	result, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{
		Command: buildWorkspaceCodingRuntimeCommand(workspace, user), TimeoutMS: &timeout,
	})
	if err != nil || result.StatusCode == nil || len(result.Stdout) > 256 {
		return "", false, codingHostUnavailable("workspace helper could not be checked; retry")
	}
	digest, verdict, _ := strings.Cut(strings.TrimSpace(result.Stdout), "\n")
	if decoded, err := hex.DecodeString(digest); err != nil || len(decoded) != sha256.Size || digest != strings.ToLower(digest) {
		digest = ""
	}
	return digest, *result.StatusCode == 0 && strings.TrimSpace(verdict) == "ok", nil
}

// refreshWorkspaceHelper replaces the guest's helper with this release's. The
// bytes stream through the bounded artifact transfer; the guest checks their
// digest before one rename, so a helper that is running keeps its old file and
// no caller ever runs a partial one.
func refreshWorkspaceHelper(ctx context.Context, provider any, vmID, source, digest string) error {
	client, ok := provider.(workspaceArtifactClient)
	if !ok {
		return errors.New("workspace provider lacks file transfer")
	}
	directory := workspaceHelperRefreshRoot + "/" + uuid.NewString()
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, _ = artifactCommand(cleanup, client, vmID, "rm -rf -- "+shellQuote(directory))
	}()
	if _, err := artifactCommand(ctx, client, vmID, "mkdir -p -m 0700 -- "+shellQuote(directory)); err != nil {
		return err
	}
	if err := streamWorkspaceArtifactChecked(ctx, client, vmID, source, directory+"/"+workspaceHelperTransferName, digest); err != nil {
		return err
	}
	_, err := artifactCommand(ctx, client, vmID, buildWorkspaceHelperInstallCommand(directory, digest))
	return err
}

// buildWorkspaceHelperInstallCommand decodes one transfer beside the helper,
// refuses bytes with another digest, and renames them over the helper.
func buildWorkspaceHelperInstallCommand(directory, digest string) string {
	return strings.Join([]string{
		"set -eu",
		"staged=" + shellQuote(path.Dir(workspaceJJExportPath)+"/.smithers-jj-export."+path.Base(directory)),
		`trap 'rm -f -- "$staged"' EXIT`,
		"mkdir -p -- " + shellQuote(path.Dir(workspaceJJExportPath)),
		"cat " + shellQuote(directory+"/"+workspaceHelperTransferName) + `.part* | base64 -d | gzip -dc > "$staged"`,
		`test "$(sha256sum < "$staged" | cut -d ' ' -f 1)" = ` + shellQuote(digest),
		`chmod 0755 "$staged"`,
		`mv -f -- "$staged" ` + shellQuote(workspaceJJExportPath),
	}, "\n")
}

func buildWorkspaceCodingRuntimeCommand(workspace db.Workspace, user string) string {
	asDev := "runuser -u " + shellQuote(user) + " -- env -u JJ_CONFIG HOME=" + shellQuote(defaultWorkspaceHome) +
		" XDG_CONFIG_HOME=" + shellQuote(defaultWorkspaceHome+"/.config") + " USER=" + shellQuote(user) + " LOGNAME=" + shellQuote(user) + " "
	return strings.Join([]string{
		"set -eu",
		"test -x " + shellQuote(workspaceJJExportPath),
		"sha256sum " + shellQuote(workspaceJJExportPath) + " | cut -d ' ' -f 1",
		asDev + shellQuote(workspaceJJExportPath) + " --check-config " + shellQuote(defaultWorkspaceClonePath) +
			" " + shellQuote(workspace.ID) + " " + shellQuote(fmt.Sprint(workspace.UserID)),
	}, "\n")
}

func codingHostUnavailable(message string) *pkgerrors.APIError {
	return &pkgerrors.APIError{Status: 409, Code: pkgerrors.CodeCodingHostUnavailable, Message: message}
}
