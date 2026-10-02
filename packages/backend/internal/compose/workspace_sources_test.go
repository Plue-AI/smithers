package compose

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

var sourceGlobFixture = workspaceapi.WorkspaceSource{Repository: "acme/demo", Revision: strings.Repeat("a", 40)}

func sourceHTTPFixture(t *testing.T, handler http.HandlerFunc) repositorySourceFiles {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Errorf("unexpected repository request authority: %s %q", r.Method, r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return repositorySourceFiles{client: repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "fixture-token")}
}

func sourceWriteJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Error(err)
	}
}

func sourceTreeEndpoint() string {
	return "/repos/acme:demo/changes/" + sourceGlobFixture.Revision + "/tree"
}
func sourceFileEndpoint(file string) string {
	return "/repos/acme:demo/file/" + sourceGlobFixture.Revision + "/" + file
}

// A real HTTP client exercises routing, revision pinning and content decoding;
// the server is a unit fixture for repository-host responses, not integration
// evidence for the repository-host process or its Git storage.
func TestRepositorySourceGlobReadsOnlyRootMatchesAtPinnedRevision(t *testing.T) {
	var files []string
	reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case sourceTreeEndpoint():
			if r.URL.Query().Get("prefix") != "" || r.URL.Query().Get("after") != "" || r.URL.Query().Get("limit") != "512" || r.URL.Query().Get("depth") != "1" {
				t.Errorf("wrong listing query: %s", r.URL.RawQuery)
			}
			sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: ".npmrc", Kind: "file"}, {Path: "requirements-dev.txt", Kind: "file"}, {Path: "requirements-prod.txt", Kind: "file"}, {Path: "requirements.txt", Kind: "dir"}, {Path: "src", Kind: "dir"}})
		case sourceFileEndpoint("requirements-dev.txt"):
			files = append(files, "requirements-dev.txt")
			sourceWriteJSON(t, w, repohost.FileContent{Path: "requirements-dev.txt", Encoding: "base64", Content: base64.StdEncoding.EncodeToString([]byte("pytest==8.3.5\n"))})
		case sourceFileEndpoint("requirements-prod.txt"):
			files = append(files, "requirements-prod.txt")
			sourceWriteJSON(t, w, repohost.FileContent{Path: "requirements-prod.txt", Encoding: "utf8", Content: "requests==2.32.3\n"})
		default:
			t.Errorf("glob reads unrelated content or revision: %s", r.URL.String())
			w.WriteHeader(http.StatusInternalServerError)
		}
	})
	data, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "requirements*.txt")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"requirements-dev.txt": "pytest==8.3.5\n", "requirements-prod.txt": "requests==2.32.3\n"}
	if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(files, []string{"requirements-dev.txt", "requirements-prod.txt"}) {
		t.Fatalf("glob output/reads = %#v/%#v; want %#v", got, files, want)
	}
}

func TestRepositorySourceGlobMatchesNestedMemberSegments(t *testing.T) {
	var prefixes, files []string
	reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == sourceTreeEndpoint() {
			prefix := r.URL.Query().Get("prefix")
			prefixes = append(prefixes, prefix)
			switch prefix {
			case "":
				sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: "apps", Kind: "dir"}, {Path: "packages", Kind: "dir"}})
			case "packages":
				sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: "packages/a", Kind: "dir"}, {Path: "packages/b", Kind: "dir"}, {Path: "packages/file", Kind: "file"}})
			case "packages/a":
				sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: "packages/a/Cargo.toml", Kind: "file"}, {Path: "packages/a/README.md", Kind: "file"}})
			case "packages/b":
				sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: "packages/b/Cargo.toml", Kind: "file"}, {Path: "packages/b/nested", Kind: "dir"}})
			default:
				t.Errorf("unexpected glob prefix %q", prefix)
				w.WriteHeader(http.StatusInternalServerError)
			}
			return
		}
		for _, file := range []string{"packages/a/Cargo.toml", "packages/b/Cargo.toml"} {
			if r.URL.Path == sourceFileEndpoint(file) {
				files = append(files, file)
				sourceWriteJSON(t, w, repohost.FileContent{Path: file, Content: "[package]\nname = \"" + file + "\"\n"})
				return
			}
		}
		t.Errorf("nested glob reads unrelated contents: %s", r.URL.String())
		w.WriteHeader(http.StatusInternalServerError)
	})
	data, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "packages/*/Cargo.toml")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["packages/a/Cargo.toml"] == "" || got["packages/b/Cargo.toml"] == "" {
		t.Fatalf("nested matches = %#v", got)
	}
	if !reflect.DeepEqual(prefixes, []string{"", "packages", "packages/a", "packages/b"}) || !reflect.DeepEqual(files, []string{"packages/a/Cargo.toml", "packages/b/Cargo.toml"}) {
		t.Fatalf("nested traversal = prefixes %#v files %#v", prefixes, files)
	}
}

