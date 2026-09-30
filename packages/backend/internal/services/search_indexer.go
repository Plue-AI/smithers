package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const (
	maxCodeSearchFileBytes = 256 * 1024
	codeSearchIndexWorkers = 8
)

// SearchIndexQuerier defines the database operations needed to maintain the
// code-search index after repository pushes and during backfill.
type SearchIndexQuerier interface {
	GetCodeSearchIndexedCommit(context.Context, int64) (string, error)
	SetCodeSearchIndexedCommit(context.Context, db.SetCodeSearchIndexedCommitParams) error
	DeleteCodeSearchDocumentsExceptPaths(context.Context, db.DeleteCodeSearchDocumentsExceptPathsParams) error
	ListCodeSearchUnindexedRepositories(context.Context, db.ListCodeSearchUnindexedRepositoriesParams) ([]db.ListCodeSearchUnindexedRepositoriesRow, error)

	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	UpsertCodeSearchDocument(ctx context.Context, arg db.UpsertCodeSearchDocumentParams) (db.UpsertCodeSearchDocumentRow, error)
	DeleteCodeSearchDocumentByPath(ctx context.Context, arg db.DeleteCodeSearchDocumentByPathParams) error
}

// SearchIndexRepoHostClient defines the repo-host reads used by push indexing.
type SearchIndexRepoHostClient interface {
	GetRevisionDiff(context.Context, string, string, string, string, string, string) (repohost.ChangeDiff, error)
	ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error)

	ListFilesAtChange(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error)
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

// SearchIndexPushInput identifies the repository snapshot produced by a push.
type SearchIndexPushInput struct {
	RepositoryID   int64
	Owner          string
	RepositoryName string
	Ref            string
	CommitSHA      string

	// backfill leaves a repository that has bookmarks but lacks its default
	// one unindexed, so it stays in the backlog instead of being recorded as
	// empty (for example a legacy-cased default awaiting ref repair).
	backfill bool
}

// SearchIndexer maintains code_search_documents from repository push events.
type SearchIndexer struct {
	pool     *pgxpool.Pool
	locks    [64]sync.Mutex
	queries  SearchIndexQuerier
	repoHost SearchIndexRepoHostClient
}

// NewSearchIndexer constructs a push-driven code search indexer.
func NewSearchIndexer(queries SearchIndexQuerier, repoHost SearchIndexRepoHostClient, pools ...*pgxpool.Pool) *SearchIndexer {
	s := &SearchIndexer{queries: queries, repoHost: repoHost}
	if len(pools) > 0 {
		s.pool = pools[0]
	}
	return s
}

type codeSearchIndexPath struct {
	path    string
	deleted bool
}

// IndexPush indexes a pushed commit only when it updates the repository's
// default bookmark. The durable watermark advances atomically with indexed
// documents; revision diffs cover the entire range of pushed commits.
func (s *SearchIndexer) IndexPush(ctx context.Context, input SearchIndexPushInput) error {
	if s == nil || s.queries == nil || s.repoHost == nil {
		return errors.New("code search indexer dependencies are not configured")
	}
	if input.RepositoryID <= 0 {
		return errors.New("repository id must be positive")
	}
	if strings.TrimSpace(input.CommitSHA) == "" {
		return nil
	}

	repository, err := s.queries.GetRepoByID(ctx, input.RepositoryID)
	if err != nil {
		return fmt.Errorf("load repository: %w", err)
	}
	if normalizeCodeSearchBookmark(input.Ref) != strings.TrimSpace(repository.DefaultBookmark) {
		return nil
	}
	return s.indexRepository(ctx, input)
}

