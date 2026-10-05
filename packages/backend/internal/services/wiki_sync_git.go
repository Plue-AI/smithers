package services

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// WikiSyncSourceReporter is implemented by adapters whose documents can come
// from versioned storage. SourceCommit returns the commit whose tree holds
// exactly data at the document's path, or "" when no such commit is known.
type WikiSyncSourceReporter interface {
	SourceCommit(context.Context, SyncDocument, []byte) (string, error)
}

var wikiGitObjectID = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)

// SourceCommit reports HEAD when the folder is inside a git work tree and the
// imported bytes equal the blob HEAD records at that path, with replacement
// objects ignored so the recorded commit is the one that holds those bytes. Uncommitted edits,
// untracked files, filtered content (LFS, eol conversion) and folders outside
// a work tree have no provenance. The commit is resolved once and the blob is
// compared against the bytes actually imported, so a concurrent commit can
// never attribute other bytes to it.
func (a *ObsidianSync) SourceCommit(ctx context.Context, d SyncDocument, data []byte) (string, error) {
	if err := validSyncPath(d.Path); err != nil {
		return "", err
	}
	prefix, err := a.git(ctx, nil, "rev-parse", "--show-prefix")
	if err != nil {
		var exit *exec.ExitError
		if errors.Is(err, exec.ErrNotFound) || errors.As(err, &exit) && bytes.Contains(exit.Stderr, []byte("not a git repository")) {
			return "", nil // no git on this host, or not a git work tree
		}
		return "", err
	}
	// --verify --quiet exits 1 only when the name does not resolve; any
	// other failure fails the import instead of dropping its provenance.
	commit, err := a.git(ctx, nil, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if missing, e := wikiGitMissing(err); missing || e != nil {
		return "", e // unborn HEAD, or failure
	}
	recorded, err := a.git(ctx, nil, "rev-parse", "--verify", "--quiet", commit+":"+prefix+d.Path)
	if missing, e := wikiGitMissing(err); missing || e != nil {
		return "", e // not tracked at HEAD, or failure
	}
	imported, err := a.git(ctx, bytes.NewReader(data), "hash-object", "--no-filters", "--stdin")
	if err != nil {
		return "", err
	}
	if imported != recorded {
		return "", nil
	}
	return commit, nil
}

// wikiGitMissing reports whether a --verify --quiet lookup found no object.
func wikiGitMissing(err error) (bool, error) {
	if err == nil {
		return false, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return true, nil
	}
	return false, err
}

// git runs read-only plumbing in the folder. Inherited repository overrides
// are dropped so discovery always starts at the configured folder.
func (a *ObsidianSync) git(ctx context.Context, stdin io.Reader, args ...string) (string, error) {
	cmd := hostexec.Git(ctx, append([]string{"--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false"}, args...)...)
	cmd.Dir = a.folder
	// Cancellation also stops waiting on a descendant that holds the pipes.
	cmd.WaitDelay = time.Second
	cmd.Env = append(cmd.Env, "LC_ALL=C")
	cmd.Stdin = stdin
	out, err := cmd.Output()
	if err != nil && ctx.Err() != nil {
		err = ctx.Err() // a cancelled run reports why, not how it was stopped
	}
	return strings.TrimSuffix(string(out), "\n"), err
}

type wikiSourceStore interface {
	RecordWikiRevisionSource(context.Context, db.RecordWikiRevisionSourceParams) (int64, error)
}

// recordWikiSyncSource attaches provenance to the revision this import just
// wrote, as a receipt like history_commit_id: page history returns it, while
// the sequenced event stream stays exactly what was authored. It runs after
// the write, so a crash in between leaves the revision without provenance
// (unknown), never with a wrong one; the author and empty guards keep it from
// annotating another writer's or an already annotated revision.
func (s *WikiService) recordWikiSyncSource(ctx context.Context, actor *db.User, owner, repo string, event WikiEvent, commit string) error {
	if !wikiGitObjectID.MatchString(commit) {
		return api.BadRequest("invalid source commit")
	}
	store, ok := s.queries.(wikiSourceStore)
	if !ok {
		return wikiUnavailable("wiki provenance is unavailable")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	_, err = store.RecordWikiRevisionSource(ctx, db.RecordWikiRevisionSourceParams{SourceCommit: commit, RepositoryID: repository.ID, Visibility: wikiVisibility(ctx), PageID: event.PageID, Revision: event.Revision, AuthorID: pgtype.Int8{Int64: actor.ID, Valid: true}})
	return err
}
