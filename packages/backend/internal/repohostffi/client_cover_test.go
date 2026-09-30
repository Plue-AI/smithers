//go:build cgo

package repohostffi

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// clientNativeChildEnv marks the child test process that loads the native
// library; a process binds one library, and the fake-library coverage below
// loads its own in the parent.
const clientNativeChildEnv = "SMITHERS_REPOHOSTFFI_NATIVE_CHILD"

func TestClientNativeBookmarkLookup(t *testing.T) {
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("requires built native library")
	}
	if os.Getenv(clientNativeChildEnv) != "1" {
		child := exec.Command(os.Args[0], "-test.run=^TestClientNativeBookmarkLookup$", "-test.count=1", "-test.v")
		child.Env = append(os.Environ(), clientNativeChildEnv+"=1")
		output, err := child.CombinedOutput()
		require.NoError(t, err, "%s", output)
		require.Contains(t, string(output), "--- PASS: TestClientNativeBookmarkLookup")
		return
	}
	client := New(library)
	require.NoError(t, client.Load())
	path := filepath.Join(t.TempDir(), "repository")
	_, err := client.AutoInitRepo(path, "main", "lookup")
	require.NoError(t, err)
	bookmark, err := client.GetBookmark(path, "main")
	require.NoError(t, err)
	require.NotNil(t, bookmark)
	require.Equal(t, "main", bookmark.Name)
	require.NotEmpty(t, bookmark.TargetCommitID)
	absent, err := client.GetBookmark(path, "absent")
	require.NoError(t, err)
	require.Nil(t, absent)
	_, err = client.GetFileContent(path, bookmark.TargetCommitID, "absent")
	var missingFile *Error
	require.ErrorAs(t, err, &missingFile)
	require.Equal(t, "file_not_found", missingFile.Code)
	require.Equal(t, 404, missingFile.StatusCode())
	_, err = client.GetFileContent(path, "ffffffffffffffffffffffffffffffffffffffff", "absent")
	var missingCommit *Error
	require.ErrorAs(t, err, &missingCommit)
	require.Equal(t, "not_found", missingCommit.Code)
	directoryCommit, err := client.CommitDoc(path, "directory/file.md", "present", "Test", "test@example.com", "directory regression")
	require.NoError(t, err)
	_, err = client.GetFileContent(path, directoryCommit, "directory")
	var directoryError *Error
	require.ErrorAs(t, err, &directoryError)
	require.Equal(t, "not_found", directoryError.Code)
	require.Equal(t, 404, directoryError.StatusCode())
	file, err := client.GetFileContent(path, directoryCommit, "directory/file.md")
	require.NoError(t, err)
	require.Equal(t, "present", file.Content)
	_, err = client.GetBookmark(path, " ")
	require.Error(t, err)
}

