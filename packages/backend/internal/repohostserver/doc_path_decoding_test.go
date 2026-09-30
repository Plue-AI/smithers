package repohostserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// docPathRecorder records the document path each storage operation receives.
type docPathRecorder struct {
	commit, content, history, delete []string
}

func (rec *docPathRecorder) ffi() *mockFFI {
	return &mockFFI{
		commitDocFn: func(_, filePath, _, _, _, _ string) (string, error) {
			rec.commit = append(rec.commit, filePath)
			return "doc-sha", nil
		},
		getDocContentFn: func(_, filePath, _ string) (string, string, error) {
			rec.content = append(rec.content, filePath)
			return "# Doc", "doc-sha", nil
		},
		listDocHistoryFn: func(_, filePath string, _ uint32) ([]repohost.WikiRevision, error) {
			rec.history = append(rec.history, filePath)
			return []repohost.WikiRevision{{CommitSHA: "doc-sha"}}, nil
		},
		deleteDocFn: func(_, filePath, _, _ string) error {
			rec.delete = append(rec.delete, filePath)
			return nil
		},
	}
}

func requireDocPaths(t *testing.T, rec *docPathRecorder, want string) {
	t.Helper()
	for name, got := range map[string][]string{
		"commit": rec.commit, "content": rec.content, "history": rec.history, "delete": rec.delete,
	} {
		if len(got) != 1 || got[0] != want {
			t.Fatalf("%s storage paths = %q, want [%q]", name, got, want)
		}
	}
}

// The real repo-host client escapes each path segment; storage must receive
// the original document path for create, read, history and delete alike.
func TestDocRoutesClientPathDecoding(t *testing.T) {
	for _, tt := range []struct{ name, path string }{
		{"plain", "guides/intro.md"},
		{"comma_and_semicolon", "notes/draft,final;v2.md"},
		{"plus_and_space", "notes/a+b c.md"},
		{"literal_percent_escape", "notes/draft%2Cfinal.md"},
		{"percent_literal", "notes/100% complete.md"},
		{"mixed_directory", "docs,old/v2;draft/a+b %2C.md"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := &docPathRecorder{}
			server := httptest.NewServer(newTestServerWithMock(t, rec.ffi()).Handler())
			defer server.Close()
			client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, testAuthToken)
			ctx := context.Background()

			if _, err := client.CommitDoc(ctx, "alice", "demo", tt.path, "# Doc", "Alice", "alice@example.com", "update"); err != nil {
				t.Fatalf("CommitDoc: %v", err)
			}
			if _, err := client.GetDocContent(ctx, "alice", "demo", tt.path, ""); err != nil {
				t.Fatalf("GetDocContent: %v", err)
			}
			if _, err := client.ListDocHistory(ctx, "alice", "demo", tt.path, 5); err != nil {
				t.Fatalf("ListDocHistory: %v", err)
			}
			if err := client.DeleteDoc(ctx, "alice", "demo", tt.path, "Alice", "alice@example.com"); err != nil {
				t.Fatalf("DeleteDoc: %v", err)
			}
			requireDocPaths(t, rec, tt.path)
		})
	}
}

// Requests with and without RawPath are each decoded exactly once, then
// validated, so an encoded dot segment cannot reach storage.
func TestDocRoutesDirectEncodedPaths(t *testing.T) {
	body := `{"content":"# Doc","author_name":"Alice","author_email":"alice@example.com","message":"m"}`
	serve := func(t *testing.T, handler http.Handler, method, target string, rawPath bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		if (req.URL.RawPath != "") != rawPath {
			t.Fatalf("test setup: RawPath = %q for %s", req.URL.RawPath, target)
		}
		req.Header.Set("Authorization", validAuth())
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	for _, tt := range []struct {
		name, suffix, want string
		rawPath            bool
	}{
		{"literal_percent_raw_path_present", "docs/summary%252Cnotes.md", "docs/summary%2Cnotes.md", true},
		{"literal_percent_raw_path_empty", "docs/summary%252Cnotes.md", "docs/summary%2Cnotes.md", false},
		{"encoded_comma", "docs/a%2Cb.md", "docs/a,b.md", true},
		{"encoded_slash", "docs%2Fguide.md", "docs/guide.md", true},
		{"space", "docs/a%20b.md", "docs/a b.md", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			repoID := "alice:demo"
			if tt.rawPath {
				repoID = "alice%3Ademo"
			}
			rec := &docPathRecorder{}
			handler := newTestServerWithMock(t, rec.ffi()).Handler()
			for _, call := range []struct {
				method, prefix string
				status         int
			}{
				{http.MethodPut, "/docs/files/", http.StatusOK},
				{http.MethodGet, "/docs/files/", http.StatusOK},
				{http.MethodGet, "/docs/history/", http.StatusOK},
				{http.MethodDelete, "/docs/files/", http.StatusNoContent},
			} {
				w := serve(t, handler, call.method, "/repos/"+repoID+call.prefix+tt.suffix, tt.rawPath)
				if w.Code != call.status {
					t.Fatalf("%s %s status = %d, body = %s", call.method, call.prefix, w.Code, w.Body.String())
				}
			}
			requireDocPaths(t, rec, tt.want)
		})
	}

	t.Run("decoded_dot_segment_rejected", func(t *testing.T) {
		rec := &docPathRecorder{}
		handler := newTestServerWithMock(t, rec.ffi()).Handler()
		for _, method := range []string{http.MethodPut, http.MethodGet, http.MethodDelete} {
			w := serve(t, handler, method, "/repos/alice:demo/docs/files/docs/%2E%2E/secret.md", true)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("%s status = %d, want 400; body = %s", method, w.Code, w.Body.String())
			}
		}
		if w := serve(t, handler, http.MethodGet, "/repos/alice:demo/docs/history/docs/%2E%2E/secret.md", true); w.Code != http.StatusBadRequest {
			t.Fatalf("history status = %d, want 400", w.Code)
		}
		if len(rec.commit)+len(rec.content)+len(rec.history)+len(rec.delete) != 0 {
			t.Fatalf("storage was called for a decoded dot segment: %+v", rec)
		}
	})

	t.Run("malformed_raw_path_rejected", func(t *testing.T) {
		rec := &docPathRecorder{}
		handler := newTestServerWithMock(t, rec.ffi()).Handler()
		req := httptest.NewRequest(http.MethodGet, "/repos/alice:demo/docs/files/notes/bad.md", nil)
		req.URL.RawPath = "/repos/alice:demo/docs/files/notes/bad%zz.md"
		req.Header.Set("Authorization", validAuth())
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest || len(rec.content) != 0 {
			t.Fatalf("status = %d, storage calls = %q", w.Code, rec.content)
		}
	})
}
