package repohostserver

import (
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

// FFIClient defines the interface for jj repository operations. The production
// implementation is repohostffi.Client (CGO + dlopen), but tests can substitute
// a lightweight mock that avoids the Rust FFI dependency.
type FFIClient interface {
	InitRepo(storePath string) (repohostffi.InitRepoResult, error)
	AutoInitRepo(storePath, bookmarkName, repoName string) (repohostffi.InitRepoResult, error)
	DeleteRepo(storePath string) error
	ImportGitRefs(storePath string) error
	ExportGitRefs(storePath string) error
	InitWikiRepo(storePath string) (bool, error)
	ProjectWikiRevision(path, request string) (string, error)
	WikiDocument(requestJSON string) (repohost.WikiDocumentResult, error)
	InitDocsRepo(storePath string) (bool, error)
	CommitWikiPage(storePath, pageName, content, authorName, authorEmail, message string) (string, error)
	CommitDoc(storePath, filePath, content, authorName, authorEmail, message string) (string, error)
	GetWikiPageContent(storePath, pageName, commitSHA string) (string, string, error)
	GetDocContent(storePath, filePath, commitSHA string) (string, string, error)
	ListWikiPageHistory(storePath, pageName string, limit uint32) ([]repohost.WikiRevision, error)
	ListDocHistory(storePath, filePath string, limit uint32) ([]repohost.WikiRevision, error)
	DeleteWikiPage(storePath, pageName, authorName, authorEmail string) error
	DeleteDoc(storePath, filePath, authorName, authorEmail string) error
	ListBookmarks(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Bookmark], error)
	CreateBookmark(storePath, name, changeID string) (repohost.Bookmark, error)
	CreateBookmarkIfAbsent(storePath, name, changeID string) (repohost.Bookmark, error)
	DeleteBookmark(storePath, name string) error
	ListChanges(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Change], error)
	GetChange(storePath, changeID string) (repohost.Change, error)
	BackoutChange(storePath, changeID, revision, targetBookmark, base string) (repohost.Change, error)
	SplitChange(storePath, changeID string, paths []string, description string) (repohost.SplitChangeResult, error)
	GetDiff(storePath, changeID string) (repohost.ChangeDiff, error)
	GetRevisionDiff(storePath, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error)
	GetFiles(storePath, changeID string) ([]repohost.ChangeFile, error)
	ListTreeFiles(storePath, changeID, prefix string) ([]repohost.ChangeFile, error)
	ListDirectory(storePath, changeID, prefix, after string, limit uint32) ([]repohost.TreeEntry, error)
	GetConflicts(storePath, changeID string) ([]repohost.Conflict, error)
	LandChanges(storePath, requestJSON string) (repohost.LandResult, error)
	LandChange(storePath, changeID, targetBookmark string) (repohost.LandResult, error)
	GetFileContent(storePath, changeID, path string) (repohost.FileContent, error)
	CreateSnapshot(storePath, changeID string) (repohost.SnapshotResult, error)
	ListOperations(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Operation], error)
	GetWorkingTreeStatus(storePath string) (repohost.WorkingTreeStatus, error)
	ComposeSuperproject(storePath, requestJSON string) (repohost.SuperprojectCommit, error)
	ReadSuperproject(storePath, revision string) (repohost.SuperprojectCommit, error)
}

// Compile-time check that *repohostffi.Client satisfies FFIClient.
var _ FFIClient = (*repohostffi.Client)(nil)
