package services

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func prepareRuntimeTestHelper(t *testing.T) {
	t.Helper()
	artifact := filepath.Join(t.TempDir(), "smithers-jj-export")
	require.NoError(t, os.WriteFile(artifact, []byte("packaged native helper"), 0755))
	t.Setenv(workspaceJJExportBinaryEnv, artifact)
}

func runtimeTestReceipt(t *testing.T, _ db.Workspace, _ string) string {
	t.Helper()
	body, err := os.ReadFile(os.Getenv(workspaceJJExportBinaryEnv))
	require.NoError(t, err)
	digest := sha256.Sum256(body)
	return fmt.Sprintf("%x\nok\n", digest)
}

func TestWorkspaceCodingRuntime_VerifiesPackagedHelperAndOwner(t *testing.T) {
	workspace := sampleDBWorkspace("8e597e64-7252-49f1-bb27-b97603589969")
	artifact := filepath.Join(t.TempDir(), "smithers-jj-export")
	body := []byte("packaged native helper")
	require.NoError(t, os.WriteFile(artifact, body, 0755))
	t.Setenv(workspaceJJExportBinaryEnv, artifact)
	digest := sha256.Sum256(body)
	want := fmt.Sprintf("%x\nok", digest)
	zero := int32(0)
	respond := want
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
		if !strings.Contains(request.Command, "--check-config") {
			return sandbox.ExecResult{StatusCode: &zero}, nil // the helper refresh
		}
		require.Contains(t, request.Command, shellQuote(workspaceJJExportPath)+" --check-config")
		require.Contains(t, request.Command, workspace.ID)
		require.Contains(t, request.Command, "sha256sum "+shellQuote(workspaceJJExportPath))
		require.NotContains(t, request.Command, "python")
		return sandbox.ExecResult{StatusCode: &zero, Stdout: respond + "\n"}, nil
	}}
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
	require.NoError(t, svc.ensureWorkspaceCodingRuntime(context.Background(), workspace))
	respond = strings.Repeat("0", 64) + "\nok"
	require.Error(t, svc.ensureWorkspaceCodingRuntime(context.Background(), workspace))
}

func TestWorkspaceCodingRuntime_RefusesAbsentHostBinary(t *testing.T) {
	workspace := sampleDBWorkspace("8e597e64-7252-49f1-bb27-b97603589969")
	t.Setenv(workspaceJJExportBinaryEnv, filepath.Join(t.TempDir(), "missing"))
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	require.Error(t, svc.ensureWorkspaceCodingRuntime(context.Background(), workspace))
}

// helperBox is one running box at the provider boundary. Its helper is a file
// under root; the box's probe reports that file's digest, and the helper
// refresh runs for real against root. The source publisher probe and every
// other command succeed.
type helperBox struct {
	*mockWorkspaceSandboxVMClient
	root         string
	publisherOff bool  // the source publisher is not running
	unconfigured bool  // the coding configuration names another owner
	unreachable  error // the provider cannot run the probe
	failWrites   bool  // file transfer into the box fails
	writes       int
}

func newHelperBox(t *testing.T, helper []byte) *helperBox {
	t.Helper()
	box := &helperBox{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}, root: t.TempDir()}
	require.NoError(t, os.MkdirAll(box.local(path.Dir(workspaceJJExportPath)), 0o755))
	if helper != nil {
		require.NoError(t, os.WriteFile(box.local(workspaceJJExportPath), helper, 0o755))
	}
	return box
}

func (b *helperBox) local(guest string) string {
	bin := path.Dir(workspaceJJExportPath)
	return strings.NewReplacer(bin, b.root+bin, workspaceHelperRefreshRoot, b.root+workspaceHelperRefreshRoot).Replace(guest)
}

func (b *helperBox) installed(t *testing.T) []byte {
	t.Helper()
	helper, err := os.ReadFile(b.local(workspaceJJExportPath))
	require.NoError(t, err)
	return helper
}

func (b *helperBox) WriteFile(_ context.Context, _ string, guest string, req sandbox.WriteFileRequest) error {
	b.writes++
	if b.failWrites {
		return errors.New("transfer interrupted")
	}
	target := b.local(guest)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	return os.WriteFile(target, []byte(req.Content), 0o600)
}

