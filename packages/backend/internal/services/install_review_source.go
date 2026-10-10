package services

import (
	"context"
	"io/fs"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// reviewSourceRetention keeps the admitted PR head and base under the review
// machine's own workspace source refs. The backend reads GitHub with the
// install's credentials; none reaches the machine.
type reviewSourceRetention interface {
	Retain(context.Context, int64, int64, RepositorySourceRetentionInput) (RepositorySourceRetentionResult, error)
}

// ReviewSource is the read-only pinned source boundary of a review machine.
// Restore checks the admitted PR head out, detached, beside its base and the
// Active review version's source commit, all fetched from the install's own
// repository with a read-only token bound to that repository and revoked on
// return. The coding host then loads the review flow from an immutable export
// of the pinned commit (SMITHERS_FLOW_SOURCE_LOCAL), never from the PR's
// working copy. The machine receives no GitHub, landing, branch-publishing or
// provider credential, and no binding it could publish source with.
type ReviewSource struct {
	q         *db.Queries
	runtime   workspaceapi.WorkspaceExecution
	retention reviewSourceRetention
	refs      WorkspaceRefDeleter
}

func NewReviewSource(q *db.Queries, runtime workspaceapi.WorkspaceExecution, retention *RepositorySourceRetentionService, refs WorkspaceRefDeleter) *ReviewSource {
	source := &ReviewSource{q: q, runtime: runtime, refs: refs}
	if retention != nil {
		source.retention = retention
	}
	return source
}

// Review refs live only inside the machine's clone; nothing publishes them.
const (
	reviewHeadRef = "refs/smithers/review/head"
	reviewBaseRef = "refs/smithers/review/base"
	reviewMainRef = "refs/smithers/review/main"
)

// Prepare verifies, without allocating, that every input Restore needs exists
// and that the admitted pin is one version flow-load measured and loaded, or
// the built-in version the install ships. Active may have moved since
// admission; the admitted version still runs.
func (s *ReviewSource) Prepare(ctx context.Context, a ReviewAdmission) error {
	if s == nil || s.q == nil || s.runtime == nil || s.retention == nil {
		return reviewUnavailable("review_source_unavailable")
	}
	if _, ok := s.runtime.(workspaceapi.WorkspaceSourceExporterInstaller); !ok {
		return reviewUnavailable("review_source_unavailable")
	}
	if !a.Pin.Valid() || a.Pin.Flow != "review" || !flowCommitPattern.MatchString(a.Head) || !flowCommitPattern.MatchString(a.Base) {
		return reviewUnavailable("review_binding_unavailable")
	}
	versions, err := s.q.ListFlowVersions(ctx, a.RepositoryID)
	if err != nil {
		return reviewUnavailable("review_source_unavailable")
	}
	for _, version := range versions {
		if version.Name != "review" || !version.Digest.Valid || version.Digest.String != a.Pin.ExecutionDigest {
			continue
		}
		if !version.Status.Valid || version.Status.String != "loaded" || !version.SourceCommit.Valid || version.SourceCommit.String != a.Pin.SourceCommit {
			return reviewUnavailable("review_digest_mismatch")
		}
		return nil
	}
	// The built-in version is the install's own. Restore checks its commit is
	// on main, and the review host serves it only where that commit declares
	// no review of its own: an override there refuses at launch, its digest
	// not the pin's.
	if digests, err := builtinFlowDigests(); err == nil && digests["review"] == a.Pin.ExecutionDigest {
		return nil
	}
	return reviewUnavailable("review_source_unavailable")
}

// Restore is idempotent for the workspace: a replay after a lost reply finds
// the exact refs already fetched and only repeats the checkout.
func (s *ReviewSource) Restore(ctx context.Context, workspaceID string, a ReviewAdmission) error {
	if err := s.Prepare(ctx, a); err != nil {
		return err
	}
	fetched, err := s.fetched(ctx, workspaceID, a)
	if err != nil {
		return err
	}
	if !fetched {
		if err := s.fetch(ctx, workspaceID, a); err != nil {
			return err
		}
	}
	for _, commit := range []string{a.Head, a.Base, a.Pin.SourceCommit} {
		if err := s.run(ctx, workspaceID, nil, "git", "cat-file", "-e", commit+"^{commit}"); err != nil {
			return err
		}
	}
	// The coding host exports the pinned commit with the native Jujutsu
	// exporter, and the machine's source revision is the working-copy commit:
	// edit the head itself, so the recorded revision is exactly the PR head.
	// Once Jujutsu owns the working copy, a replay only edits the head again.
	entries, err := s.files(ctx, workspaceID)
	if err != nil {
		return err
	}
	if !entries[".jj"] {
		if err := s.run(ctx, workspaceID, nil, "git", "checkout", "--quiet", "--detach", a.Head); err != nil {
			return err
		}
		if err := s.run(ctx, workspaceID, nil, "jj", "git", "init", "--colocate"); err != nil {
			return err
		}
	}
	if err := s.run(ctx, workspaceID, nil, "jj", "edit", a.Head); err != nil {
		return err
	}
	if err := plantSourceExporter(ctx, s.runtime, workspaceID, reviewUnavailable("review_source_unavailable")); err != nil {
		return err
	}
	// Restore is this machine's whole setup. Its last step is the receipt a
	// Flow host start waits for, as branch setup's is.
	return writeSetupReceipt(ctx, s.runtime, workspaceID, a.RepositoryID, a.Head, reviewUnavailable("review_source_unavailable"))
}

// Retire drops the machine's retained source refs from the install repository.
func (s *ReviewSource) Retire(ctx context.Context, workspaceID string, a ReviewAdmission) error {
	if s == nil || s.q == nil || s.refs == nil {
		return nil
	}
	slug, err := s.q.GetRepoOwnerSlugAndNameByID(ctx, a.RepositoryID)
	if err != nil {
		return err
	}
	_, err = s.refs.DeleteWorkspaceRefs(ctx, slug.OwnerSlug, slug.RepoName, workspaceID)
	return err
}

func (s *ReviewSource) fetched(ctx context.Context, workspaceID string, a ReviewAdmission) (bool, error) {
	entries, err := s.files(ctx, workspaceID)
	if err != nil || !entries[".git"] {
		return false, err
	}
	for ref, commit := range map[string]string{reviewHeadRef: a.Head, reviewBaseRef: a.Base} {
		result, err := s.runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"git", "rev-parse", "--verify", "--quiet", ref + "^{commit}"}})
		if err != nil {
			return false, err
		}
		if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) != commit {
			return false, nil
		}
	}
	return true, nil
}

