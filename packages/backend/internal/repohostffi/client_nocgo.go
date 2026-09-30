//go:build !cgo

package repohostffi

import (
	"errors"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type Client struct {
	libPath string
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"error"`
}

type InitRepoResult struct {
	Status string `json:"status"`
	Path   string `json:"path"`
}

type StatusResult struct {
	Status string `json:"status"`
}

type InitWikiRepoResult struct {
	Created bool `json:"created"`
}

type Paginated[T any] struct {
	Items      []T `json:"items"`
	TotalCount int `json:"total_count"`
}

func New(libPath string) *Client { return &Client{libPath: libPath} }

func (c *Client) WikiDocument(string) (repohost.WikiDocumentResult, error) {
	return repohost.WikiDocumentResult{}, ffiUnavailable()
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

func (e *Error) StatusCode() int {
	switch e.Code {
	case "invalid_argument", "bad_request":
		return 400
	case "not_found", "file_not_found", "landing_receipt_missing", "workspace_source_missing":
		return 404
	case "conflict":
		return 409
	case "unprocessable_entity":
		return 422
	default:
		return 500
	}
}

func ffiUnavailable() error {
	return errors.New("repohost ffi is unavailable when built with CGO_ENABLED=0")
}

func (c *Client) Load() error { return ffiUnavailable() }

func (c *Client) InitRepo(storePath string) (InitRepoResult, error) {
	return InitRepoResult{}, ffiUnavailable()
}

func (c *Client) AutoInitRepo(storePath, bookmarkName, repoName string) (InitRepoResult, error) {
	return InitRepoResult{}, ffiUnavailable()
}

func (c *Client) DeleteRepo(storePath string) error { return ffiUnavailable() }

func (c *Client) ImportGitRefs(storePath string) error { return ffiUnavailable() }

func (c *Client) ExportGitRefs(storePath string) error { return ffiUnavailable() }

func (c *Client) InitWikiRepo(storePath string) (bool, error) { return false, ffiUnavailable() }

func (c *Client) InitDocsRepo(storePath string) (bool, error) { return false, ffiUnavailable() }

func (c *Client) CommitWikiPage(storePath, pageName, content, authorName, authorEmail, message string) (string, error) {
	return "", ffiUnavailable()
}

func (c *Client) CommitDoc(storePath, filePath, content, authorName, authorEmail, message string) (string, error) {
	return "", ffiUnavailable()
}

func (c *Client) GetWikiPageContent(storePath, pageName, commitSHA string) (string, string, error) {
	return "", "", ffiUnavailable()
}

func (c *Client) GetDocContent(storePath, filePath, commitSHA string) (string, string, error) {
	return "", "", ffiUnavailable()
}

func (c *Client) ListWikiPageHistory(storePath, pageName string, limit uint32) ([]repohost.WikiRevision, error) {
	return nil, ffiUnavailable()
}

func (c *Client) ListDocHistory(storePath, filePath string, limit uint32) ([]repohost.WikiRevision, error) {
	return nil, ffiUnavailable()
}

func (c *Client) DeleteWikiPage(storePath, pageName, authorName, authorEmail string) error {
	return ffiUnavailable()
}

func (c *Client) DeleteDoc(storePath, filePath, authorName, authorEmail string) error {
	return ffiUnavailable()
}

func (c *Client) ListChanges(storePath string, page, perPage uint32) (Paginated[repohost.Change], error) {
	return Paginated[repohost.Change]{}, ffiUnavailable()
}

func (c *Client) GetChange(storePath, changeID string) (repohost.Change, error) {
	return repohost.Change{}, ffiUnavailable()
}

func (c *Client) BackoutChange(storePath, changeID, revision, targetBookmark, base string) (repohost.Change, error) {
	return repohost.Change{}, ffiUnavailable()
}

func (c *Client) SplitChange(storePath, changeID string, paths []string, description string) (repohost.SplitChangeResult, error) {
	return repohost.SplitChangeResult{}, ffiUnavailable()
}

func (c *Client) GetDiff(storePath, changeID string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, ffiUnavailable()
}

func (c *Client) GetRevisionDiff(storePath, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, ffiUnavailable()
}

func (c *Client) GetFiles(storePath, changeID string) ([]repohost.ChangeFile, error) {
	return nil, ffiUnavailable()
}

func (c *Client) ListTreeFiles(storePath, changeID, prefix string) ([]repohost.ChangeFile, error) {
	return nil, ffiUnavailable()
}

func (c *Client) ListDirectory(storePath, changeID, prefix, after string, limit uint32) ([]repohost.TreeEntry, error) {
	return nil, ffiUnavailable()
}

func (c *Client) GetConflicts(storePath, changeID string) ([]repohost.Conflict, error) {
	return nil, ffiUnavailable()
}

func (c *Client) LandChanges(storePath, requestJSON string) (repohost.LandResult, error) {
	return repohost.LandResult{}, ffiUnavailable()
}

func (c *Client) LandChange(storePath, changeID, targetBookmark string) (repohost.LandResult, error) {
	return repohost.LandResult{}, ffiUnavailable()
}

func (c *Client) ComposeSuperproject(storePath, requestJSON string) (repohost.SuperprojectCommit, error) {
	return repohost.SuperprojectCommit{}, ffiUnavailable()
}

func (c *Client) ReadSuperproject(storePath, revision string) (repohost.SuperprojectCommit, error) {
	return repohost.SuperprojectCommit{}, ffiUnavailable()
}

func (c *Client) GetBookmark(storePath, name string) (*repohost.Bookmark, error) {
	return nil, ffiUnavailable()
}

func (c *Client) ListBookmarks(storePath string, page, perPage uint32) (Paginated[repohost.Bookmark], error) {
	return Paginated[repohost.Bookmark]{}, ffiUnavailable()
}

func (c *Client) CreateBookmark(storePath, name, changeID string) (repohost.Bookmark, error) {
	return repohost.Bookmark{}, ffiUnavailable()
}

func (c *Client) CreateBookmarkIfAbsent(storePath, name, changeID string) (repohost.Bookmark, error) {
	return repohost.Bookmark{}, ffiUnavailable()
}

func (c *Client) DeleteBookmark(storePath, name string) error { return ffiUnavailable() }

func (c *Client) GetFileContent(storePath, changeID, path string) (repohost.FileContent, error) {
	return repohost.FileContent{}, ffiUnavailable()
}

func (c *Client) CreateSnapshot(storePath, changeID string) (repohost.SnapshotResult, error) {
	return repohost.SnapshotResult{}, ffiUnavailable()
}

func (c *Client) ListOperations(storePath string, page, perPage uint32) (Paginated[repohost.Operation], error) {
	return Paginated[repohost.Operation]{}, ffiUnavailable()
}

func (c *Client) GetWorkingTreeStatus(storePath string) (repohost.WorkingTreeStatus, error) {
	return repohost.WorkingTreeStatus{}, ffiUnavailable()
}

func (c *Client) ProjectWikiRevision(path, json string) (string, error) { return "", ffiUnavailable() }

func (c *Client) ReadWorkspaceSource(path, workspaceID string, source repohost.WorkspaceSource) (repohost.WorkspaceSourceReceipt, error) {
	return repohost.WorkspaceSourceReceipt{}, ffiUnavailable()
}

func (c *Client) PrepareLandAppend(string, repohost.AppendPreparationRequest) (repohost.AppendPreparation, error) {
	return repohost.AppendPreparation{}, ffiUnavailable()
}