func TestClient_Cov_LoadDecodeAndMethods(t *testing.T) {
	require.NotPanics(t, func() { freeCString(nil) })

	unloaded := New("unused")
	assert.Equal(t, "unused", unloaded.libPath)
	_, err := unloaded.InitRepo("before-load")
	require.EqualError(t, err, "smithers ffi library is not loaded")

	require.EqualError(t, New("").Load(), "smithers ffi library path is not configured")
	missingLib := filepath.Join(t.TempDir(), "missing-repohostffi-library")
	err = New(missingLib).Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load smithers ffi library "+missingLib)

	// A stale library missing one required symbol must fail Load, and so
	// startup, instead of loading and failing every request that needs it.
	stale := New(clientCovBuildFakeLibrary(t, "-DOMIT_LAND_APPEND"))
	err = stale.Load()
	require.ErrorContains(t, err, "missing required symbol smithers_land_append")
	_, err = stale.InitRepo("store-ok")
	require.EqualError(t, err, "smithers ffi library is not loaded")

	client := New(clientCovBuildFakeLibrary(t))
	require.NoError(t, client.Load())
	require.NoError(t, client.Load(), "a second Load is a no-op")
	require.NoError(t, New(client.libPath).Load(), "another client of the loaded library loads")
	err = New(missingLib).Load()
	require.EqualError(t, err, "load smithers ffi library "+missingLib+": "+client.libPath+" is already loaded",
		"a different library cannot load over the bound one")

	clientCovAssertArgumentOrder(t, client)

	initResult, err := client.InitRepo("store-ok")
	require.NoError(t, err)
	assert.Equal(t, InitRepoResult{Status: "initialized", Path: "store-ok"}, initResult)

	autoResult, err := client.AutoInitRepo("store-ok", "main", "demo")
	require.NoError(t, err)
	assert.Equal(t, InitRepoResult{Status: "auto main demo", Path: "store-ok"}, autoResult)

	require.NoError(t, client.DeleteRepo("store-ok"))
	require.NoError(t, client.ImportGitRefs("store-ok"))
	require.NoError(t, client.ExportGitRefs("store-ok"))

	wikiCreated, err := client.InitWikiRepo("store-ok")
	require.NoError(t, err)
	assert.True(t, wikiCreated)

	docsCreated, err := client.InitDocsRepo("store-ok")
	require.NoError(t, err)
	assert.False(t, docsCreated)

	wikiSHA, err := client.CommitWikiPage("store-ok", "Home", "body", "Ada", "ada@example.com", "wiki message")
	require.NoError(t, err)
	assert.Equal(t, "wiki-commit", wikiSHA)

	docSHA, err := client.CommitDoc("store-ok", "docs/intro.md", "doc", "Ada", "ada@example.com", "doc message")
	require.NoError(t, err)
	assert.Equal(t, "doc-commit", docSHA)

	content, commitSHA, err := client.GetWikiPageContent("store-ok", "Home", "wiki-rev")
	require.NoError(t, err)
	assert.Equal(t, "wiki Home at wiki-rev", content)
	assert.Equal(t, "wiki-rev", commitSHA)

	content, commitSHA, err = client.GetDocContent("store-ok", "docs/intro.md", "doc-rev")
	require.NoError(t, err)
	assert.Equal(t, "doc docs/intro.md at doc-rev", content)
	assert.Equal(t, "doc-rev", commitSHA)

	revisionTime := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	wikiHistory, err := client.ListWikiPageHistory("store-ok", "Home", 10)
	require.NoError(t, err)
	assert.Equal(t, []repohost.WikiRevision{{
		CommitSHA: "wiki-history-sha",
		Message:   "wiki history",
		Author:    "Ada",
		Email:     "ada@example.com",
		Timestamp: revisionTime,
	}}, wikiHistory)

	docHistory, err := client.ListDocHistory("store-ok", "docs/intro.md", 5)
	require.NoError(t, err)
	assert.Equal(t, []repohost.WikiRevision{{
		CommitSHA: "doc-history-sha",
		Message:   "doc history",
		Author:    "Grace",
		Email:     "grace@example.com",
		Timestamp: revisionTime,
	}}, docHistory)

	require.NoError(t, client.DeleteWikiPage("store-ok", "Home", "Ada", "ada@example.com"))
	require.NoError(t, client.DeleteDoc("store-ok", "docs/intro.md", "Ada", "ada@example.com"))

	changes, err := client.ListChanges("store-ok", 2, 25)
	require.NoError(t, err)
	assert.Equal(t, Paginated[repohost.Change]{
		Items: []repohost.Change{{
			ChangeID:        "change-1",
			CommitID:        "commit-1",
			Description:     "demo change",
			AuthorName:      "Ada",
			AuthorEmail:     "ada@example.com",
			Timestamp:       "2025-01-02T03:04:05Z",
			HasConflict:     true,
			IsEmpty:         false,
			ParentChangeIDs: []string{"parent-1"},
		}},
		TotalCount: 1,
	}, changes)

	change, err := client.GetChange("store-ok", "change-1")
	require.NoError(t, err)
	assert.Equal(t, repohost.Change{
		ChangeID:        "change-1",
		CommitID:        "commit-1",
		Description:     "single change",
		AuthorName:      "Ada",
		AuthorEmail:     "ada@example.com",
		Timestamp:       "2025-01-02T03:04:05Z",
		HasConflict:     false,
		IsEmpty:         true,
		ParentChangeIDs: []string{"parent-1"},
	}, change)

	diff, err := client.GetDiff("store-ok", "change-1")
	require.NoError(t, err)
	assert.Equal(t, repohost.ChangeDiff{
		ChangeID: "change-1",
		FileDiffs: []repohost.FileDiff{{
			Path:       "README.md",
			ChangeType: "modified",
			Patch:      "@@ -1 +1 @@",
			IsBinary:   false,
			Language:   "Markdown",
			Additions:  2,
			Deletions:  1,
			OldContent: "old",
			NewContent: "new",
		}},
	}, diff)

	files, err := client.GetFiles("store-ok", "change-1")
	require.NoError(t, err)
	assert.Equal(t, []repohost.ChangeFile{{Path: "README.md"}}, files)

	treeFiles, err := client.ListTreeFiles("store-ok", "change-1", "docs")
	require.NoError(t, err)
	assert.Equal(t, []repohost.ChangeFile{{Path: "docs/intro.md"}}, treeFiles)

	conflicts, err := client.GetConflicts("store-ok", "change-1")
	require.NoError(t, err)
	assert.Equal(t, []repohost.Conflict{{
		FilePath:         "README.md",
		ConflictType:     "content",
		BaseContent:      "base",
		LeftContent:      "left",
		RightContent:     "right",
		Hunks:            "<<<<<<<",
		ResolutionStatus: "unresolved",
	}}, conflicts)

	landResult, err := client.LandChange("store-ok", "change-1", "main")
	require.NoError(t, err)
	assert.Equal(t, repohost.LandResult{
		LandedCount:    1,
		TargetBookmark: "main",
		TargetCommitID: "landed-commit",
	}, landResult)

	resolvedBookmark, err := client.GetBookmark("store-ok", "feature")
	if err != nil || resolvedBookmark == nil || resolvedBookmark.Name != "feature" || resolvedBookmark.TargetCommitID != "commit-1" {
		t.Fatalf("GetBookmark = %+v, %v", resolvedBookmark, err)
	}
	_, err = client.GetBookmark("store-ok", "feature\x00other")
	if err == nil {
		t.Fatal("GetBookmark must reject NUL name")
	}

	bookmarks, err := client.ListBookmarks("store-ok", 1, 20)
	require.NoError(t, err)
	assert.Equal(t, Paginated[repohost.Bookmark]{
		Items: []repohost.Bookmark{{
			Name:             "main",
			TargetChangeID:   "change-1",
			TargetCommitID:   "commit-1",
			IsTrackingRemote: true,
		}},
		TotalCount: 1,
	}, bookmarks)

	bookmark, err := client.CreateBookmark("store-ok", "feature", "change-1")
	require.NoError(t, err)
	assert.Equal(t, repohost.Bookmark{
		Name:             "feature",
		TargetChangeID:   "change-1",
		TargetCommitID:   "commit-1",
		IsTrackingRemote: false,
	}, bookmark)

	existingBookmark, err := client.CreateBookmarkIfAbsent("store-ok", "main", "ignored-change")
	require.NoError(t, err)
	assert.Equal(t, repohost.Bookmark{
		Name:             "main",
		TargetChangeID:   "change-1",
		TargetCommitID:   "commit-1",
		IsTrackingRemote: true,
	}, existingBookmark)

	require.NoError(t, client.DeleteBookmark("store-ok", "feature"))

	fileContent, err := client.GetFileContent("store-ok", "change-1", "README.md")
	require.NoError(t, err)
	assert.Equal(t, repohost.FileContent{Path: "README.md", Content: "hello\n"}, fileContent)

	snapshot, err := client.CreateSnapshot("store-ok", "change-1")
	require.NoError(t, err)
	assert.Equal(t, repohost.SnapshotResult{
		ChangeID:     "change-1",
		SnapshotPath: "/tmp/snapshot",
		FileCount:    3,
	}, snapshot)

	operations, err := client.ListOperations("store-ok", 1, 20)
	require.NoError(t, err)
	assert.Equal(t, Paginated[repohost.Operation]{
		Items: []repohost.Operation{{
			OperationID: "op-1",
			Description: "created repo",
			Timestamp:   "2025-01-02T03:04:05Z",
		}},
		TotalCount: 1,
	}, operations)

	status, err := client.GetWorkingTreeStatus("store-ok")
	require.NoError(t, err)
	assert.Equal(t, repohost.WorkingTreeStatus{
		Backend: "jj",
		Branch:  "main",
		Head:    "head-1",
		Changes: []repohost.WorkingTreeChange{{
			Path:   "README.md",
			Status: "modified",
			Staged: true,
			Add:    3,
			Del:    1,
		}},
	}, status)

	_, err = client.InitRepo("ffi-error")
	var ffiErr *Error
	require.ErrorAs(t, err, &ffiErr)
	assert.Equal(t, "not_found", ffiErr.Code)
	assert.Equal(t, "repo missing", ffiErr.Message)
	assert.Equal(t, 404, ffiErr.StatusCode())

	_, err = client.InitRepo("bad-envelope")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode smithers ffi error envelope")

	_, err = client.InitRepo("bad-json")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode smithers ffi response")

	wikiCreated, err = client.InitWikiRepo("ffi-error")
	require.Error(t, err)
	assert.False(t, wikiCreated)

	docsCreated, err = client.InitDocsRepo("ffi-error")
	require.Error(t, err)
	assert.False(t, docsCreated)

	wikiSHA, err = client.CommitWikiPage("ffi-error", "Home", "body", "Ada", "ada@example.com", "wiki message")
	require.Error(t, err)
	assert.Empty(t, wikiSHA)

	docSHA, err = client.CommitDoc("ffi-error", "docs/intro.md", "doc", "Ada", "ada@example.com", "doc message")
	require.Error(t, err)
	assert.Empty(t, docSHA)

	content, commitSHA, err = client.GetWikiPageContent("ffi-error", "Home", "wiki-rev")
	require.Error(t, err)
	assert.Empty(t, content)
	assert.Empty(t, commitSHA)

	content, commitSHA, err = client.GetDocContent("ffi-error", "docs/intro.md", "doc-rev")
	require.Error(t, err)
	assert.Empty(t, content)
	assert.Empty(t, commitSHA)

	require.Error(t, client.DeleteRepo("ffi-error"))
}