func (b *helperBox) Execute(ctx context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	status := int32(0)
	switch {
	case strings.Contains(req.Command, "--check-config"):
		if b.unreachable != nil {
			return sandbox.ExecResult{}, b.unreachable
		}
		helper, err := os.ReadFile(b.local(workspaceJJExportPath))
		if err != nil { // test -x fails before the probe prints anything
			status = 1
			return sandbox.ExecResult{StatusCode: &status}, nil
		}
		digest := fmt.Sprintf("%x\n", sha256.Sum256(helper))
		if b.unconfigured {
			status = 1
			return sandbox.ExecResult{StatusCode: &status, Stdout: digest}, nil
		}
		return sandbox.ExecResult{StatusCode: &status, Stdout: digest + "ok\n"}, nil
	case strings.Contains(req.Command, "test -S"):
		if b.publisherOff {
			status = 1
		}
		return sandbox.ExecResult{StatusCode: &status}, nil
	case strings.Contains(req.Command, workspaceHelperRefreshRoot):
		command := exec.CommandContext(ctx, "/bin/sh", "-c", b.local(req.Command))
		var stdout, stderr strings.Builder
		command.Stdout, command.Stderr = &stdout, &stderr
		if err := command.Run(); err != nil {
			var exit *exec.ExitError
			if !errors.As(err, &exit) {
				return sandbox.ExecResult{}, err
			}
			status = int32(exit.ExitCode())
		}
		return sandbox.ExecResult{StatusCode: &status, Stdout: stdout.String(), Stderr: stderr.String()}, nil
	}
	return sandbox.ExecResult{StatusCode: &status}, nil
}

func releaseHelper(t *testing.T, body string) []byte {
	t.Helper()
	artifact := filepath.Join(t.TempDir(), "smithers-jj-export")
	require.NoError(t, os.WriteFile(artifact, []byte(body), 0o755))
	t.Setenv(workspaceJJExportBinaryEnv, artifact)
	return []byte(body)
}

func helperBoxHost(t *testing.T, box *helperBox) (*WorkspaceService, db.Workspace) {
	t.Helper()
	workspace := db.Workspace{ID: "workspace-3111", RepositoryID: 77, UserID: 9, VmID: "vm-3111", Status: "running", TargetBookmark: "main", Kind: "container"}
	q := &boxHostTestQuerier{workspaceHeadTestQuerier: &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return workspace, nil },
	}}}
	return newWorkspaceServiceForTests(q, WithWorkspaceGitBaseURL("https://api.jjhub.tech"), WithWorkspaceSandboxClient(box)), workspace
}

// A box keeps the helper of the release that created it. Starting its host
// after a backend release replaces that helper once, in place, whether or not
// the source publisher survived; before #3111 the start was refused forever
// and every poll bumped the host's owner generation.
func TestPrepareBoxHostRefreshesAHelperFromAnEarlierRelease(t *testing.T) {
	for _, tc := range []struct {
		name         string
		installed    []byte
		publisherOff bool
	}{
		{"publisher running", []byte("helper built by the previous release"), false},
		{"publisher reinstalled", []byte("helper built by the previous release"), true},
		{"helper absent", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			release := releaseHelper(t, "helper built by this release")
			box := newHelperBox(t, tc.installed)
			box.publisherOff = tc.publisherOff
			svc, workspace := helperBoxHost(t, box)

			_, err := svc.PrepareBoxHost(t.Context(), "host-1", workspace.ID, workspace.RepositoryID, workspace.UserID)
			require.NoError(t, err)
			require.Equal(t, release, box.installed(t), "the box runs this release's helper")
			info, err := os.Stat(box.local(workspaceJJExportPath))
			require.NoError(t, err)
			require.Equal(t, os.FileMode(0o755), info.Mode().Perm())
			transfers := box.writes
			require.Positive(t, transfers)
			leftovers, err := os.ReadDir(box.local(workspaceHelperRefreshRoot))
			require.NoError(t, err)
			require.Empty(t, leftovers, "the transfer parts are removed")
			binDir, err := os.ReadDir(box.local(path.Dir(workspaceJJExportPath)))
			require.NoError(t, err)
			require.Len(t, binDir, 1, "no staged copy is left beside the helper")

			box.publisherOff = false
			_, err = svc.PrepareBoxHost(t.Context(), "host-2", workspace.ID, workspace.RepositoryID, workspace.UserID)
			require.NoError(t, err)
			require.Equal(t, transfers, box.writes, "a box that carries this release's helper is not refreshed again")
		})
	}
}

