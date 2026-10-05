package services

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
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
	// ErrSourceForbidden: the turn's credential no longer reads this
	// repository as its member.
	ErrSourceForbidden = errors.New("source is not readable by this member")
	// ErrSourceNotFound: main has no regular file at the path.
	ErrSourceNotFound = errors.New("source path is not a file on main")
	// ErrSourceTooLarge: the file is over the repository host's blob cap.
	ErrSourceTooLarge = errors.New("source file exceeds the read limit")
)

// InstallSource serves an app-agent turn's reads from the install's mirrored
// main (spec §16.2 step 7, §15.1.3). Source ready means the mirror holds main,
// so a question reads files before any machine exists. It starts no machine
// and runs no repository code.
//
// A read has the authority of the credential that admitted the turn, resolved
// again at the read: it must still authenticate the turn's author, read
// repositories as a person (a browser session, or a token holding
// read:repository bound to nothing narrower), pass the installation's member
// boundary, and its member must hold read permission on the mirror now.
type InstallSource struct {
	Pool  *pgxpool.Pool
	Repos *RepoService
	// Members is the installation's member boundary, the one AuthLoader
	// applies to every credential; without one nothing is read.
	Members identity.MemberAuthorizer
}

// Source names the mirror the turn's credential may read, as owner/name.
func (s InstallSource) Source(ctx context.Context, credential middleware.Credential, userID, repositoryID int64) (string, error) {
	owner, repository, err := s.readable(ctx, credential, userID, repositoryID)
	if err != nil {
		return "", err
	}
	return owner + "/" + repository.Name, nil
}

// ReadSource reads one file at main's current commit for the turn's
// credential. The repository host's blob cap bounds it; a symlink, a
// directory and a submodule are not files.
func (s InstallSource) ReadSource(ctx context.Context, credential middleware.Credential, userID, repositoryID int64, filePath string) (SourceFile, error) {
	if ValidateRepositoryPath(filePath) != nil {
		return SourceFile{}, ErrSourcePathRefused
	}
	owner, repository, err := s.readable(ctx, credential, userID, repositoryID)
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

// readable resolves the install's mirror for one turn: Source ready, the
// mirrored repository, the turn's credential and member now, the member's
// read permission now, and a turn scoped to no repository or to this one.
func (s InstallSource) readable(ctx context.Context, credential middleware.Credential, userID, repositoryID int64) (string, db.Repository, error) {
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
	member, err := s.member(ctx, q, credential, userID)
	if err != nil {
		return "", db.Repository{}, err
	}
	repository, err := s.Repos.resolveReadableRepo(ctx, member, owner, name)
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

// member is the turn's author as the turn's credential authenticates them
// now. A credential that is gone, names another account, does not read
// repositories as a person, or fails the member boundary reads nothing.
func (s InstallSource) member(ctx context.Context, q *db.Queries, credential middleware.Credential, userID int64) (*db.User, error) {
	if s.Members == nil {
		return nil, ErrSourceForbidden
	}
	info, err := middleware.ReloadCredential(ctx, q, credential, time.Now().UTC())
	if errors.Is(err, middleware.ErrCredentialGone) {
		return nil, ErrSourceForbidden
	}
	if err != nil {
		return nil, err
	}
	user := info.User
	if user.ID != userID || !user.IsActive || user.ProhibitLogin || user.DeletedAt.Valid || !info.ReadsRepositoriesAsPerson() {
		return nil, ErrSourceForbidden
	}
	if apiErr := s.Members.AuthorizeMember(ctx, userID); apiErr != nil {
		if apiErr.Status >= 500 {
			return nil, apiErr
		}
		return nil, ErrSourceForbidden
	}
	return user, nil
}
