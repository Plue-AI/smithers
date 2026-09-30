package repohostserver

import (
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

const testAuthToken = "test-secret-token"

// mockFFI is a configurable mock that implements FFIClient for testing
// the HTTP layer without the real Rust FFI / CGO dependency.
type mockFFI struct {
	wikiDocumentFn           func(string) (repohost.WikiDocumentResult, error)
	landChangesFn            func(string, repohost.LandRequest) (repohost.LandResult, error)
	initRepoFn               func(storePath string) (repohostffi.InitRepoResult, error)
	composeSuperprojectFn    func(storePath, requestJSON string) (repohost.SuperprojectCommit, error)
	readSuperprojectFn       func(storePath, revision string) (repohost.SuperprojectCommit, error)
	autoInitRepoFn           func(storePath, bookmarkName, repoName string) (repohostffi.InitRepoResult, error)
	deleteRepoFn             func(storePath string) error
	importGitRefsFn          func(storePath string) error
	exportGitRefsFn          func(storePath string) error
	initWikiRepoFn           func(storePath string) (bool, error)
	initDocsRepoFn           func(storePath string) (bool, error)
	commitWikiPageFn         func(storePath, pageName, content, authorName, authorEmail, message string) (string, error)
	commitDocFn              func(storePath, filePath, content, authorName, authorEmail, message string) (string, error)
	getWikiPageContentFn     func(storePath, pageName, commitSHA string) (string, string, error)
	getDocContentFn          func(storePath, filePath, commitSHA string) (string, string, error)
	listWikiPageHistoryFn    func(storePath, pageName string, limit uint32) ([]repohost.WikiRevision, error)
	listDocHistoryFn         func(storePath, filePath string, limit uint32) ([]repohost.WikiRevision, error)
	deleteWikiPageFn         func(storePath, pageName, authorName, authorEmail string) error
	deleteDocFn              func(storePath, filePath, authorName, authorEmail string) error
	getBookmarkFn            func(storePath, name string) (*repohost.Bookmark, error)
	listBookmarksFn          func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Bookmark], error)
	createBookmarkFn         func(storePath, name, changeID string) (repohost.Bookmark, error)
	createBookmarkIfAbsentFn func(storePath, name, changeID string) (repohost.Bookmark, error)
	deleteBookmarkFn         func(storePath, name string) error
	listChangesFn            func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Change], error)
	getChangeFn              func(storePath, changeID string) (repohost.Change, error)
	backoutChangeFn          func(storePath, changeID, revision, targetBookmark, base string) (repohost.Change, error)
	splitChangeFn            func(storePath, changeID string, paths []string, description string) (repohost.SplitChangeResult, error)
	getDiffFn                func(storePath, changeID string) (repohost.ChangeDiff, error)
	getRevisionDiffFn        func(storePath, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error)
	getFilesFn               func(storePath, changeID string) ([]repohost.ChangeFile, error)
	listTreeFilesFn          func(storePath, changeID, prefix string) ([]repohost.ChangeFile, error)
	listDirectoryFn          func(storePath, changeID, prefix, after string, limit uint32) ([]repohost.TreeEntry, error)
	getConflictsFn           func(storePath, changeID string) ([]repohost.Conflict, error)
	landChangeFn             func(storePath, changeID, targetBookmark string) (repohost.LandResult, error)
	getFileContentFn         func(storePath, changeID, path string) (repohost.FileContent, error)
	createSnapshotFn         func(storePath, changeID string) (repohost.SnapshotResult, error)
	listOperationsFn         func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Operation], error)
	getWorkingTreeStatusFn   func(storePath string) (repohost.WorkingTreeStatus, error)
}

func (m *mockFFI) InitRepo(storePath string) (repohostffi.InitRepoResult, error) {
	if m.initRepoFn != nil {
		return m.initRepoFn(storePath)
	}
	return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
}

func (m *mockFFI) AutoInitRepo(storePath, bookmarkName, repoName string) (repohostffi.InitRepoResult, error) {
	if m.autoInitRepoFn != nil {
		return m.autoInitRepoFn(storePath, bookmarkName, repoName)
	}
	return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
}

func (m *mockFFI) DeleteRepo(storePath string) error {
	if m.deleteRepoFn != nil {
		return m.deleteRepoFn(storePath)
	}
	return nil
}