func TestClient_RejectsInteriorNULArguments(t *testing.T) {
	t.Parallel()

	// The guard must fire before any C-string conversion or library call, so
	// an unloaded client is sufficient.
	client := New("unused")

	requireInvalidArgument := func(t *testing.T, err error) {
		t.Helper()
		var ffiErr *Error
		require.ErrorAs(t, err, &ffiErr)
		assert.Equal(t, "invalid_argument", ffiErr.Code)
		assert.Equal(t, 400, ffiErr.StatusCode())
	}

	_, err := client.GetFileContent("store", "change", "notes.md\x00suffix")
	requireInvalidArgument(t, err)

	_, err = client.CommitDoc("store", "docs/intro.md", "abc\x00def", "Ada", "ada@example.com", "msg")
	requireInvalidArgument(t, err)

	_, err = client.CommitWikiPage("store", "Home\x00", "body", "Ada", "ada@example.com", "msg")
	requireInvalidArgument(t, err)

	_, err = client.GetChange("store", "change\x00id")
	requireInvalidArgument(t, err)

	_, err = client.CreateBookmark("store", "main\x00extra", "change")
	requireInvalidArgument(t, err)
	_, err = client.CreateBookmarkIfAbsent("store", "main", "change\x00extra")
	requireInvalidArgument(t, err)

	requireInvalidArgument(t, client.DeleteRepo("store\x00path"))
}