// indexRepository indexes the repository's current default-bookmark head under
// the per-repository indexing lock.
func (s *SearchIndexer) indexRepository(ctx context.Context, input SearchIndexPushInput) error {
	if s.pool != nil {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('code_search:' || ($1::bigint)::text, 0))", input.RepositoryID); err != nil {
			return err
		}
		worker := &SearchIndexer{queries: &serializedSearchQueries{SearchIndexQuerier: db.New(tx)}, repoHost: s.repoHost}
		if err = worker.indexCurrentHead(ctx, input); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	lock := &s.locks[input.RepositoryID%int64(len(s.locks))]
	lock.Lock()
	defer lock.Unlock()
	return s.indexCurrentHead(ctx, input)
}

func (s *SearchIndexer) indexCurrentHead(ctx context.Context, input SearchIndexPushInput) error {
	// Re-read the default bookmark and its head under the indexing lock. An old
	// push callback or backfill page can only index the current head, never
	// overwrite it with an older snapshot or a former default bookmark.
	repository, err := s.queries.GetRepoByID(ctx, input.RepositoryID)
	if err != nil {
		return fmt.Errorf("load repository: %w", err)
	}
	bookmarkName := strings.TrimSpace(repository.DefaultBookmark)
	input.CommitSHA = ""
	cursor := ""
	hasBookmarks := false
	for {
		bookmarks, next, err := s.repoHost.ListBookmarks(ctx, input.Owner, input.RepositoryName, cursor, 100)
		if err != nil {
			return err
		}
		hasBookmarks = hasBookmarks || len(bookmarks) > 0
		for _, bookmark := range bookmarks {
			if bookmark.Name == bookmarkName {
				input.CommitSHA = bookmark.TargetCommitID
			}
		}
		if next == "" {
			break
		}
		if next == cursor {
			return errors.New("bookmark pagination did not advance")
		}
		cursor = next
	}
	if input.backfill && input.CommitSHA == "" && hasBookmarks {
		return fmt.Errorf("default bookmark %q not found", bookmarkName)
	}
	previous, err := s.queries.GetCodeSearchIndexedCommit(ctx, input.RepositoryID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if previous == input.CommitSHA && previous != "" {
		return nil
	}
	var paths []codeSearchIndexPath
	fullSnapshot := previous == "" || input.CommitSHA == ""
	if !fullSnapshot {
		diff, diffErr := s.repoHost.GetRevisionDiff(ctx, input.Owner, input.RepositoryName, input.CommitSHA, previous, input.CommitSHA, "")
		var status *repohost.StatusError
		if errors.As(diffErr, &status) && status.StatusCode == 404 {
			fullSnapshot = true // A pruned old watermark needs a fresh tree walk.
		} else if diffErr != nil {
			return diffErr
		} else {
			for _, file := range diff.FileDiffs {
				if file.ChangeType == "renamed" && file.OldPath != "" && file.OldPath != file.Path {
					if err := s.queries.DeleteCodeSearchDocumentByPath(ctx, db.DeleteCodeSearchDocumentByPathParams{RepositoryID: input.RepositoryID, FilePath: file.OldPath}); err != nil {
						return err
					}
				}
				paths = append(paths, codeSearchIndexPath{path: file.Path, deleted: file.ChangeType == "deleted"})
			}
		}
	}
	if fullSnapshot {
		var files []repohost.ChangeFile
		if input.CommitSHA != "" {
			files, err = s.repoHost.ListFilesAtChange(ctx, input.Owner, input.RepositoryName, input.CommitSHA, "")
			if err != nil {
				return err
			}
		}
		names := make([]string, 0, len(files))
		for _, file := range files {
			names = append(names, file.Path)
			paths = append(paths, codeSearchIndexPath{path: file.Path})
		}
		if err = s.queries.DeleteCodeSearchDocumentsExceptPaths(ctx, db.DeleteCodeSearchDocumentsExceptPathsParams{RepositoryID: input.RepositoryID, Paths: names}); err != nil {
			return err
		}
	}
	if err = s.indexPaths(ctx, input, paths); err != nil {
		return err
	}
	return s.queries.SetCodeSearchIndexedCommit(ctx, db.SetCodeSearchIndexedCommitParams{RepositoryID: input.RepositoryID, CommitID: input.CommitSHA})
}

// pgx transactions own one connection. File reads stay concurrent; writes on
// that connection are serialized and committed together with the watermark.
type serializedSearchQueries struct {
	SearchIndexQuerier
	mu sync.Mutex
}

func (q *serializedSearchQueries) UpsertCodeSearchDocument(ctx context.Context, arg db.UpsertCodeSearchDocumentParams) (db.UpsertCodeSearchDocumentRow, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.SearchIndexQuerier.UpsertCodeSearchDocument(ctx, arg)
}
func (q *serializedSearchQueries) DeleteCodeSearchDocumentByPath(ctx context.Context, arg db.DeleteCodeSearchDocumentByPathParams) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.SearchIndexQuerier.DeleteCodeSearchDocumentByPath(ctx, arg)
}