func TestWorkspaceCodingRuntime_HealthyBoxIsNeverRefreshed(t *testing.T) {
	release := releaseHelper(t, "helper built by this release")
	box := newHelperBox(t, release)
	svc, workspace := helperBoxHost(t, box)
	for range 3 {
		require.NoError(t, svc.ensureWorkspaceCodingRuntime(t.Context(), workspace))
	}
	require.Zero(t, box.writes)
}

// A refresh that cannot finish is a retryable start failure, never a reason
// to rebuild the box: the helper is left as it was, with no parts behind.
func TestWorkspaceCodingRuntime_FailedRefreshIsRetryable(t *testing.T) {
	releaseHelper(t, "helper built by this release")
	previous := []byte("helper built by the previous release")
	box := newHelperBox(t, previous)
	box.failWrites = true
	svc, workspace := helperBoxHost(t, box)

	err := svc.ensureWorkspaceCodingRuntime(t.Context(), workspace)
	require.ErrorContains(t, err, "workspace helper could not be refreshed; retry")
	require.Equal(t, previous, box.installed(t))
	_, statErr := os.Stat(box.local(workspaceHelperRefreshRoot))
	if statErr == nil {
		leftovers, err := os.ReadDir(box.local(workspaceHelperRefreshRoot))
		require.NoError(t, err)
		require.Empty(t, leftovers)
	}

	box.failWrites = false
	require.NoError(t, svc.ensureWorkspaceCodingRuntime(t.Context(), workspace), "the next start refreshes it")
}

// Only a helper from another release is refreshed. A box the provider cannot
// reach, or whose coding configuration names another owner, is refused with
// its own reason and nothing is transferred.
func TestWorkspaceCodingRuntime_RefusesWithoutRefreshingForOtherFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		box  func(*helperBox)
		want string
	}{
		{"unreachable", func(b *helperBox) { b.unreachable = errors.New("microsandbox api returned status 404") }, "workspace helper could not be checked; retry"},
		{"unconfigured", func(b *helperBox) { b.unconfigured = true }, "workspace coding configuration does not name this workspace"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			release := releaseHelper(t, "helper built by this release")
			box := newHelperBox(t, release)
			tc.box(box)
			svc, workspace := helperBoxHost(t, box)
			require.ErrorContains(t, svc.ensureWorkspaceCodingRuntime(t.Context(), workspace), tc.want)
			require.Zero(t, box.writes)
		})
	}
}

// The guest checks the decoded digest before it replaces the helper, so a
// transfer that decodes to other bytes never becomes the box's helper.
func TestWorkspaceHelperInstallCommandRefusesOtherBytes(t *testing.T) {
	release := releaseHelper(t, "helper built by this release")
	box := newHelperBox(t, []byte("helper built by the previous release"))
	source := os.Getenv(workspaceJJExportBinaryEnv)
	digest := fmt.Sprintf("%x", sha256.Sum256(release))
	directory := workspaceHelperRefreshRoot + "/transfer"
	require.NoError(t, streamWorkspaceArtifact(t.Context(), box, "vm-3111", source, directory+"/"+workspaceHelperTransferName))
	_, err := artifactCommand(t.Context(), box, "vm-3111", buildWorkspaceHelperInstallCommand(directory, strings.Repeat("0", 64)))
	require.Error(t, err)
	require.Equal(t, []byte("helper built by the previous release"), box.installed(t))
	_, err = artifactCommand(t.Context(), box, "vm-3111", buildWorkspaceHelperInstallCommand(directory, digest))
	require.NoError(t, err)
	require.Equal(t, release, box.installed(t))
}
