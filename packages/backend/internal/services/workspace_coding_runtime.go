package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Provisioning stages one native executable; a running guest must still carry
// exactly the executable from this backend release and the expected owner.
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
	path := strings.TrimSpace(os.Getenv(workspaceJJExportBinaryEnv))
	if path == "" {
		return codingHostUnavailable("workspace helper binary is not configured")
	}
	file, err := os.Open(path)
	if err != nil {
		return codingHostUnavailable("workspace helper binary is unavailable")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 64<<20 {
		file.Close()
		return codingHostUnavailable("workspace helper binary has an invalid size or type")
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return codingHostUnavailable("workspace helper binary could not be verified")
	}
	expected := hex.EncodeToString(hash.Sum(nil))
	client, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return codingHostUnavailable("workspace helper cannot be verified")
	}
	user := strings.TrimSpace(s.workspaceUsername)
	if user == "" {
		user = defaultWorkspaceUser
	}
	timeout := int64(15000)
	result, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{
		Command: buildWorkspaceCodingRuntimeCommand(workspace, user), TimeoutMS: &timeout,
	})
	if err != nil || result.StatusCode == nil || *result.StatusCode != 0 || len(result.Stdout) > 256 ||
		strings.TrimSpace(result.Stdout) != expected+"\nok" {
		return codingHostUnavailable("workspace helper does not match this backend release; reprovision the workspace")
	}
	return check()
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
