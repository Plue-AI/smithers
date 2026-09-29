package repohostserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// The FFI mock isolates the HTTP path decoding contract: the real client and
// router run together, while each case checks the exact path handed to storage.
func TestGetFileAtChangeClientPathDecoding(t *testing.T) {
	tests := []struct {
		name string
		path string
	}{
		{"plain", "README.md"},
		{"nested", "docs/guide.txt"},
		{"comma_and_semicolon", "notes/draft,final;v2.txt"},
		{"plus_and_space", "notes/a+b c.txt"},
		{"literal_percent_escape", "notes/draft%2Cfinal.txt"},
		{"mixed_directory", "docs,old/v2;draft/a+b %2C.txt"},
		{"percent_literal", "notes/100% complete.txt"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			const changeID = "change-1"
			const content = "the requested file\n"
			called := make(chan string, 1)
			mock := &mockFFI{getFileContentFn: func(_ string, gotChangeID, path string) (repohost.FileContent, error) {
				if gotChangeID != changeID {
					called <- "change ID: " + gotChangeID
				} else {
					called <- path
				}
				return repohost.FileContent{Path: path, Content: content}, nil
			}}
			server := httptest.NewServer(newTestServerWithMock(t, mock).Handler())
			defer server.Close()

			client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, testAuthToken)
			file, err := client.GetFileAtChange(context.Background(), "alice", "demo", changeID, tt.path)
			if err != nil {
				t.Fatalf("GetFileAtChange(%q): %v", tt.path, err)
			}
			select {
			case gotPath := <-called:
				if gotPath != tt.path {
					t.Fatalf("storage path = %q, want %q", gotPath, tt.path)
				}
			default:
				t.Fatal("storage was not called")
			}
			if file.Path != tt.path || file.Content != content {
				t.Fatalf("client file = %#v, want path %q and content %q", file, tt.path, content)
			}
		})
	}
}

func TestGetFileAtChangeDirectEncodedPaths(t *testing.T) {
	const content = "the requested file\n"

	for _, tt := range []struct {
		name     string
		target   string
		wantPath string
		rawPath  bool
	}{
		{"literal_percent_raw_path_present", "/repos/alice%3Ademo/file/change-1/docs/summary%252Cnotes.txt", "docs/summary%2Cnotes.txt", true},
		{"literal_percent_raw_path_empty", "/repos/alice:demo/file/change-1/docs/summary%252Cnotes.txt", "docs/summary%2Cnotes.txt", false},
		{"encoded_slash", "/repos/alice:demo/file/change-1/docs%2Fguide.txt", "docs/guide.txt", true},
		{"redundant_leading_encoded_slash", "/repos/alice:demo/file/change-1/%2Fdocs/guide.txt", "docs/guide.txt", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			called := make(chan string, 1)
			mock := &mockFFI{getFileContentFn: func(_ string, _ string, path string) (repohost.FileContent, error) {
				called <- path
				return repohost.FileContent{Path: path, Content: content}, nil
			}}
			handler := newTestServerWithMock(t, mock).Handler()
			req := httptest.NewRequest(http.MethodGet, tt.target, nil)
			if (req.URL.RawPath != "") != tt.rawPath {
				t.Fatalf("test setup: RawPath = %q", req.URL.RawPath)
			}
			req.Header.Set("Authorization", validAuth())
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
			}
			select {
			case gotPath := <-called:
				if gotPath != tt.wantPath {
					t.Fatalf("storage path = %q, want %q", gotPath, tt.wantPath)
				}
			default:
				t.Fatal("storage was not called")
			}
			var file repohost.FileContent
			if err := json.Unmarshal(w.Body.Bytes(), &file); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if file.Path != tt.wantPath || file.Content != content {
				t.Fatalf("response file = %#v, want path %q and content %q", file, tt.wantPath, content)
			}
		})
	}
}

func TestGetFileAtChangeRejectsMalformedRawPath(t *testing.T) {
	// net/url rejects malformed escapes on the wire. This synthetic request
	// exercises the handler's defensive error branch directly.
	called := false
	mock := &mockFFI{getFileContentFn: func(_, _, path string) (repohost.FileContent, error) {
		called = true
		return repohost.FileContent{Path: path}, nil
	}}
	handler := newTestServerWithMock(t, mock).Handler()
	req := httptest.NewRequest(http.MethodGet, "/repos/alice:demo/file/change-1/notes/bad.txt", nil)
	req.URL.RawPath = "/repos/alice:demo/file/change-1/notes/bad%zz.txt"
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", w.Code, w.Body.String())
	}
	if called {
		t.Fatal("storage was called for malformed RawPath")
	}
}

func TestGetFileAtChangeRejectsDecodedDotSegment(t *testing.T) {
	called := false
	mock := &mockFFI{getFileContentFn: func(_, _, path string) (repohost.FileContent, error) {
		called = true
		return repohost.FileContent{Path: path}, nil
	}}
	handler := newTestServerWithMock(t, mock).Handler()
	req := httptest.NewRequest(http.MethodGet, "/repos/alice:demo/file/change-1/docs/%2E/guide.txt", nil)
	if req.URL.RawPath == "" {
		t.Fatal("test setup: expected RawPath for encoded dot")
	}
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", w.Code, w.Body.String())
	}
	if called {
		t.Fatal("storage was called for a decoded dot segment")
	}
}

func TestGetFileAtChangeCanceledWhileWaitingForReadLock(t *testing.T) {
	called := false
	mock := &mockFFI{getFileContentFn: func(_, _, path string) (repohost.FileContent, error) {
		called = true
		return repohost.FileContent{Path: path}, nil
	}}
	srv := newTestServerWithMock(t, mock)
	repoPath, err := srv.repoPathFromID("alice:demo")
	if err != nil {
		t.Fatalf("repo path: %v", err)
	}
	unlock, err := srv.locks.Lock(context.Background(), repoPath)
	if err != nil {
		t.Fatalf("write lock: %v", err)
	}
	defer unlock()

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/repos/alice:demo/file/change-1/docs/guide.txt", nil).WithContext(ctx)
	req.Header.Set("Authorization", validAuth())
	cancel()
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want 504; body = %s", w.Code, w.Body.String())
	}
	if called {
		t.Fatal("storage was called after the request was canceled")
	}
}
