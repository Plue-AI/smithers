package services

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// allowanceMirrorGit stands in for git: its clone mirrors a local source of
// mirrorBytes of incompressible content, and its push is recorded.
type allowanceMirrorGit struct {
	t       *testing.T
	source  string
	pushEnv []string
	pushes  int
}

func newAllowanceMirrorGit(t *testing.T, contentBytes int) *allowanceMirrorGit {
	t.Helper()
	source := t.TempDir()
	run := func(args ...string) {
		out, err := exec.Command("git", append([]string{"-C", source}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run("init", "-q", "-b", "main")
	content := make([]byte, contentBytes)
	_, err := rand.Read(content)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(source, "blob"), content, 0o644))
	run("add", "blob")
	run("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "blob")
	return &allowanceMirrorGit{t: t, source: source}
}

func (g *allowanceMirrorGit) run(_ context.Context, env []string, args ...string) (string, error) {
	switch {
	case len(args) > 2 && args[0] == "clone" && args[1] == "--mirror":
		out, err := exec.Command("git", "clone", "-q", "--mirror", g.source, args[len(args)-1]).CombinedOutput()
		return string(out), err
	case strings.Contains(strings.Join(args, " "), "push --mirror"):
		g.pushes++
		g.pushEnv = env
		return "", nil
	}
	g.t.Fatalf("unexpected git %v", args)
	return "", nil
}

func (g *allowanceMirrorGit) syncStaged(svc *GitHubImportService, headers http.Header) error {
	svc.runGit = g.run
	return svc.cloneAndSyncMirror(context.Background(), "mirror.clone.staged", "octo", "demo", "",
		"https://repo-host.test/repos/provision-stages/stage-token/git", "push-capability", "job", mirrorPushArgs, headers)
}

func allowanceHeaders(allowance int64) http.Header {
	headers := make(http.Header)
	headers.Set(repohost.GitBytesAllowanceHeader, strconv.FormatInt(allowance, 10))
	return headers
}

// smithersai/plue#768: repo-host caps a staged import's mirror push at the
// allowance the push carries. git sends it on every request through
// env-based config, beside the push credential.
func TestStagedMirrorPushCarriesTheStorageAllowance(t *testing.T) {
	git := newAllowanceMirrorGit(t, 1<<10)

	require.NoError(t, git.syncStaged(&GitHubImportService{}, allowanceHeaders(1<<20)))

	assert.Equal(t, 1, git.pushes)
	assert.Contains(t, git.pushEnv, "GIT_CONFIG_COUNT=2")
	assert.Contains(t, git.pushEnv, "GIT_CONFIG_KEY_0=http.extraHeader")
	assert.Contains(t, git.pushEnv, "GIT_CONFIG_VALUE_0=Authorization: Bearer push-capability")
	assert.Contains(t, git.pushEnv, "GIT_CONFIG_KEY_1=http.extraHeader")
	assert.Contains(t, git.pushEnv, "GIT_CONFIG_VALUE_1="+repohost.GitBytesAllowanceHeader+": 1048576")
}

func TestStagedMirrorPushWithoutALimitCarriesOnlyTheCredential(t *testing.T) {
	git := newAllowanceMirrorGit(t, 1<<10)

	require.NoError(t, git.syncStaged(&GitHubImportService{}, make(http.Header)))

	assert.Equal(t, 1, git.pushes)
	assert.Contains(t, git.pushEnv, "GIT_CONFIG_COUNT=1")
	assert.NotContains(t, strings.Join(git.pushEnv, "\n"), repohost.GitBytesAllowanceHeader)
}

// A mirror larger than the allowance, measured as repo-host measures the
// stored repository, is refused before its push as the plan limit, which
// ends the import instead of retrying it.
func TestStagedMirrorLargerThanTheAllowanceIsThePlanLimit(t *testing.T) {
	git := newAllowanceMirrorGit(t, 64<<10)

	err := git.syncStaged(&GitHubImportService{}, allowanceHeaders(16<<10))

	var refusal *pkgerrors.APIError
	require.True(t, errors.As(err, &refusal), "%v", err)
	assert.Equal(t, http.StatusPaymentRequired, refusal.Status)
	assert.Equal(t, pkgerrors.CodePlanLimitExceeded, refusal.Code)
	assert.Equal(t, BillingMetricStorageBytes, refusal.LimitKind)
	assert.True(t, isTerminalGitHubImportFailure(err))
	assert.Zero(t, git.pushes, "a refused mirror is never pushed")
}

func TestStagedMirrorAtTheAllowanceIsPushed(t *testing.T) {
	git := newAllowanceMirrorGit(t, 64<<10)
	mirror := filepath.Join(t.TempDir(), "measure.git")
	out, err := exec.Command("git", "clone", "-q", "--mirror", git.source, mirror).CombinedOutput()
	require.NoError(t, err, string(out))
	mirrorBytes, err := gitMirrorObjectBytes(context.Background(), mirror)
	require.NoError(t, err)

	require.NoError(t, git.syncStaged(&GitHubImportService{}, allowanceHeaders(mirrorBytes)))

	assert.Equal(t, 1, git.pushes)
}

// stagedHeaderHost is a staged import host that supplies push headers.
type stagedHeaderHost struct {
	*candidateFallbackStagedHost
	headers http.Header
	err     error
	staged  []repohost.StagedProvision
}

func (h *stagedHeaderHost) StagedProvisionGitHeaders(_ context.Context, staged repohost.StagedProvision) (http.Header, error) {
	h.staged = append(h.staged, staged)
	return h.headers, h.err
}

func TestStagedMirrorPushHeadersComeFromTheStagedHost(t *testing.T) {
	staged := repohost.StagedProvision{OperationType: repositoryProvisionImport, Owner: "alice", Repo: "demo"}
	host := &stagedHeaderHost{candidateFallbackStagedHost: &candidateFallbackStagedHost{}, headers: allowanceHeaders(7)}

	headers, err := (&GitHubImportService{stagedRepoHost: host}).stagedMirrorPushHeaders(context.Background(), staged)

	require.NoError(t, err)
	assert.Equal(t, host.headers, headers)
	assert.Equal(t, []repohost.StagedProvision{staged}, host.staged)

	host.err = errors.New("owner usage unavailable")
	_, err = (&GitHubImportService{stagedRepoHost: host}).stagedMirrorPushHeaders(context.Background(), staged)
	require.ErrorIs(t, err, host.err)
}

// smithersai/plue#786: a staged import's push URL carries the storage
// route's capability, and git names the URL when a push fails. The import's
// failure, which its owner reads, keeps only the host.
func TestFailedStagedMirrorPushNeverNamesThePushPath(t *testing.T) {
	git := newAllowanceMirrorGit(t, 1<<10)
	const pushURL = "https://router.test/route/set/1/node/storage-set/c4p4b1l1ty5ecret/repos/provision-stages/stage-token/git"
	svc := &GitHubImportService{runGit: func(ctx context.Context, env []string, args ...string) (string, error) {
		if args[0] == "clone" {
			return git.run(ctx, env, args...)
		}
		return "fatal: unable to access '" + pushURL + "/': Could not resolve host: router.test", errors.New("exit status 128")
	}}

	err := svc.cloneAndSyncMirror(context.Background(), "mirror.clone.staged", "octo", "demo", "",
		pushURL, "push-capability", "job", mirrorPushArgs, nil)

	require.ErrorContains(t, err, "push mirrored refs")
	assert.NotContains(t, err.Error(), "c4p4b1l1ty5ecret")
	assert.NotContains(t, err.Error(), "stage-token")
	assert.Contains(t, err.Error(), "https://router.test")
	assert.Contains(t, err.Error(), "Could not resolve host")
}