func clientCovBuildFakeLibrary(t *testing.T, defines ...string) string {
	t.Helper()

	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "fake_repohostffi.c")
	require.NoError(t, os.WriteFile(sourcePath, []byte(clientCovFakeCSource), 0o600))

	libPath := filepath.Join(dir, "libfake_repohostffi")
	args := append([]string{"-fPIC"}, defines...)
	switch runtime.GOOS {
	case "darwin":
		libPath += ".dylib"
		args = append(args, "-dynamiclib")
	default:
		libPath += ".so"
		args = append(args, "-shared")
	}
	args = append(args, "-o", libPath, sourcePath)

	cmd := exec.Command("cc", args...)
	output, err := cmd.CombinedOutput()
	require.NoErrorf(t, err, "compile fake repohost ffi library:\n%s", string(output))

	if _, err := os.Stat(libPath); errors.Is(err, os.ErrNotExist) {
		t.Fatalf("fake repohost ffi library was not created at %s", libPath)
	}
	return libPath
}

const clientCovFakeCSource = `
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

static char *copy_json(const char *value) {
	size_t size = strlen(value) + 1;
	char *out = (char *)malloc(size);
	if (out != NULL) {
		memcpy(out, value, size);
	}
	return out;
}

static const char *safe_string(const char *value) {
	return value == NULL ? "" : value;
}

static char *format_json1(const char *format, const char *a) {
	int size = snprintf(NULL, 0, format, safe_string(a));
	char *out = (char *)malloc((size_t)size + 1);
	if (out != NULL) {
		snprintf(out, (size_t)size + 1, format, safe_string(a));
	}
	return out;
}

static char *format_json2(const char *format, const char *a, const char *b) {
	int size = snprintf(NULL, 0, format, safe_string(a), safe_string(b));
	char *out = (char *)malloc((size_t)size + 1);
	if (out != NULL) {
		snprintf(out, (size_t)size + 1, format, safe_string(a), safe_string(b));
	}
	return out;
}

static char *format_json3(const char *format, const char *a, const char *b, const char *c) {
	int size = snprintf(NULL, 0, format, safe_string(a), safe_string(b), safe_string(c));
	char *out = (char *)malloc((size_t)size + 1);
	if (out != NULL) {
		snprintf(out, (size_t)size + 1, format, safe_string(a), safe_string(b), safe_string(c));
	}
	return out;
}

static char *special_response(const char *store_path) {
	if (store_path == NULL) {
		return copy_json("{\"code\":\"invalid_argument\",\"error\":\"missing store path\"}");
	}
	if (strcmp(store_path, "ffi-error") == 0) {
		return copy_json("{\"code\":\"not_found\",\"error\":\"repo missing\"}");
	}
	if (strcmp(store_path, "bad-envelope") == 0) {
		return copy_json("{\"code\":1,\"error\":\"bad\"}");
	}
	if (strcmp(store_path, "bad-json") == 0) {
		return copy_json("not-json");
	}
	return NULL;
}

char *smithers_init_repo(const char *store_path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return format_json1("{\"status\":\"initialized\",\"path\":\"%s\"}", store_path);
}

char *smithers_auto_init_repo(const char *store_path, const char *bookmark_name, const char *repo_name) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return format_json3("{\"status\":\"auto %s %s\",\"path\":\"%s\"}", bookmark_name, repo_name, store_path);
}

char *smithers_delete_repo(const char *store_path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"status\":\"deleted\"}");
}

char *smithers_import_git_refs(const char *store_path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"status\":\"imported\"}");
}

char *smithers_export_git_refs(const char *store_path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"status\":\"exported\"}");
}

char *smithers_init_wiki_repo(const char *store_path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"created\":true}");
}

char *smithers_init_docs_repo(const char *store_path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"created\":false}");
}

char *smithers_commit_wiki_page(const char *store_path, const char *page_name, const char *content, const char *author_name, const char *author_email, const char *message) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"commit_sha\":\"wiki-commit\"}");
}

char *smithers_commit_doc(const char *store_path, const char *file_path, const char *content, const char *author_name, const char *author_email, const char *message) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"commit_sha\":\"doc-commit\"}");
}

char *smithers_get_wiki_page_content(const char *store_path, const char *page_name, const char *commit_sha) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return format_json3("{\"content\":\"wiki %s at %s\",\"commit_sha\":\"%s\"}", page_name, commit_sha, commit_sha);
}

char *smithers_get_doc_content(const char *store_path, const char *file_path, const char *commit_sha) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return format_json3("{\"content\":\"doc %s at %s\",\"commit_sha\":\"%s\"}", file_path, commit_sha, commit_sha);
}

char *smithers_list_wiki_page_history(const char *store_path, const char *page_name, unsigned int limit) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("[{\"commit_sha\":\"wiki-history-sha\",\"message\":\"wiki history\",\"author\":\"Ada\",\"email\":\"ada@example.com\",\"timestamp\":\"2025-01-02T03:04:05Z\"}]");
}

char *smithers_list_doc_history(const char *store_path, const char *file_path, unsigned int limit) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("[{\"commit_sha\":\"doc-history-sha\",\"message\":\"doc history\",\"author\":\"Grace\",\"email\":\"grace@example.com\",\"timestamp\":\"2025-01-02T03:04:05Z\"}]");
}

char *smithers_delete_wiki_page(const char *store_path, const char *page_name, const char *author_name, const char *author_email) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"status\":\"deleted\"}");
}

char *smithers_delete_doc(const char *store_path, const char *file_path, const char *author_name, const char *author_email) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"status\":\"deleted\"}");
}

char *smithers_list_changes(const char *store_path, unsigned int page, unsigned int per_page) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"items\":[{\"change_id\":\"change-1\",\"commit_id\":\"commit-1\",\"description\":\"demo change\",\"author_name\":\"Ada\",\"author_email\":\"ada@example.com\",\"timestamp\":\"2025-01-02T03:04:05Z\",\"has_conflict\":true,\"is_empty\":false,\"parent_change_ids\":[\"parent-1\"]}],\"total_count\":1}");
}

char *smithers_get_change(const char *store_path, const char *change_id) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"change_id\":\"change-1\",\"commit_id\":\"commit-1\",\"description\":\"single change\",\"author_name\":\"Ada\",\"author_email\":\"ada@example.com\",\"timestamp\":\"2025-01-02T03:04:05Z\",\"has_conflict\":false,\"is_empty\":true,\"parent_change_ids\":[\"parent-1\"]}");
}

char *smithers_get_diff(const char *store_path, const char *change_id) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"change_id\":\"change-1\",\"file_diffs\":[{\"path\":\"README.md\",\"change_type\":\"modified\",\"patch\":\"@@ -1 +1 @@\",\"is_binary\":false,\"language\":\"Markdown\",\"additions\":2,\"deletions\":1,\"old_content\":\"old\",\"new_content\":\"new\"}]}");
}

char *smithers_get_files(const char *store_path, const char *change_id) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("[{\"path\":\"README.md\"}]");
}

char *smithers_list_tree_files(const char *store_path, const char *change_id, const char *prefix) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return format_json1("[{\"path\":\"%s/intro.md\"}]", prefix);
}

char *smithers_get_conflicts(const char *store_path, const char *change_id) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("[{\"file_path\":\"README.md\",\"conflict_type\":\"content\",\"base_content\":\"base\",\"left_content\":\"left\",\"right_content\":\"right\",\"hunks\":\"<<<<<<<\",\"resolution_status\":\"unresolved\"}]");
}

char *smithers_land_change(const char *store_path, const char *change_id, const char *target_bookmark) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return format_json1("{\"landed_count\":1,\"target_bookmark\":\"%s\",\"target_commit_id\":\"landed-commit\"}", target_bookmark);
}

char *smithers_get_bookmark(const char *store_path, const char *name) {
 char *special = special_response(store_path);
 if (special != NULL) return special;
 return format_json1("{\"name\":\"%s\",\"target_change_id\":\"change-1\",\"target_commit_id\":\"commit-1\"}", name);
}

char *smithers_list_bookmarks(const char *store_path, unsigned int page, unsigned int per_page) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"items\":[{\"name\":\"main\",\"target_change_id\":\"change-1\",\"target_commit_id\":\"commit-1\",\"is_tracking_remote\":true}],\"total_count\":1}");
}

char *smithers_create_bookmark(const char *store_path, const char *name, const char *change_id) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return format_json1("{\"name\":\"%s\",\"target_change_id\":\"change-1\",\"target_commit_id\":\"commit-1\",\"is_tracking_remote\":false}", name);
}

char *smithers_create_bookmark_if_absent(const char *store_path, const char *name, const char *change_id) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"name\":\"main\",\"target_change_id\":\"change-1\",\"target_commit_id\":\"commit-1\",\"is_tracking_remote\":true}");
}

char *smithers_delete_bookmark(const char *store_path, const char *name) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"status\":\"deleted\"}");
}

char *smithers_get_file_content(const char *store_path, const char *change_id, const char *path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return format_json1("{\"path\":\"%s\",\"content\":\"hello\\n\"}", path);
}

char *smithers_create_snapshot(const char *store_path, const char *change_id) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"change_id\":\"change-1\",\"snapshot_path\":\"/tmp/snapshot\",\"file_count\":3}");
}

char *smithers_list_operations(const char *store_path, unsigned int page, unsigned int per_page) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"items\":[{\"operation_id\":\"op-1\",\"description\":\"created repo\",\"timestamp\":\"2025-01-02T03:04:05Z\"}],\"total_count\":1}");
}

char *smithers_get_working_tree_status(const char *store_path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return copy_json("{\"backend\":\"jj\",\"branch\":\"main\",\"head\":\"head-1\",\"changes\":[{\"path\":\"README.md\",\"status\":\"modified\",\"staged\":true,\"add\":3,\"del\":1}]}");
}

static char *escape_json(const char *value) {
	const char *in = safe_string(value);
	char *out = (char *)malloc(strlen(in) * 2 + 1);
	char *cursor = out;
	if (out == NULL) return NULL;
	for (; *in != '\0'; in++) {
		if (*in == '"' || *in == '\\') *cursor++ = '\\';
		*cursor++ = *in;
	}
	*cursor = '\0';
	return out;
}

// echo4 formats up to four JSON-escaped arguments so tests can assert the
// Go wrapper passed each argument in its declared position.
static char *echo4(const char *format, const char *a, const char *b, const char *c, const char *d) {
	char *ea = escape_json(a), *eb = escape_json(b), *ec = escape_json(c), *ed = escape_json(d);
	int size = snprintf(NULL, 0, format, ea, eb, ec, ed);
	char *out = (char *)malloc((size_t)size + 1);
	if (out != NULL) {
		snprintf(out, (size_t)size + 1, format, ea, eb, ec, ed);
	}
	free(ea); free(eb); free(ec); free(ed);
	return out;
}

char *smithers_project_wiki_revision(const char *path, const char *json) {
	char *special = special_response(path);
	if (special != NULL) return special;
	return echo4("{\"commit_sha\":\"%s|%s\"}", path, json, NULL, NULL);
}

char *smithers_wiki_document(const char *request_json) {
	char *special = special_response(request_json);
	if (special != NULL) return special;
	return echo4("{\"state\":\"%s\",\"state_vector\":\"sv\",\"markdown\":\"md\"}", request_json, NULL, NULL, NULL);
}

char *smithers_backout_change_range(const char *store_path, const char *change_id, const char *revision, const char *target_bookmark, const char *base) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return echo4("{\"change_id\":\"%s\",\"commit_id\":\"%s\",\"description\":\"%s|%s\"}", change_id, revision, target_bookmark, base);
}

char *smithers_split_change(const char *store_path, const char *change_id, const char *paths_json, const char *description) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return echo4("{\"original\":{\"change_id\":\"%s\",\"description\":\"%s\"},\"split\":{\"change_id\":\"%s\",\"description\":\"%s\"}}", change_id, paths_json, store_path, description);
}

char *smithers_get_revision_diff(const char *store_path, const char *from_commit_id, const char *to_commit_id, const char *path) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return echo4("{\"change_id\":\"%s..%s\",\"file_diffs\":[{\"path\":\"%s\",\"old_path\":\"%s\",\"change_type\":\"modified\"}]}", from_commit_id, to_commit_id, path, store_path);
}

char *smithers_list_directory(const char *store_path, const char *change_id, const char *prefix, const char *after, unsigned int limit) {
	char *special = special_response(store_path);
	char limit_text[16];
	if (special != NULL) return special;
	snprintf(limit_text, sizeof limit_text, "%u", limit);
	return echo4("[{\"path\":\"%s|%s|%s\",\"kind\":\"%s\"}]", change_id, prefix, after, limit_text);
}

char *smithers_land_changes(const char *store_path, const char *request_json) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return echo4("{\"landed_count\":2,\"target_bookmark\":\"%s\",\"target_commit_id\":\"changes:%s\"}", request_json, store_path, NULL, NULL);
}

#ifndef OMIT_LAND_APPEND
char *smithers_land_append(const char *store_path, const char *request_json) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return echo4("{\"landed_count\":1,\"target_bookmark\":\"%s\",\"target_commit_id\":\"append:%s\"}", request_json, store_path, NULL, NULL);
}
#endif

char *smithers_read_workspace_source(const char *path, const char *request) {
	char *special = special_response(path);
	if (special != NULL) return special;
	return echo4("{\"status\":\"%s\",\"workspace_id\":\"%s\",\"ref\":\"ref\"}", path, request, NULL, NULL);
}

char *smithers_prepare_land_append(const char *path, const char *request) {
	char *special = special_response(path);
	if (special != NULL) return special;
	return echo4("{\"status\":\"%s\",\"target_bookmark\":\"%s\"}", path, request, NULL, NULL);
}

char *smithers_compose_superproject(const char *store_path, const char *request_json) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return echo4("{\"change_id\":\"%s\",\"description\":\"%s\"}", store_path, request_json, NULL, NULL);
}

char *smithers_read_superproject(const char *store_path, const char *revision) {
	char *special = special_response(store_path);
	if (special != NULL) return special;
	return echo4("{\"change_id\":\"%s\",\"commit_id\":\"%s\"}", store_path, revision, NULL, NULL);
}

void smithers_free_string(char *ptr) {
	free(ptr);
}
`
