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

// SourceDirectory is one directory an app-agent turn listed on its
// repository's mirrored main: its immediate entries, in the repository
// host's order. Truncated says it holds more than one listing shows.
type SourceDirectory struct {
	Repository string        `json:"repository"`
	Path       string        `json:"path"`
	Commit     string        `json:"commit"`
	Entries    []SourceEntry `json:"entries"`
	Truncated  bool          `json:"truncated"`
}

// SourceEntry is one entry of a listed directory. Only a tree is a
// directory: a symlink and a submodule are listed as files, never descended.
type SourceEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// sourceListLimit bounds one listing: the repository host's largest
// directory page.
const sourceListLimit = 1000

var (
	// ErrSourceNotReady: setup has not mirrored main yet (spec §16.2 step 7).
	ErrSourceNotReady = errors.New("repository source is not ready")
	// ErrSourcePathRefused: the path is not one entry inside the repository.
	ErrSourcePathRefused = errors.New("source path is not inside the repository")
	// ErrSourceForbidden: the turn's credential no longer reads this
	// repository as its member.
	ErrSourceForbidden = errors.New("source is not readable by this member")
	// ErrSourceNotFound: main has no regular file at the path a read names,
	// or no directory at the path a listing names.
	ErrSourceNotFound = errors.New("source path is not on main")
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
	owner, repository, _, err := s.readable(ctx, credential, userID, repositoryID)
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
	owner, repository, _, err := s.readable(ctx, credential, userID, repositoryID)
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

// ListSource lists one directory at main's current commit for the turn's
// credential; the empty path is the repository's root. A path that names no
// directory on main, a file among them, is not found: git keeps no empty
// directory, so an empty answer below the root means none is there.
func (s InstallSource) ListSource(ctx context.Context, credential middleware.Credential, userID, repositoryID int64, dirPath string) (SourceDirectory, error) {
	if dirPath != "" && ValidateRepositoryPath(dirPath) != nil {
		return SourceDirectory{}, ErrSourcePathRefused
	}
	owner, repository, member, err := s.readable(ctx, credential, userID, repositoryID)
	if err != nil {
		return SourceDirectory{}, err
	}
	contents, next, commit, err := s.Repos.ListRepoContentsPage(ctx, member, owner, repository.Name, "", dirPath, "", sourceListLimit)
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeNotFound {
		return SourceDirectory{}, ErrSourceNotFound
	}
	if err != nil {
		return SourceDirectory{}, err
	}
	if len(contents) == 0 && dirPath != "" {
		return SourceDirectory{}, ErrSourceNotFound
	}
	entries := make([]SourceEntry, 0, len(contents))
	for _, content := range contents {
		kind := "file"
		if content.Type == "dir" {
			kind = "dir"
		}
		entries = append(entries, SourceEntry{Name: content.Name, Kind: kind})
	}
	return SourceDirectory{Repository: owner + "/" + repository.Name, Path: dirPath, Commit: commit, Entries: entries, Truncated: next != ""}, nil
}

// readable resolves the install's mirror for one turn: Source ready, the
// mirrored repository, the turn's credential and member now, the member's
// read permission now, and a turn scoped to no repository or to this one.
func (s InstallSource) readable(ctx context.Context, credential middleware.Credential, userID, repositoryID int64) (string, db.Repository, *db.User, error) {
	q := db.New(s.Pool)
	step, err := (&InstallSetupService{}).readStep(ctx, q, "source")
	if err != nil {
		return "", db.Repository{}, nil, err
	}
	if step.Status != InstallReady {
		return "", db.Repository{}, nil, ErrSourceNotReady
	}
	owner, name, err := installRepositorySlug(ctx, q, "setup.source.repository")
	var readiness *InstallReadinessError
	if errors.As(err, &readiness) {
		return "", db.Repository{}, nil, ErrSourceNotReady
	}
	if err != nil {
		return "", db.Repository{}, nil, err
	}
	member, err := s.member(ctx, q, credential, userID)
	if err != nil {
		return "", db.Repository{}, nil, err
	}
	repository, err := s.Repos.resolveReadableRepo(ctx, member, owner, name)
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeNotFound {
		return "", db.Repository{}, nil, ErrSourceNotReady
	}
	if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeForbidden {
		return "", db.Repository{}, nil, ErrSourceForbidden
	}
	if err != nil {
		return "", db.Repository{}, nil, err
	}
	if repositoryID != 0 && repositoryID != repository.ID {
		return "", db.Repository{}, nil, ErrSourceForbidden
	}
	return owner, repository, member, nil
}

// member is the turn's author as the turn's credential authenticates them
// now. A credential that is gone, names another account, does not read
// repositories as a person, or fails the member boundary reads nothing.
func (s InstallSource) member(ctx context.Context, q *db.Queries, credential middleware.Credential, userID int64) (*db.User, error) {
	info, err := turnAuthor(ctx, q, s.Members, credential, userID, (*middleware.AuthInfo).ReadsRepositoriesAsPerson)
	if errors.Is(err, errNotTheAuthor) {
		return nil, ErrSourceForbidden
	}
	if err != nil {
		return nil, err
	}
	return info.User, nil
}

// errNotTheAuthor means a turn's admitting credential no longer acts for its
// author; each caller states it in its own words.
var errNotTheAuthor = errors.New("the turn's credential no longer acts for its author")

// turnAuthor is a turn's author as the credential that admitted the turn
// authenticates them now. A credential that is gone, names another account,
// belongs to an account that may not sign in, is not of the kind may admits,
// or is neither the owner nor an active roster member answers
// errNotTheAuthor; any other error means the store or the boundary could not
// answer.
func turnAuthor(ctx context.Context, q *db.Queries, members identity.MemberAuthorizer, credential middleware.Credential, userID int64, may func(*middleware.AuthInfo) bool) (*middleware.AuthInfo, error) {
	if members == nil {
		return nil, errNotTheAuthor
	}
	info, err := middleware.ReloadCredential(ctx, q, credential, time.Now().UTC())
	if errors.Is(err, middleware.ErrCredentialGone) {
		return nil, errNotTheAuthor
	}
	if err != nil {
		return nil, err
	}
	user := info.User
	if user.ID != userID || !user.IsActive || user.ProhibitLogin || user.DeletedAt.Valid || !may(info) {
		return nil, errNotTheAuthor
	}
	// A turn is the agent.turn command: an active roster member asks as
	// themselves, and each read the turn makes is that member's request.
	if apiErr := members.AuthorizeMember(identity.WithMemberRoute(ctx), userID); apiErr != nil {
		if apiErr.Status >= 500 {
			return nil, apiErr
		}
		return nil, errNotTheAuthor
	}
	return info, nil
}
