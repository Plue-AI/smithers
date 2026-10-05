package services

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// apiErrorOf unwraps the typed failure a service returned, so a test can ask
// what verdict the call site CHOSE rather than what WriteError backfilled
// later from the status.
func apiErrorOf(t *testing.T, err error) *pkgerrors.APIError {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *pkgerrors.APIError, got %T: %v", err, err)
	return apiErr
}

// TestGitHubUpstreamFailuresBlameGitHub pins the GitHub-facing 502s onto a code
// that names GitHub.
//
// They used to answer with no code at all, so WriteError backfilled
// `bad_gateway` — "an upstream service plue depends on answered in a way plue
// could not use", which is true of every upstream and identifies none. A
// client cannot write "GitHub is having trouble, your repository is fine" off
// that. github_unavailable can be said out loud.
func TestGitHubUpstreamFailuresBlameGitHub(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)
	for name, status := range map[string]int{
		"upstream 500": http.StatusInternalServerError,
		"upstream 502": http.StatusBadGateway,
		"upstream 503": http.StatusServiceUnavailable,
	} {
		t.Run(name, func(t *testing.T) {
			resp := &http.Response{StatusCode: status, Header: http.Header{}}
			apiErr := apiErrorOf(t, gitHubRepoMetadataUpstreamError(resp, now))
			assert.Equal(t, pkgerrors.CodeGitHubUnavailable, apiErr.Code)
			assert.Equal(t, pkgerrors.FaultDependency, apiErr.Fault,
				"GitHub failing us is neither the caller's fault nor a plue defect")
			assert.Equal(t, http.StatusBadGateway, apiErr.Status)
		})
	}

	// An invisible required resource is a GitHub permission failure.
	notFound := apiErrorOf(t, gitHubRepoMetadataUpstreamError(
		&http.Response{StatusCode: http.StatusNotFound, Header: http.Header{}}, now))
	assert.Equal(t, pkgerrors.CodeGitHubPermission, notFound.Code)
	assert.Equal(t, pkgerrors.FaultDependency, notFound.Fault)

	// A diagnosis that could not reach GitHub is the same verdict.
	assert.Equal(t, pkgerrors.CodeGitHubUnavailable, badGateway("github is unreachable").Code)
}

// TestSearchValidationNamesItsOwnCode proves the search validators no longer
// lean on WriteError's status backfill. The bytes on the wire are unchanged —
// that is the point: a call site that states its code keeps stating it if the
// status ever moves, and the errcodecheck guard can see it.
func TestSearchValidationNamesItsOwnCode(t *testing.T) {
	t.Parallel()

	svc := NewSearchService(nil)
	long := make([]byte, searchMaxQueryLen+1)
	for i := range long {
		long[i] = 'a'
	}

	_, err := svc.SearchRepositories(t.Context(), nil, SearchRepositoriesInput{Query: "   "})
	empty := apiErrorOf(t, err)
	assert.Equal(t, pkgerrors.CodeUnprocessableEntity, empty.Code)
	assert.Equal(t, pkgerrors.FaultUser, empty.Fault)

	_, err = svc.SearchIssues(t.Context(), nil, SearchIssuesInput{Query: string(long)})
	tooLong := apiErrorOf(t, err)
	assert.Equal(t, pkgerrors.CodeBadRequest, tooLong.Code)
	assert.Equal(t, pkgerrors.FaultUser, tooLong.Fault)

	_, err = svc.SearchIssues(t.Context(), nil, SearchIssuesInput{Query: "q", State: "ajar"})
	badState := apiErrorOf(t, err)
	assert.Equal(t, pkgerrors.CodeUnprocessableEntity, badState.Code)
}

// TestWorkerRuntimeFailureIsInfraNotADefect: runtime_error is what a worker
// answers when its VMM, its snapshot restore, or its guest transport failed on
// one machine. Calling that a plue defect means the app apologizes for a bug
// when the honest thing to say is that a machine broke and another may work.
func TestWorkerRuntimeFailureIsInfraNotADefect(t *testing.T) {
	t.Parallel()

	entry, ok := pkgerrors.Lookup(pkgerrors.CodeSandboxRuntimeError)
	require.True(t, ok)
	assert.Equal(t, pkgerrors.FaultInfra, entry.Fault)
}

// TestResumePathKeepsTheControllersVerdict is the headline of the sandbox-tier
// sweep.
//
// ensureWorkspaceRunning (the session-CREATE path) and
// ensureExistingWorkspaceRunning (the RESUME path, reached by resume, SSH,
// terminals, language servers, file facets, coding, fork and agent runs) are
// line-for-line parallel except for one thing: the create path funneled its
// failures through workspaceProvisioningError, which reads the controller's
// own code back through ParseCode, and the resume path wrapped them in
// Internal(), which threw that verdict on the floor.
//
// So a draining worker, a dead egress proxy or an unreachable controller told
// every user on the resume path the same thing — code `internal`, fault `bug`,
// "internal server error" — which is plue apologizing for a defect it does not
// have while the app has no way to say "one of our machines went down".
func TestResumePathKeepsTheControllersVerdict(t *testing.T) {
	workspace := sampleDBWorkspace("ws-resume")
	workspace.VmID = "vm-1"

	for name, controllerCode := range map[string]pkgerrors.Code{
		"a draining worker":     pkgerrors.CodeWorkerDraining,
		"a dead egress proxy":   pkgerrors.CodeEgressProxyUnavailable,
		"a broken worker VMM":   pkgerrors.CodeSandboxRuntimeError,
		"an unreachable worker": pkgerrors.CodeWorkerError,
	} {
		t.Run(name, func(t *testing.T) {
			svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
				WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
					getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
						return sandbox.Sandbox{}, &sandbox.StatusError{
							StatusCode: http.StatusServiceUnavailable,
							Code:       string(controllerCode),
							Message:    "the controller said so",
						}
					},
				}))

			_, err := svc.ensureExistingWorkspaceRunning(context.Background(), workspace)
			failure := apiErrorOf(t, err)
			assert.Equal(t, controllerCode, failure.Code,
				"the controller named the failure; the resume path must not rename it `internal`")
			assert.Equal(t, pkgerrors.FaultInfra, failure.Fault,
				"a machine of plue's broke; the app must be able to say 'not your fault'")
			// The status is still pinned to 500 — plue drove that request, so
			// the controller's own surface status does not transfer — and
			// writeRouteError still sanitizes the sentence.
			assert.Equal(t, http.StatusInternalServerError, failure.Status)
		})
	}
}
