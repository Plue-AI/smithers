package services

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// SourceFile is one file an app-agent turn read from its repository's
// mirrored main. Binary content is stated, never returned.
type SourceFile struct {
	Repository string `json:"repository"`
	Path       string `json:"path"`
	Commit     string `json:"commit"`
	Content    string `json:"content"`
	Binary     bool   `json:"binary"`
}

var (
	// ErrSourceNotReady: setup has not mirrored main yet (spec §16.2 step 7).
	ErrSourceNotReady = errors.New("repository source is not ready")
	// ErrSourcePathRefused: the path is not one entry inside the repository.
	ErrSourcePathRefused = errors.New("source path is not inside the repository")
	// ErrSourceForbidden: the asking member cannot read this repository.
	ErrSourceForbidden = errors.New("source is not readable by this member")
	// ErrSourceNotFound: main has no regular file at the path.
	ErrSourceNotFound = errors.New("source path is not a file on main")
	// ErrSourceTooLarge: the file is over the repository host's blob cap.
	ErrSourceTooLarge = errors.New("source file exceeds the read limit")
)

// maxSourcePathBytes is the public contents route's path cap.
const maxSourcePathBytes = 4096

// InstallSource serves an app-agent turn's reads from the install's mirrored
// main (spec §16.2 step 7, §15.1.3). Source ready means the mirror holds main,
// so a question reads files before any machine exists. Each read is
// authorized as the turn's author at the time of the read, resolves main's
// commit on the repository host and reads one blob there. It starts no
// machine and runs no repository code.
type InstallSource struct {
	Pool  *pgxpool.Pool
	Repos *RepoService
}

// Source names the mirror the member may read, as owner/name.
func (s InstallSource) Source(ctx context.Context, userID, repositoryID int64) (string, error) {
	owner, repository, err := s.readable(ctx, userID, repositoryID)
	if err != nil {
		return "", err
	}
	return owner + "/" + repository.Name, nil
}

// ReadSource reads one file at main's current commit for the member. The
// repository host's blob cap bounds it; a symlink is not followed.
func (s InstallSource) ReadSource(ctx context.Context, userID, repositoryID int64, filePath string) (SourceFile, error) {
	if !sourcePath(filePath) {
		return SourceFile{}, ErrSourcePathRefused
	}
	owner, repository, err := s.readable(ctx, userID, repositoryID)
	if err != nil {
		return SourceFile{}, err
	}
	commit, file, err := s.Repos.defaultBookmarkFile(ctx, owner, repository, filePath)
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeNotFound {
		return SourceFile{}, ErrSourceNotFound
	}
	if err != nil {
		return SourceFile{}, err
	}
	if file.TooLarge {
		return SourceFile{}, ErrSourceTooLarge
	}
	read := SourceFile{Repository: owner + "/" + repository.Name, Path: filePath, Commit: commit}
	// The repository host answers bytes that are not UTF-8 as base64.
	if file.Encoding == "base64" || strings.ContainsRune(file.Content, 0) {
		read.Binary = true
	} else {
		read.Content = file.Content
	}
	return read, nil
}

// readable resolves the install's mirror for one member: Source ready, the
// mirrored repository, the member's read permission now, and a turn scoped to
// no repository or to this one.
func (s InstallSource) readable(ctx context.Context, userID, repositoryID int64) (string, db.Repository, error) {
	q := db.New(s.Pool)
	step, err := (&InstallSetupService{}).readStep(ctx, q, "source")
	if err != nil {
		return "", db.Repository{}, err
	}
	if step.Status != InstallReady {
		return "", db.Repository{}, ErrSourceNotReady
	}
	owner, name, err := installRepositorySlug(ctx, q, "setup.source.repository")
	var readiness *InstallReadinessError
	if errors.As(err, &readiness) {
		return "", db.Repository{}, ErrSourceNotReady
	}
	if err != nil {
		return "", db.Repository{}, err
	}
	viewer, err := q.GetUserByIDNotDeleted(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", db.Repository{}, ErrSourceForbidden
	}
	if err != nil {
		return "", db.Repository{}, err
	}
	repository, err := s.Repos.resolveReadableRepo(ctx, &viewer, owner, name)
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeNotFound {
		return "", db.Repository{}, ErrSourceNotReady
	}
	if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeForbidden {
		return "", db.Repository{}, ErrSourceForbidden
	}
	if err != nil {
		return "", db.Repository{}, err
	}
	if repositoryID != 0 && repositoryID != repository.ID {
		return "", db.Repository{}, ErrSourceForbidden
	}
	return owner, repository, nil
}

// sourcePath accepts one repository-relative path that cannot leave the
// tree: no leading slash, no empty, "." or ".." segment, no backslash or NUL,
// valid UTF-8 and at most maxSourcePathBytes. Names keep their exact bytes,
// whitespace included.
func sourcePath(value string) bool {
	if value == "" || len(value) > maxSourcePathBytes || !utf8.ValidString(value) || strings.ContainsAny(value, "\\\x00") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}