func (s *SearchIndexer) indexPaths(ctx context.Context, input SearchIndexPushInput, paths []codeSearchIndexPath) error {
	if len(paths) == 0 {
		return nil
	}

	workerCount := min(codeSearchIndexWorkers, len(paths))
	jobs := make(chan codeSearchIndexPath)
	var workers sync.WaitGroup
	var failures sync.Mutex
	var firstErr error
	failureCount := 0

	recordFailure := func(err error) {
		failures.Lock()
		defer failures.Unlock()
		failureCount++
		if firstErr == nil {
			firstErr = err
		}
	}

	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for item := range jobs {
				if err := s.indexPath(ctx, input, item); err != nil {
					recordFailure(fmt.Errorf("%s: %w", item.path, err))
				}
			}
		}()
	}

sendPaths:
	for _, item := range paths {
		select {
		case jobs <- item:
		case <-ctx.Done():
			recordFailure(ctx.Err())
			break sendPaths
		}
	}
	close(jobs)
	workers.Wait()

	if failureCount > 0 {
		return fmt.Errorf("%d code search file operations failed (first: %w)", failureCount, firstErr)
	}
	return nil
}

func (s *SearchIndexer) indexPath(ctx context.Context, input SearchIndexPushInput, item codeSearchIndexPath) error {
	deleteDocument := func() error {
		return s.queries.DeleteCodeSearchDocumentByPath(ctx, db.DeleteCodeSearchDocumentByPathParams{
			RepositoryID: input.RepositoryID,
			FilePath:     item.path,
		})
	}

	if item.deleted {
		if err := deleteDocument(); err != nil {
			return fmt.Errorf("delete document: %w", err)
		}
		return nil
	}

	file, err := s.repoHost.GetFileAtChange(ctx, input.Owner, input.RepositoryName, input.CommitSHA, item.path)
	if err != nil {
		return fmt.Errorf("read file: %w", err)
	}
	if !isIndexableCodeSearchFile(file) {
		// A formerly-text file may have become binary or oversized. Remove any
		// stale document so searches never return its previous contents.
		if err := deleteDocument(); err != nil {
			return fmt.Errorf("delete non-indexable document: %w", err)
		}
		return nil
	}

	_, err = s.queries.UpsertCodeSearchDocument(ctx, db.UpsertCodeSearchDocumentParams{
		RepositoryID: input.RepositoryID,
		FilePath:     item.path,
		Content:      file.Content,
	})
	if err != nil {
		return fmt.Errorf("upsert document: %w", err)
	}
	return nil
}

func isIndexableCodeSearchFile(file repohost.FileContent) bool {
	if file.TooLarge || len(file.Content) > maxCodeSearchFileBytes {
		return false
	}
	if file.Encoding != "" && file.Encoding != "utf8" {
		return false
	}
	return !bytes.ContainsRune([]byte(file.Content), '\x00')
}

func normalizeCodeSearchBookmark(ref string) string {
	ref = strings.TrimSpace(ref)
	return strings.TrimPrefix(ref, "refs/heads/")
}
