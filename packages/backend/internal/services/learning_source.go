package services

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// LearningSource is the pinned-source boundary of a learning machine
// (T-FLW-06). A learning pin's source commit is the merge on the install
// repository's main. Restore fetches main into the machine with a read-only
// token bound to that repository and revoked on return, then makes the merge
// the working copy, detached. The coding host loads the learning flow from an
// immutable export of that commit. The machine receives no GitHub, landing,
// branch-publishing or provider credential, and no remote it could push to.
type LearningSource struct {
	q       *db.Queries
	runtime workspaceapi.WorkspaceExecution
	clone   func(owner, repository string) (string, error)
}

// NewLearningSource fetches from the install's own git endpoint at gitBaseURL.
func NewLearningSource(q *db.Queries, runtime workspaceapi.WorkspaceExecution, gitBaseURL string) *LearningSource {
	return &LearningSource{q: q, runtime: runtime, clone: func(owner, repository string) (string, error) {
		parsed, err := buildRepoCloneURL(gitBaseURL, owner, repository)
		if err != nil {
			return "", err
		}
		return parsed.String(), nil
	}}
}

// learningMainRef holds main inside the machine's clone only; nothing
// publishes it.
const learningMainRef = "refs/smithers/learning/main"

func learningUnavailable(code string) error {
	return &TodoControlError{Status: http.StatusServiceUnavailable, Class: "infra", Code: code, Message: "Learning unavailable"}
}

// Prepare verifies, without allocating, that Restore has every input it needs.
func (s *LearningSource) Prepare(_ context.Context, _ int64, pin flowruntime.Pin) error {
	if s == nil || s.q == nil || s.runtime == nil || s.clone == nil {
		return learningUnavailable("learning_source_unavailable")
	}
	if _, ok := s.runtime.(workspaceapi.WorkspaceSourceExporterInstaller); !ok {
		return learningUnavailable("learning_source_unavailable")
	}
	if !pin.Valid() || pin.Flow != "learning" {
		return learningUnavailable("learning_binding_unavailable")
	}
	return nil
}

// Restore is idempotent for the workspace: a replay after a lost reply finds
// the merge already fetched and only edits it again. A main that has not yet
// followed the merge refuses, and the admission asks again later.
func (s *LearningSource) Restore(ctx context.Context, workspaceID string, repository, actor int64, pin flowruntime.Pin) error {
	if err := s.Prepare(ctx, repository, pin); err != nil {
		return err
	}
	refusal := learningUnavailable("learning_source_unavailable")
	run := func(environment map[string]string, args ...string) error {
		return machineCommand(ctx, s.runtime, workspaceID, environment, refusal, args...)
	}
	entries, err := machineDirectories(ctx, s.runtime, workspaceID, refusal)
	if err != nil {
		return err
	}
	merge := pin.SourceCommit + "^{commit}"
	if !entries[".git"] || run(nil, "git", "cat-file", "-e", merge) != nil {
		if err := s.fetch(ctx, workspaceID, repository, actor); err != nil {
			return err
		}
		if err := run(nil, "git", "cat-file", "-e", merge); err != nil {
			return err
		}
	}
	// The machine's source revision is its working-copy commit, so the
	// recorded revision is exactly the pinned merge.
	if !entries[".jj"] {
		if err := run(nil, "git", "checkout", "--quiet", "--detach", pin.SourceCommit); err != nil {
			return err
		}
		if err := run(nil, "jj", "git", "init", "--colocate"); err != nil {
			return err
		}
	}
	if err := run(nil, "jj", "edit", pin.SourceCommit); err != nil {
		return err
	}
	if err := plantSourceExporter(ctx, s.runtime, workspaceID, refusal); err != nil {
		return err
	}
	// Restore is this machine's whole setup. Its last step is the receipt a
	// Flow host start waits for, as branch setup's is.
	return writeSetupReceipt(ctx, s.runtime, workspaceID, repository, pin.SourceCommit, refusal)
}

func (s *LearningSource) fetch(ctx context.Context, workspaceID string, repository, actor int64) error {
	refusal := learningUnavailable("learning_source_unavailable")
	repo, err := s.q.GetRepoByID(ctx, repository)
	if err != nil {
		return refusal
	}
	slug, err := s.q.GetRepoOwnerSlugAndNameByID(ctx, repository)
	if err != nil {
		return refusal
	}
	cloneURL, err := s.clone(slug.OwnerSlug, slug.RepoName)
	if err != nil {
		return refusal
	}
	token, err := issueTemporaryBoundRepoCloneToken(ctx, s.q, actor, repository, "learning-source")
	if err != nil {
		return refusal
	}
	defer revokeTemporaryRepoCloneToken(ctx, s.q, actor, token.ID)
	if err := machineCommand(ctx, s.runtime, workspaceID, nil, refusal, "git", "init", "--quiet"); err != nil {
		return err
	}
	// The URL is fetched directly: no remote, so no remote-tracking bookmark
	// can name a push destination.
	auth := map[string]string{"GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraHeader", "GIT_CONFIG_VALUE_0": "Authorization: Bearer " + token.Plaintext}
	main := targetWorkspaceBookmark(repo.DefaultBookmark)
	return machineCommand(ctx, s.runtime, workspaceID, auth, refusal, "git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", cloneURL, "+refs/heads/"+main+":"+learningMainRef)
}
