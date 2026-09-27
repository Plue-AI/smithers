package services

import (
	"archive/tar"
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// withWorkflowRunnerArtifacts points worker at a real npm CLI archive (a tar of
// node_modules/@smthrs/cli) and a jj helper, the two payloads the runner needs.
func withWorkflowRunnerArtifacts(t *testing.T, worker *WorkflowSandboxSchedulerWorker) {
	t.Helper()
	dir := t.TempDir()
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	entry := "node_modules/@smthrs/cli/bin/smithers.mjs"
	body := []byte("// fixture CLI entry\n")
	require.NoError(t, tw.WriteHeader(&tar.Header{Name: entry, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}))
	_, err := tw.Write(body)
	require.NoError(t, err)
	require.NoError(t, tw.Close())
	worker.cliPackage = filepath.Join(dir, "cli.tar")
	require.NoError(t, os.WriteFile(worker.cliPackage, archive.Bytes(), 0o644))
	worker.jjExport = filepath.Join(dir, "smithers-jj-export")
	require.NoError(t, os.WriteFile(worker.jjExport, []byte("#!/bin/sh\necho jj-export-fixture\n"), 0o755))
}

// TestWorkflowSandboxRunnerPayload_ExecutesAssembledVMFiles materializes the
// exact files a workflow VM receives and runs its runner script: it must unpack
// the staged npm CLI and jj helper and start the flow through that CLI.
func TestWorkflowSandboxRunnerPayload_ExecutesAssembledVMFiles(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash is required to execute the runner script")
	}
	worker := &WorkflowSandboxSchedulerWorker{}
	withWorkflowRunnerArtifacts(t, worker)
	req, err := worker.buildCreateVMRequest(
		db.WorkflowRun{ID: 42},
		db.WorkflowDefinition{Path: "flows/ci/flow.ts"},
		db.WorkflowStep{},
		"https://example.invalid/a/b.git",
		nil,
	)
	require.NoError(t, err)
	require.Contains(t, req.Files, workspaceCLIPackageB64Path+".part0000")
	require.Contains(t, req.Files, workspaceJJExportB64Path)

	// The guest's absolute paths are rebased under a scratch root.
	root := t.TempDir()
	rebase := func(text string) string {
		for _, prefix := range []string{"/tmp/smithers-workspace-", defaultWorkflowSandboxWorkdir, "/opt/smithers/"} {
			text = strings.ReplaceAll(text, prefix, root+prefix)
		}
		return text
	}
	for name, file := range req.Files {
		target := root + name
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		mode := os.FileMode(0o644)
		if file.Executable {
			mode = 0o755
		}
		content := file.Content
		if name == defaultWorkflowSandboxRunnerSH {
			content = rebase(content)
		}
		require.NoError(t, os.WriteFile(target, []byte(content), mode))
	}
	require.NoError(t, os.MkdirAll(root+defaultWorkflowSandboxWorkdir, 0o755))

	// A stand-in node records the entry point and arguments it was started with.
	bin := filepath.Join(root, "bin")
	require.NoError(t, os.MkdirAll(bin, 0o755))
	record := filepath.Join(root, "node-args")
	require.NoError(t, os.WriteFile(filepath.Join(bin, "node"), []byte(
		"#!/bin/sh\ntest -s \"$1\" || { echo \"missing CLI entry $1\" >&2; exit 3; }\nprintf '%s\\n' \"$@\" > "+shellQuote(record)+"\n",
	), 0o755))

	home := filepath.Join(root, "home")
	cmd := exec.CommandContext(context.Background(), "bash", root+defaultWorkflowSandboxRunnerSH)
	cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH")}
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, string(output))

	args, err := os.ReadFile(record)
	require.NoError(t, err)
	assert.Equal(t, []string{
		filepath.Join(home, ".local/lib/smithers-cli/node_modules/@smthrs/cli/bin/smithers.mjs"),
		"flow", "start", "ci", "--root", root + defaultWorkflowSandboxWorkdir,
	}, strings.Fields(string(args)))
	helper, err := os.Stat(filepath.Join(home, ".local/bin/smithers-jj-export"))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o755), helper.Mode().Perm())
	out, err := exec.Command(filepath.Join(home, ".local/bin/smithers-jj-export")).Output()
	require.NoError(t, err)
	assert.Equal(t, "jj-export-fixture\n", string(out))
}

// TestWorkflowSandboxRunnerPayload_MissingArtifactsRefuseTheVM fails the
// request on the host rather than booting a VM whose runner cannot start.
func TestWorkflowSandboxRunnerPayload_MissingArtifactsRefuseTheVM(t *testing.T) {
	t.Parallel()
	for _, missing := range []string{"cli", "jj"} {
		worker := &WorkflowSandboxSchedulerWorker{}
		withWorkflowRunnerArtifacts(t, worker)
		if missing == "cli" {
			worker.cliPackage = filepath.Join(t.TempDir(), "absent.tar")
		} else {
			worker.jjExport = filepath.Join(t.TempDir(), "absent")
		}
		req, err := worker.buildCreateVMRequest(db.WorkflowRun{ID: 1}, db.WorkflowDefinition{}, db.WorkflowStep{}, "https://example.invalid/a/b.git", nil)
		require.Error(t, err, missing)
		assert.Equal(t, sandbox.CreateRequest{}, req, missing)
	}
}

// newRunnableWorkflowSandboxScheduler is NewWorkflowSandboxSchedulerWorker
// with the runner payloads every orchestrator VM requires.
func newRunnableWorkflowSandboxScheduler(
	t *testing.T,
	queries WorkflowSandboxSchedulerQuerier,
	sandboxClient WorkflowSandboxVMClient,
	opts ...WorkflowSandboxSchedulerOption,
) *WorkflowSandboxSchedulerWorker {
	t.Helper()
	worker := NewWorkflowSandboxSchedulerWorker(queries, sandboxClient, opts...)
	withWorkflowRunnerArtifacts(t, worker)
	return worker
}