func (s *ReviewSource) fetch(ctx context.Context, workspaceID string, a ReviewAdmission) error {
	retained, err := s.retention.Retain(ctx, a.RepositoryID, a.RequesterID, RepositorySourceRetentionInput{WorkspaceID: workspaceID, Kind: "pull_request", Number: a.Number, Head: a.Head, Base: a.Base})
	if err != nil {
		return err
	}
	if retained.WorkspaceID != workspaceID || retained.Head != a.Head || retained.Base != a.Base ||
		retained.HeadRef != repohost.WorkspaceSourceRef(workspaceID, a.Head) || (a.Base != a.Head && retained.BaseRef != repohost.WorkspaceSourceRef(workspaceID, a.Base)) {
		return reviewUnavailable("review_source_unavailable")
	}
	repository, err := s.q.GetRepoByID(ctx, a.RepositoryID)
	if err != nil {
		return reviewUnavailable("review_source_unavailable")
	}
	// The main branch holds every loaded flow version's source commit.
	main := targetWorkspaceBookmark(repository.DefaultBookmark)
	token, err := issueTemporaryBoundRepoCloneToken(ctx, s.q, a.RequesterID, a.RepositoryID, "review-source")
	if err != nil {
		return reviewUnavailable("review_source_unavailable")
	}
	defer revokeTemporaryRepoCloneToken(ctx, s.q, a.RequesterID, token.ID)
	if err := s.run(ctx, workspaceID, nil, "git", "init", "--quiet"); err != nil {
		return err
	}
	baseRef := retained.BaseRef
	if baseRef == "" {
		baseRef = retained.HeadRef
	}
	// The URL is fetched directly: no remote, so no remote-tracking bookmark
	// can make the head immutable to Jujutsu or name a push destination.
	auth := map[string]string{"GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraHeader", "GIT_CONFIG_VALUE_0": "Authorization: Bearer " + token.Plaintext}
	return s.run(ctx, workspaceID, auth, "git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", retained.CloneURL,
		"+"+retained.HeadRef+":"+reviewHeadRef, "+"+baseRef+":"+reviewBaseRef, "+refs/heads/"+main+":"+reviewMainRef)
}

func (s *ReviewSource) files(ctx context.Context, workspaceID string) (map[string]bool, error) {
	return machineDirectories(ctx, s.runtime, workspaceID, reviewUnavailable("review_source_unavailable"))
}

func (s *ReviewSource) run(ctx context.Context, workspaceID string, environment map[string]string, args ...string) error {
	return machineCommand(ctx, s.runtime, workspaceID, environment, reviewUnavailable("review_source_unavailable"), args...)
}

// machineDirectories names the real directories at a machine's root. A linked
// or plain-file metadata entry is never a repository.
func machineDirectories(ctx context.Context, runtime workspaceapi.WorkspaceExecution, workspaceID string, refusal error) (map[string]bool, error) {
	files, ok := runtime.(interface {
		ListFiles(context.Context, string, string) ([]workspaceapi.FileEntry, error)
	})
	if !ok {
		return nil, refusal
	}
	entries, err := files.ListFiles(ctx, workspaceID, "")
	if err != nil {
		return nil, err
	}
	present := map[string]bool{}
	for _, entry := range entries {
		present[entry.Name] = entry.IsDir && entry.Mode&fs.ModeSymlink == 0
	}
	return present, nil
}

// machineCommand executes one argv as the machine's unprivileged user. A
// completed nonzero or truncated command is refusal; a transport error stays
// retryable.
func machineCommand(ctx context.Context, runtime workspaceapi.WorkspaceExecution, workspaceID string, environment map[string]string, refusal error, args ...string) error {
	result, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: args, Environment: environment})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 || result.OutputTruncated {
		return refusal
	}
	return nil
}