func (m *mockFFI) ImportGitRefs(storePath string) error {
	if m.importGitRefsFn != nil {
		return m.importGitRefsFn(storePath)
	}
	return nil
}

func (m *mockFFI) ExportGitRefs(storePath string) error {
	if m.exportGitRefsFn != nil {
		return m.exportGitRefsFn(storePath)
	}
	return nil
}

func (m *mockFFI) WikiDocument(request string) (repohost.WikiDocumentResult, error) {
	if m.wikiDocumentFn != nil {
		return m.wikiDocumentFn(request)
	}
	return repohost.WikiDocumentResult{}, nil
}

func (m *mockFFI) InitWikiRepo(storePath string) (bool, error) {
	if m.initWikiRepoFn != nil {
		return m.initWikiRepoFn(storePath)
	}
	return true, nil
}

func (m *mockFFI) InitDocsRepo(storePath string) (bool, error) {
	if m.initDocsRepoFn != nil {
		return m.initDocsRepoFn(storePath)
	}
	return true, nil
}

func (m *mockFFI) CommitWikiPage(storePath, pageName, content, authorName, authorEmail, message string) (string, error) {
	if m.commitWikiPageFn != nil {
		return m.commitWikiPageFn(storePath, pageName, content, authorName, authorEmail, message)
	}
	return "abc123", nil
}

func (m *mockFFI) CommitDoc(storePath, filePath, content, authorName, authorEmail, message string) (string, error) {
	if m.commitDocFn != nil {
		return m.commitDocFn(storePath, filePath, content, authorName, authorEmail, message)
	}
	return "abc123", nil
}

func (m *mockFFI) GetWikiPageContent(storePath, pageName, commitSHA string) (string, string, error) {
	if m.getWikiPageContentFn != nil {
		return m.getWikiPageContentFn(storePath, pageName, commitSHA)
	}
	return "# Hello", "abc123", nil
}

func (m *mockFFI) GetDocContent(storePath, filePath, commitSHA string) (string, string, error) {
	if m.getDocContentFn != nil {
		return m.getDocContentFn(storePath, filePath, commitSHA)
	}
	return "# Hello", "abc123", nil
}

func (m *mockFFI) ListWikiPageHistory(storePath, pageName string, limit uint32) ([]repohost.WikiRevision, error) {
	if m.listWikiPageHistoryFn != nil {
		return m.listWikiPageHistoryFn(storePath, pageName, limit)
	}
	return []repohost.WikiRevision{}, nil
}

func (m *mockFFI) ListDocHistory(storePath, filePath string, limit uint32) ([]repohost.WikiRevision, error) {
	if m.listDocHistoryFn != nil {
		return m.listDocHistoryFn(storePath, filePath, limit)
	}
	return []repohost.WikiRevision{}, nil
}

func (m *mockFFI) DeleteWikiPage(storePath, pageName, authorName, authorEmail string) error {
	if m.deleteWikiPageFn != nil {
		return m.deleteWikiPageFn(storePath, pageName, authorName, authorEmail)
	}
	return nil
}

func (m *mockFFI) DeleteDoc(storePath, filePath, authorName, authorEmail string) error {
	if m.deleteDocFn != nil {
		return m.deleteDocFn(storePath, filePath, authorName, authorEmail)
	}
	return nil
}

func (m *mockFFI) GetBookmark(storePath, name string) (*repohost.Bookmark, error) {
	if m.getBookmarkFn != nil {
		return m.getBookmarkFn(storePath, name)
	}
	return nil, nil
}

func (m *mockFFI) ListBookmarks(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Bookmark], error) {
	if m.listBookmarksFn != nil {
		return m.listBookmarksFn(storePath, page, perPage)
	}
	return repohostffi.Paginated[repohost.Bookmark]{
		Items:      []repohost.Bookmark{},
		TotalCount: 0,
	}, nil
}

func (m *mockFFI) CreateBookmark(storePath, name, changeID string) (repohost.Bookmark, error) {
	if m.createBookmarkFn != nil {
		return m.createBookmarkFn(storePath, name, changeID)
	}
	return repohost.Bookmark{
		Name:           name,
		TargetChangeID: changeID,
		TargetCommitID: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	}, nil
}