// Spec oracle (§8.6.2): requirements*.txt supplies the matched repository files
// as contents. A matching literal filename must be read once as that file,
// including when the filename itself contains glob metacharacters.
func TestRepositorySourceGlobReadsMatchedMetacharactersAsLiteralPaths(t *testing.T) {
	for _, filename := range []string{"requirements*.txt", "requirements?.txt", "requirements[dev].txt", "requirements[.txt"} {
		t.Run(filename, func(t *testing.T) {
			listings, reads := 0, 0
			reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case sourceTreeEndpoint():
					listings++
					if listings > 1 {
						// Bound the old recursive path without a timeout or runaway calls.
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: filename, Kind: "file"}})
				case sourceFileEndpoint(filename):
					reads++
					sourceWriteJSON(t, w, repohost.FileContent{Path: filename, Encoding: "base64", Content: base64.StdEncoding.EncodeToString([]byte("pytest==8.3.5\n"))})
				default:
					t.Errorf("unexpected source request %s", r.URL.String())
					w.WriteHeader(http.StatusBadRequest)
				}
			})
			data, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "requirements*.txt")
			if err != nil {
				t.Fatalf("matched literal filename failed: %v (listings %d, reads %d)", err, listings, reads)
			}
			var got map[string]string
			if err := json.Unmarshal(data, &got); err != nil {
				t.Fatal(err)
			}
			if listings != 1 || reads != 1 || !reflect.DeepEqual(got, map[string]string{filename: "pytest==8.3.5\n"}) {
				t.Fatalf("literal glob result = %#v, listings %d, reads %d", got, listings, reads)
			}
		})
	}
}

func TestRepositorySourceGlobPaginatesAfterLastSortedPath(t *testing.T) {
	var cursors, files []string
	reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == sourceTreeEndpoint() {
			cursor := r.URL.Query().Get("after")
			cursors = append(cursors, cursor)
			if cursor == "" {
				entries := make([]repohost.TreeEntry, 510)
				for i := range entries {
					entries[i] = repohost.TreeEntry{Path: fmt.Sprintf("other-%03d", i), Kind: "file"}
				}
				entries = append(entries, repohost.TreeEntry{Path: "requirements010.txt", Kind: "file"}, repohost.TreeEntry{Path: "requirements020.txt", Kind: "file"})
				sourceWriteJSON(t, w, entries)
				return
			}
			if cursor == "requirements020.txt" {
				sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: "requirements030.txt", Kind: "file"}})
				return
			}
			t.Errorf("pagination uses wrong cursor %q", cursor)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		for _, file := range []string{"requirements010.txt", "requirements020.txt", "requirements030.txt"} {
			if r.URL.Path == sourceFileEndpoint(file) {
				files = append(files, file)
				sourceWriteJSON(t, w, repohost.FileContent{Path: file, Content: "fixture"})
				return
			}
		}
		t.Errorf("pagination reads unrelated content: %s", r.URL.String())
		w.WriteHeader(http.StatusInternalServerError)
	})
	data, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "requirements*.txt")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || !reflect.DeepEqual(cursors, []string{"", "requirements020.txt"}) || len(files) != 3 {
		t.Fatalf("pagination = matches %#v cursors %#v reads %#v", got, cursors, files)
	}
}

func TestRepositorySourceGlobAbsenceAndReadFailures(t *testing.T) {
	for _, fixture := range []struct {
		name                   string
		treeStatus, fileStatus int
		file                   repohost.FileContent
		noMatches, notExist    bool
	}{
		{name: "empty listing", treeStatus: 200, noMatches: true, notExist: true},
		{name: "missing directory", treeStatus: 404, notExist: true},
		{name: "listing unavailable", treeStatus: 502},
		{name: "matching content unavailable", treeStatus: 200, fileStatus: 502},
		{name: "matching content absent", treeStatus: 200, fileStatus: 404, notExist: true},
		{name: "matching content too large", treeStatus: 200, fileStatus: 200, file: repohost.FileContent{TooLarge: true}},
		{name: "matching content invalid base64", treeStatus: 200, fileStatus: 200, file: repohost.FileContent{Encoding: "base64", Content: "@@@"}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == sourceTreeEndpoint() {
					if fixture.treeStatus != 200 {
						w.WriteHeader(fixture.treeStatus)
						return
					}
					if fixture.noMatches {
						sourceWriteJSON(t, w, []repohost.TreeEntry{})
						return
					}
					sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: "requirements.txt", Kind: "file"}})
					return
				}
				if r.URL.Path == sourceFileEndpoint("requirements.txt") {
					if fixture.fileStatus != 200 {
						w.WriteHeader(fixture.fileStatus)
						return
					}
					sourceWriteJSON(t, w, fixture.file)
					return
				}
				t.Errorf("unexpected request %s", r.URL.String())
				w.WriteHeader(http.StatusBadRequest)
			})
			_, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "requirements*.txt")
			if err == nil {
				t.Fatal("glob hides missing/unreadable matching dependency")
			}
			if errors.Is(err, fs.ErrNotExist) != fixture.notExist {
				t.Fatalf("absence classification = %v; want notExist=%v", err, fixture.notExist)
			}
		})
	}
}

