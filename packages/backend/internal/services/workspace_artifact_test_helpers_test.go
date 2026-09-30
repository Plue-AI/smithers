package services

import (
	"context"
	"os"
	"strings"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Collect only the small artifact fixtures used by bootstrap execution tests.
// Production streams each piece to the provider, never into a files map.
func collectWorkspaceArtifact(files map[string]sandbox.SandboxFile, source, target string) bool {
	info, err := os.Stat(source)
	if err != nil || info.Size() == 0 {
		return false
	}
	client := &mockWorkspaceSandboxVMClient{writeFileFn: func(_ context.Context, _ string, p string, req sandbox.WriteFileRequest) error {
		files[p] = sandbox.SandboxFile{Content: req.Content}
		return nil
	}}
	return streamWorkspaceArtifact(context.Background(), client, "test", source, target) == nil
}
func addWorkspaceCLI(files map[string]sandbox.SandboxFile) bool {
	return collectWorkspaceArtifact(files, workspaceCLIPackage(), workspaceCLIPackageB64Path)
}
func addWorkspaceCodingHost(files map[string]sandbox.SandboxFile) bool {
	source := strings.TrimSpace(os.Getenv(workspaceCodingHostBinaryEnv))
	if source == "" {
		source = workspaceCodingHostPath
	}
	return collectWorkspaceArtifact(files, source, workspaceCodingHostB64Path)
}
func addWorkspaceJJExport(files map[string]sandbox.SandboxFile) bool {
	return collectWorkspaceArtifact(files, workspaceJJExport(), workspaceJJExportB64Path)
}

func isWorkspaceArtifactCommand(command string) bool {
	command = strings.TrimPrefix(command, workspaceArtifactGuestPath)
	return strings.Contains(command, workspaceArtifactRoot) && (strings.HasPrefix(command, "owner=$(cat ") || strings.HasPrefix(command, "if ! test -L ") || strings.HasPrefix(command, `if test "$(readlink `) || strings.HasPrefix(command, "mkdir -p -- ") || strings.HasPrefix(command, "exec 9>") || strings.HasPrefix(command, "tail -c "))
}