func (m *mockFFI) CreateBookmarkIfAbsent(storePath, name, changeID string) (repohost.Bookmark, error) {
	if m.createBookmarkIfAbsentFn != nil {
		return m.createBookmarkIfAbsentFn(storePath, name, changeID)
	}
	return m.CreateBookmark(storePath, name, changeID)
}

func (m *mockFFI) DeleteBookmark(storePath, name string) error {
	if m.deleteBookmarkFn != nil {
		return m.deleteBookmarkFn(storePath, name)
	}
	return nil
}

func (m *mockFFI) ListChanges(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Change], error) {
	if m.listChangesFn != nil {
		return m.listChangesFn(storePath, page, perPage)
	}
	return repohostffi.Paginated[repohost.Change]{
		Items: []repohost.Change{
			{
				ChangeID:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				CommitID:    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				Description: "initial commit",
				AuthorName:  "Test User",
				AuthorEmail: "test@example.com",
				Timestamp:   "2025-01-01T00:00:00Z",
			},
		},
		TotalCount: 1,
	}, nil
}

func (m *mockFFI) GetChange(storePath, changeID string) (repohost.Change, error) {
	if m.getChangeFn != nil {
		return m.getChangeFn(storePath, changeID)
	}
	return repohost.Change{
		ChangeID:    changeID,
		CommitID:    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Description: "test change",
		AuthorName:  "Test User",
		AuthorEmail: "test@example.com",
		Timestamp:   "2025-01-01T00:00:00Z",
	}, nil
}

func (m *mockFFI) BackoutChange(storePath, changeID, revision, targetBookmark, base string) (repohost.Change, error) {
	if m.backoutChangeFn != nil {
		return m.backoutChangeFn(storePath, changeID, revision, targetBookmark, base)
	}
	return repohost.Change{}, nil
}

func (m *mockFFI) SplitChange(storePath, changeID string, paths []string, description string) (repohost.SplitChangeResult, error) {
	if m.splitChangeFn != nil {
		return m.splitChangeFn(storePath, changeID, paths, description)
	}
	return repohost.SplitChangeResult{}, nil
}

func (m *mockFFI) GetDiff(storePath, changeID string) (repohost.ChangeDiff, error) {
	if m.getDiffFn != nil {
		return m.getDiffFn(storePath, changeID)
	}
	return repohost.ChangeDiff{
		ChangeID:  changeID,
		FileDiffs: []repohost.FileDiff{},
	}, nil
}

func (m *mockFFI) GetRevisionDiff(storePath, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error) {
	if m.getRevisionDiffFn != nil {
		return m.getRevisionDiffFn(storePath, fromCommitID, toCommitID, path)
	}
	return repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{}}, nil
}

func (m *mockFFI) GetFiles(storePath, changeID string) ([]repohost.ChangeFile, error) {
	if m.getFilesFn != nil {
		return m.getFilesFn(storePath, changeID)
	}
	return []repohost.ChangeFile{}, nil
}

func (m *mockFFI) ListTreeFiles(storePath, changeID, prefix string) ([]repohost.ChangeFile, error) {
	if m.listTreeFilesFn != nil {
		return m.listTreeFilesFn(storePath, changeID, prefix)
	}
	return []repohost.ChangeFile{}, nil
}

func (m *mockFFI) ListDirectory(storePath, changeID, prefix, after string, limit uint32) ([]repohost.TreeEntry, error) {
	if m.listDirectoryFn != nil {
		return m.listDirectoryFn(storePath, changeID, prefix, after, limit)
	}
	return []repohost.TreeEntry{}, nil
}

func (m *mockFFI) GetConflicts(storePath, changeID string) ([]repohost.Conflict, error) {
	if m.getConflictsFn != nil {
		return m.getConflictsFn(storePath, changeID)
	}
	return []repohost.Conflict{}, nil
}

func (m *mockFFI) LandChanges(storePath, requestJSON string) (repohost.LandResult, error) {
	var req repohost.LandRequest
	if err := json.Unmarshal([]byte(requestJSON), &req); err != nil {
		return repohost.LandResult{}, err
	}
	if m.landChangesFn != nil {
		return m.landChangesFn(storePath, req)
	}
	for _, id := range req.ChangeIDs {
		if _, err := m.GetChange(storePath, id); err != nil {
			return repohost.LandResult{}, err
		}
	}
	result, err := m.LandChange(storePath, req.ChangeIDs[len(req.ChangeIDs)-1], req.TargetBookmark)
	result.LandedCount = len(req.ChangeIDs)
	return result, err
}