func TestRepositorySourceGlobRejectsMalformedPatternsBeforeNetwork(t *testing.T) {
	for _, pattern := range []string{"../requirements*.txt", "/requirements*.txt", "packages/../requirements*.txt", "packages//*/Cargo.toml", "requirements[.txt", "requirements\\*.txt", "requirements\x00*.txt"} {
		t.Run(pattern, func(t *testing.T) {
			reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("malformed pattern reaches network: %s", r.URL.String())
				w.WriteHeader(http.StatusBadRequest)
			})
			if _, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, pattern); err == nil {
				t.Fatal("malformed source glob accepted")
			}
		})
	}
}

func TestRepositorySourceGlobRejectsMalformedDirectoryEntries(t *testing.T) {
	for _, entries := range [][]repohost.TreeEntry{
		{{Path: "../requirements.txt", Kind: "file"}}, {{Path: "sub/requirements.txt", Kind: "file"}}, {{Path: "/requirements.txt", Kind: "file"}},
		{{Path: "requirements\\evil.txt", Kind: "file"}}, {{Path: "requirements\x00evil.txt", Kind: "file"}},
		{{Path: "requirements-z.txt", Kind: "file"}, {Path: "requirements-a.txt", Kind: "file"}},
		{{Path: "requirements.txt", Kind: "file"}, {Path: "requirements.txt", Kind: "file"}},
	} {
		t.Run(fmt.Sprint(entries), func(t *testing.T) {
			reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == sourceTreeEndpoint() {
					sourceWriteJSON(t, w, entries)
					return
				}
				sourceWriteJSON(t, w, repohost.FileContent{Content: "fixture"})
			})
			if _, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "requirements*.txt"); err == nil {
				t.Fatal("malformed directory metadata accepted")
			}
		})
	}
}

func TestRepositorySourceGlobRejectsReplayedPaginationCursor(t *testing.T) {
	var cursors []string
	reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != sourceTreeEndpoint() {
			t.Errorf("nonmatching pagination reads contents: %s", r.URL.String())
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		cursor := r.URL.Query().Get("after")
		cursors = append(cursors, cursor)
		if cursor == "" {
			entries := make([]repohost.TreeEntry, 512)
			for i := range entries {
				entries[i] = repohost.TreeEntry{Path: fmt.Sprintf("other-%03d", i), Kind: "file"}
			}
			sourceWriteJSON(t, w, entries)
			return
		}
		sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: cursor, Kind: "file"}})
	})
	if _, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "requirements*.txt"); err == nil || errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("replayed cursor is not an honest listing failure: %v", err)
	}
	if !reflect.DeepEqual(cursors, []string{"", "other-511"}) {
		t.Fatalf("pagination repeats despite invalid cursor: %#v", cursors)
	}
}

func TestRepositorySourceGlobMalformedResponseAndCancelledRead(t *testing.T) {
	reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("{")) })
	if _, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "requirements*.txt"); err == nil {
		t.Fatal("malformed listing accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := reader.ReadSourceFile(ctx, sourceGlobFixture, "requirements*.txt"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled read = %v; want cancellation cause", err)
	}
}

func TestRepositorySourceGlobBoundsMemberDiscoveryBeforeReadingContents(t *testing.T) {
	reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != sourceTreeEndpoint() {
			t.Errorf("oversized discovery reads contents: %s", r.URL.String())
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Query().Get("prefix") == "" {
			sourceWriteJSON(t, w, []repohost.TreeEntry{{Path: "packages", Kind: "dir"}})
			return
		}
		if r.URL.Query().Get("prefix") != "packages" {
			t.Errorf("wrong member discovery prefix %q", r.URL.Query().Get("prefix"))
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		start := 0
		if cursor := r.URL.Query().Get("after"); cursor != "" {
			last, err := strconv.Atoi(strings.TrimPrefix(cursor, "packages/p"))
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			start = last + 1
		}
		var entries []repohost.TreeEntry
		for i := start; i < min(start+512, 4097); i++ {
			entries = append(entries, repohost.TreeEntry{Path: fmt.Sprintf("packages/p%04d", i), Kind: "dir"})
		}
		sourceWriteJSON(t, w, entries)
	})
	_, err := reader.ReadSourceFile(t.Context(), sourceGlobFixture, "packages/*/Cargo.toml")
	if err == nil || !strings.Contains(err.Error(), "too many matches") {
		t.Fatalf("unbounded member discovery accepted: %v", err)
	}
}

func TestRepositorySourceGlobInvalidRepositoryDoesNotReachNetwork(t *testing.T) {
	reader := sourceHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("invalid repository reaches network: %s", r.URL.String())
		w.WriteHeader(http.StatusBadRequest)
	})
	source := sourceGlobFixture
	source.Repository = "acme/demo/nested"
	if _, err := reader.ReadSourceFile(t.Context(), source, "requirements*.txt"); err == nil {
		t.Fatal("invalid repository slug accepted")
	}
}