func (m *mockFFI) LandChange(storePath, changeID, targetBookmark string) (repohost.LandResult, error) {
	if m.landChangeFn != nil {
		return m.landChangeFn(storePath, changeID, targetBookmark)
	}
	return repohost.LandResult{
		TargetBookmark: targetBookmark,
		TargetCommitID: "cccccccccccccccccccccccccccccccccccccccc",
	}, nil
}

func (m *mockFFI) GetFileContent(storePath, changeID, path string) (repohost.FileContent, error) {
	if m.getFileContentFn != nil {
		return m.getFileContentFn(storePath, changeID, path)
	}
	return repohost.FileContent{
		Path:    path,
		Content: "file content",
	}, nil
}

func (m *mockFFI) CreateSnapshot(storePath, changeID string) (repohost.SnapshotResult, error) {
	if m.createSnapshotFn != nil {
		return m.createSnapshotFn(storePath, changeID)
	}
	return repohost.SnapshotResult{
		ChangeID:     changeID,
		SnapshotPath: "/tmp/snapshots/" + changeID,
	}, nil
}

func (m *mockFFI) ListOperations(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Operation], error) {
	if m.listOperationsFn != nil {
		return m.listOperationsFn(storePath, page, perPage)
	}
	return repohostffi.Paginated[repohost.Operation]{
		Items: []repohost.Operation{
			{
				OperationID: "op-1",
				Description: "init repo",
				Timestamp:   "2025-01-01T00:00:00Z",
			},
		},
		TotalCount: 1,
	}, nil
}

func (m *mockFFI) ComposeSuperproject(storePath, requestJSON string) (repohost.SuperprojectCommit, error) {
	if m.composeSuperprojectFn != nil {
		return m.composeSuperprojectFn(storePath, requestJSON)
	}
	return repohost.SuperprojectCommit{
		ChangeID:        "spchange000000000000000000000000",
		CommitID:        "0000000000000000000000000000000000000001",
		ParentCommitIDs: []string{},
		Description:     "changeset",
		Members:         []repohost.SuperprojectMember{{Path: "api", CommitID: "0000000000000000000000000000000000000002"}},
	}, nil
}

func (m *mockFFI) ReadSuperproject(storePath, revision string) (repohost.SuperprojectCommit, error) {
	if m.readSuperprojectFn != nil {
		return m.readSuperprojectFn(storePath, revision)
	}
	return repohost.SuperprojectCommit{
		ChangeID:        "spchange000000000000000000000000",
		CommitID:        revision,
		ParentCommitIDs: []string{},
		Description:     "changeset",
		Members:         []repohost.SuperprojectMember{{Path: "api", CommitID: "0000000000000000000000000000000000000002"}},
	}, nil
}

func (m *mockFFI) GetWorkingTreeStatus(storePath string) (repohost.WorkingTreeStatus, error) {
	if m.getWorkingTreeStatusFn != nil {
		return m.getWorkingTreeStatusFn(storePath)
	}
	return repohost.WorkingTreeStatus{
		Backend: "git",
		Branch:  "main",
		Head:    "abcd1234",
		Changes: []repohost.WorkingTreeChange{
			{Path: "README.md", Status: "modified", Staged: true, Add: 1, Del: 0},
		},
	}, nil
}

// newTestServer creates a Server backed by a mockFFI for httptest-based tests.
// The default mock returns canned success responses for all operations.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	return newTestServerWithMock(t, &mockFFI{})
}

// newTestServerWithMock creates a Server with a specific mock FFI.
func newTestServerWithMock(t *testing.T, mock *mockFFI) *Server {
	t.Helper()
	cfg := Config{
		StoragePath:           t.TempDir(),
		AuthToken:             testAuthToken,
		PushHookCallbackToken: "test-push-callback-token",
	}
	srv, err := NewWithFFI(cfg, mock)
	if err != nil {
		t.Fatalf("NewWithFFI: %v", err)
	}
	return srv
}

// validAuth returns the Authorization header value for the test server.
func validAuth() string {
	return "Bearer " + testAuthToken
}

func (m *mockFFI) ProjectWikiRevision(path, json string) (string, error) { return "test-commit", nil }
