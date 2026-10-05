package repohostserver

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

func TestRouter_Cov_NewReportsFFILoadError(t *testing.T) {
	_, err := New(Config{FFILibraryPath: filepath.Join(t.TempDir(), "missing-ffi-library")})
	if err == nil {
		t.Fatal("expected FFI load error")
	}
}

func TestRouter_Cov_InitRepoDefaultsAutoInitAndErrorBranches(t *testing.T) {
	t.Run("auto_init_defaults_bookmark_and_repo_name", func(t *testing.T) {
		var gotBookmark, gotRepoName string
		mock := &mockFFI{
			autoInitRepoFn: func(storePath, bookmarkName, repoName string) (repohostffi.InitRepoResult, error) {
				gotBookmark = bookmarkName
				gotRepoName = repoName
				return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
			},
		}
		srv := newTestServerWithMock(t, mock)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/init", routerCovJSONBody(t, map[string]any{
			"owner":     "alice",
			"repo":      "demo",
			"auto_init": true,
		}))

		routerCovRequireStatus(t, rec, http.StatusCreated)
		if gotBookmark != "main" {
			t.Fatalf("default bookmark = %q, want main", gotBookmark)
		}
		if gotRepoName != "demo" {
			t.Fatalf("default repo name = %q, want demo", gotRepoName)
		}
		var body initRepoResponse
		routerCovDecode(t, rec, &body)
		if body.Owner != "alice" || body.Repo != "demo" || body.Path == "" {
			t.Fatalf("unexpected init response: %+v", body)
		}
	})

	t.Run("invalid_json", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/init", strings.NewReader("{"))
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
		assertGiteaErrorJSON(t, rec.Body.Bytes())
	})

	for name, body := range map[string]string{
		"concatenated_json": `{"owner":"alice","repo":"demo"}{"owner":"mallory","repo":"demo"}`,
		"trailing_garbage":  `{"owner":"alice","repo":"demo"} trailing`,
	} {
		t.Run(name, func(t *testing.T) {
			initCalls := 0
			mock := &mockFFI{
				initRepoFn: func(storePath string) (repohostffi.InitRepoResult, error) {
					initCalls++
					return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
				},
			}
			srv := newTestServerWithMock(t, mock)
			rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/init", strings.NewReader(body))
			routerCovRequireStatus(t, rec, http.StatusBadRequest)
			assertGiteaErrorJSON(t, rec.Body.Bytes())
			if initCalls != 0 {
				t.Fatalf("init ran %d times for a body with trailing data", initCalls)
			}
		})
	}

	t.Run("ffi_error", func(t *testing.T) {
		mock := &mockFFI{
			initRepoFn: func(storePath string) (repohostffi.InitRepoResult, error) {
				return repohostffi.InitRepoResult{}, assertError("init failed")
			},
		}
		srv := newTestServerWithMock(t, mock)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/init", routerCovJSONBody(t, map[string]string{
			"owner": "alice",
			"repo":  "demo",
		}))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
		assertGiteaErrorJSON(t, rec.Body.Bytes())
	})
}

func TestRouter_Cov_RepositoryStorageErrorBranches(t *testing.T) {
	t.Run("delete_invalid_repo_name", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodDelete, "/repos/alice/demo.docs", nil)
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("delete_owner_dir_read_error", func(t *testing.T) {
		mock := &mockFFI{deleteRepoFn: func(storePath string) error { return nil }}
		srv := newTestServerWithMock(t, mock)
		if err := os.WriteFile(filepath.Join(srv.config.StoragePath, "alice"), []byte("not a dir"), 0o644); err != nil {
			t.Fatalf("write owner file: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodDelete, "/repos/alice/demo", nil)
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})

	t.Run("fork_source_not_found", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/fork", routerCovJSONBody(t, forkRepoRequest{
			SrcOwner: "alice", SrcRepo: "missing", DstOwner: "bob", DstRepo: "copy",
		}))
		routerCovRequireStatus(t, rec, http.StatusNotFound)
	})

	t.Run("fork_destination_exists", func(t *testing.T) {
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.RepoPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir src: %v", err)
		}
		if err := os.MkdirAll(srv.config.RepoPath("bob", "copy"), 0o755); err != nil {
			t.Fatalf("mkdir dst: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/fork", routerCovJSONBody(t, forkRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "copy",
		}))
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("fork_destination_parent_create_error", func(t *testing.T) {
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.RepoPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir src: %v", err)
		}
		if err := os.WriteFile(filepath.Join(srv.config.StoragePath, "bob"), []byte("not a dir"), 0o644); err != nil {
			t.Fatalf("write dst owner file: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/fork", routerCovJSONBody(t, forkRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "copy",
		}))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})

	t.Run("fork_copy_error_cleans_partial_destination", func(t *testing.T) {
		original := copyDirRel
		copyDirRel = func(basepath, targpath string) (string, error) {
			rel, err := original(basepath, targpath)
			if err != nil {
				return "", err
			}
			if rel != "." {
				return "", assertError("copy failed")
			}
			return rel, nil
		}
		t.Cleanup(func() { copyDirRel = original })

		srv := newTestServer(t)
		srcPath := srv.config.RepoPath("alice", "demo")
		if err := os.MkdirAll(srcPath, 0o755); err != nil {
			t.Fatalf("mkdir src: %v", err)
		}
		if err := os.WriteFile(filepath.Join(srcPath, "file"), []byte("content"), 0o644); err != nil {
			t.Fatalf("write src file: %v", err)
		}
		dstPath := srv.config.RepoPath("bob", "copy")
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/fork", routerCovJSONBody(t, forkRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "copy",
		}))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
		if _, err := os.Stat(dstPath); !os.IsNotExist(err) {
			t.Fatalf("expected partial destination cleanup, stat err=%v", err)
		}
	})

	t.Run("move_source_not_found", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move", routerCovJSONBody(t, moveRepoRequest{
			SrcOwner: "alice", SrcRepo: "missing", DstOwner: "bob", DstRepo: "renamed",
		}))
		routerCovRequireStatus(t, rec, http.StatusNotFound)
	})

	t.Run("move_destination_exists", func(t *testing.T) {
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.RepoPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir src: %v", err)
		}
		if err := os.MkdirAll(srv.config.RepoPath("bob", "renamed"), 0o755); err != nil {
			t.Fatalf("mkdir dst: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move", routerCovJSONBody(t, moveRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "renamed",
		}))
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("move_destination_parent_create_error", func(t *testing.T) {
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.RepoPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir src: %v", err)
		}
		if err := os.WriteFile(filepath.Join(srv.config.StoragePath, "bob"), []byte("not a dir"), 0o644); err != nil {
			t.Fatalf("write dst owner file: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move", routerCovJSONBody(t, moveRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "renamed",
		}))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})
}

func TestRouter_Cov_CopyFileErrorBranches(t *testing.T) {
	t.Run("missing_source", func(t *testing.T) {
		err := copyFile(filepath.Join(t.TempDir(), "missing"), filepath.Join(t.TempDir(), "dst"), 0o644)
		if err == nil {
			t.Fatal("expected source open error")
		}
	})

	t.Run("missing_destination_parent", func(t *testing.T) {
		src := filepath.Join(t.TempDir(), "src")
		if err := os.WriteFile(src, []byte("content"), 0o644); err != nil {
			t.Fatalf("write src: %v", err)
		}
		err := copyFile(src, filepath.Join(t.TempDir(), "missing", "dst"), 0o644)
		if err == nil {
			t.Fatal("expected destination open error")
		}
	})

	t.Run("symlink_source", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "target")
		if err := os.WriteFile(target, []byte("secret"), 0o644); err != nil {
			t.Fatalf("write target: %v", err)
		}
		link := filepath.Join(root, "link")
		if err := os.Symlink(target, link); err != nil {
			t.Fatalf("create symlink: %v", err)
		}
		dst := filepath.Join(root, "dst")
		err := copyFile(link, dst, 0o644)
		if err == nil {
			t.Fatal("expected symlink copy error")
		}
		if _, statErr := os.Lstat(dst); !os.IsNotExist(statErr) {
			t.Fatalf("expected no destination file, lstat err=%v", statErr)
		}
	})

	t.Run("missing_copy_dir_source", func(t *testing.T) {
		err := copyDir(filepath.Join(t.TempDir(), "missing"), filepath.Join(t.TempDir(), "dst"))
		if err == nil {
			t.Fatal("expected walk source error")
		}
	})

	t.Run("source_directory_copy_error", func(t *testing.T) {
		root := t.TempDir()
		srcDir := filepath.Join(root, "srcdir")
		if err := os.Mkdir(srcDir, 0o755); err != nil {
			t.Fatalf("mkdir source dir: %v", err)
		}
		err := copyFile(srcDir, filepath.Join(root, "out"), 0o644)
		if err == nil {
			t.Fatal("expected io.Copy read error")
		}
	})
}

func TestRouter_Cov_ForkMoveValidationAndRenameErrors(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		body   io.Reader
		status int
	}{
		{name: "fork_invalid_json", path: "/repos/fork", body: strings.NewReader("{"), status: http.StatusBadRequest},
		{name: "fork_invalid_source", path: "/repos/fork", body: routerCovJSONBody(t, forkRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo.wiki", DstOwner: "bob", DstRepo: "copy",
		}), status: http.StatusBadRequest},
		{name: "fork_invalid_destination", path: "/repos/fork", body: routerCovJSONBody(t, forkRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "copy.docs",
		}), status: http.StatusBadRequest},
		{name: "move_invalid_json", path: "/repos/move", body: strings.NewReader("{"), status: http.StatusBadRequest},
		{name: "move_invalid_source", path: "/repos/move", body: routerCovJSONBody(t, moveRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo.docs", DstOwner: "bob", DstRepo: "renamed",
		}), status: http.StatusBadRequest},
		{name: "move_invalid_destination", path: "/repos/move", body: routerCovJSONBody(t, moveRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "renamed.wiki",
		}), status: http.StatusBadRequest},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServer(t)
			rec := routerCovServe(t, srv.Handler(), http.MethodPost, tt.path, tt.body)
			routerCovRequireStatus(t, rec, tt.status)
		})
	}

	t.Run("move_rename_error", func(t *testing.T) {
		srv := newTestServer(t)
		srcPath := srv.config.RepoPath("alice", "demo")
		if err := os.MkdirAll(srcPath, 0o755); err != nil {
			t.Fatalf("mkdir src: %v", err)
		}
		dstOwnerDir := filepath.Join(srv.config.StoragePath, "bob")
		if err := os.MkdirAll(dstOwnerDir, 0o755); err != nil {
			t.Fatalf("mkdir dst owner: %v", err)
		}
		if err := os.Chmod(dstOwnerDir, 0o555); err != nil {
			t.Fatalf("chmod dst owner: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(dstOwnerDir, 0o755) })

		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move", routerCovJSONBody(t, moveRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "renamed",
		}))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})

	t.Run("fork_source_stat_permission_error", func(t *testing.T) {
		srv := newTestServer(t)
		ownerDir := filepath.Join(srv.config.StoragePath, "alice")
		if err := os.MkdirAll(ownerDir, 0o755); err != nil {
			t.Fatalf("mkdir owner: %v", err)
		}
		if err := os.Chmod(ownerDir, 0); err != nil {
			t.Fatalf("chmod owner: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(ownerDir, 0o755) })
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/fork", routerCovJSONBody(t, forkRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "copy",
		}))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})

	t.Run("move_source_stat_permission_error", func(t *testing.T) {
		srv := newTestServer(t)
		ownerDir := filepath.Join(srv.config.StoragePath, "alice")
		if err := os.MkdirAll(ownerDir, 0o755); err != nil {
			t.Fatalf("mkdir owner: %v", err)
		}
		if err := os.Chmod(ownerDir, 0); err != nil {
			t.Fatalf("chmod owner: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(ownerDir, 0o755) })
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move", routerCovJSONBody(t, moveRepoRequest{
			SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "renamed",
		}))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})
}

func TestRouter_Cov_ImportRefsSuccessAndErrors(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		var gotStorePath string
		mock := &mockFFI{importGitRefsFn: func(storePath string) error {
			gotStorePath = storePath
			return nil
		}}
		srv := newTestServerWithMock(t, mock)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/import-refs", nil)
		routerCovRequireStatus(t, rec, http.StatusOK)
		if gotStorePath != srv.config.RepoPath("alice", "demo") {
			t.Fatalf("store path = %q", gotStorePath)
		}
		var body map[string]string
		routerCovDecode(t, rec, &body)
		if body["status"] != "ok" {
			t.Fatalf("unexpected body: %#v", body)
		}
	})

	t.Run("invalid_repo", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo.wiki/git/import-refs", nil)
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("ffi_error", func(t *testing.T) {
		mock := &mockFFI{importGitRefsFn: func(storePath string) error { return assertError("import failed") }}
		srv := newTestServerWithMock(t, mock)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/import-refs", nil)
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})
}

func TestRouter_Cov_InfoRefsAdditionalBranches(t *testing.T) {
	t.Run("unsupported_service", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice/demo/git/info-refs?service=git-unknown", nil)
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("missing_git_dir", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice/demo/git/info-refs?service=git-upload-pack", nil)
		routerCovRequireStatus(t, rec, http.StatusNotFound)
	})

	t.Run("export_error", func(t *testing.T) {
		mock := &mockFFI{exportGitRefsFn: func(storePath string) error { return notFound("repo missing from ffi") }}
		srv := newTestServerWithMock(t, mock)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice/demo/git/info-refs?service=git-upload-pack", nil)
		routerCovRequireStatus(t, rec, http.StatusNotFound)
	})

	t.Run("receive_pack_service", func(t *testing.T) {
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"receive-pack\" ]; then printf refs; exit 0; fi\nexit 1\n")
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice/demo/git/info-refs?service=git-receive-pack", nil)
		routerCovRequireStatus(t, rec, http.StatusOK)
		if got := rec.Header().Get("Content-Type"); got != "application/x-git-receive-pack-advertisement" {
			t.Fatalf("Content-Type = %q", got)
		}
		if !strings.Contains(rec.Body.String(), "# service=git-receive-pack") {
			t.Fatalf("missing receive-pack service line in %q", rec.Body.String())
		}
	})

	t.Run("git_advertise_failure", func(t *testing.T) {
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"upload-pack\" ]; then echo no refs >&2; exit 4; fi\nexit 1\n")
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice/demo/git/info-refs?service=git-upload-pack", nil)
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})
}

func TestRouter_Cov_InfoRefsInvalidRepositoryName(t *testing.T) {
	srv := newTestServer(t)
	rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice/demo.docs/git/info-refs?service=git-upload-pack", nil)
	routerCovRequireStatus(t, rec, http.StatusBadRequest)
}

func TestRouter_Cov_ReceivePackAdditionalBranches(t *testing.T) {
	t.Run("invalid_repo", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo.docs/git/receive-pack", strings.NewReader("push"))
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("missing_git_dir", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", strings.NewReader("0000"))
		routerCovRequireStatus(t, rec, http.StatusNotFound)
	})

	t.Run("gzip_request_body", func(t *testing.T) {
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"--git-dir\" ]; then exit 0; fi\nif [ \"$1\" = \"receive-pack\" ]; then body=$(cat); if [ \"$body\" != \"0000\" ]; then echo bad-body:$body >&2; exit 3; fi; printf receive-ok; exit 0; fi\nexit 1\n")
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", routerCovGzipBody(t, "0000"), map[string]string{
			"Content-Encoding": "gzip",
		})
		routerCovRequireStatus(t, rec, http.StatusOK)
		if rec.Body.String() != "receive-ok" {
			t.Fatalf("receive-pack body = %q", rec.Body.String())
		}
	})

	t.Run("malformed_gzip_request_body", func(t *testing.T) {
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"--git-dir\" ]; then exit 0; fi\nexit 1\n")
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", strings.NewReader("not gzip"), map[string]string{
			"Content-Encoding": "gzip",
		})
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})
}

func TestRouter_Cov_ReceivePackSnapshotAndCallbackErrors(t *testing.T) {
	t.Run("git_rpc_failure", func(t *testing.T) {
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"receive-pack\" ]; then cat >/dev/null; echo failed >&2; exit 7; fi\nexit 1\n")
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", strings.NewReader("0000"))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})

	t.Run("before_ref_snapshot_failure_is_fatal", func(t *testing.T) {
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"--git-dir\" ]; then exit 6; fi\nif [ \"$1\" = \"receive-pack\" ]; then cat >/dev/null; printf ok; exit 0; fi\nexit 1\n")
		srv := newTestServer(t)
		srv.config.PushHookCallbackURL = "https://example.test/hook"
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", strings.NewReader("0000"))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})

	t.Run("after_ref_snapshot_failure_is_fatal", func(t *testing.T) {
		t.Setenv("STUB_GIT_STATE_FILE", filepath.Join(t.TempDir(), "state"))
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"--git-dir\" ]; then\n  if [ -f \"$STUB_GIT_STATE_FILE\" ]; then exit 7; fi\n  printf 'refs/heads/main\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'\n  exit 0\nfi\nif [ \"$1\" = \"receive-pack\" ]; then cat >/dev/null; : > \"$STUB_GIT_STATE_FILE\"; printf ok; exit 0; fi\nexit 1\n")
		srv := newTestServer(t)
		srv.config.PushHookCallbackURL = "https://example.test/hook"
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", strings.NewReader("0000"))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
	})

	t.Run("unpersistable_push_event_rolls_back_push", func(t *testing.T) {
		t.Setenv("STUB_GIT_STATE_FILE", filepath.Join(t.TempDir(), "state"))
		updateLog := filepath.Join(t.TempDir(), "update-ref")
		t.Setenv("STUB_GIT_UPDATE_LOG", updateLog)
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"--git-dir\" ] && [ \"$3\" = \"update-ref\" ]; then { echo \"$@\"; tr '\\000' ' '; } >> \"$STUB_GIT_UPDATE_LOG\"; exit 0; fi\nif [ \"$1\" = \"--git-dir\" ]; then\n  if [ -f \"$STUB_GIT_STATE_FILE\" ]; then printf 'refs/heads/main\\000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'; else printf 'refs/heads/main\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; fi\n  exit 0\nfi\nif [ \"$1\" = \"receive-pack\" ]; then cat >/dev/null; : > \"$STUB_GIT_STATE_FILE\"; printf ok; exit 0; fi\nexit 1\n")
		imported := false
		srv := newTestServerWithMock(t, &mockFFI{importGitRefsFn: func(string) error { imported = true; return nil }})
		srv.config.PushHookCallbackURL = "https://example.test/hook"
		// A regular file where the outbox directory belongs makes every
		// persist fail.
		if err := os.WriteFile(filepath.Join(srv.config.StoragePath, pushHookOutboxDirName), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", strings.NewReader("0000"))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
		if imported {
			t.Fatal("jj must not import refs whose push events were not persisted")
		}
		log, err := os.ReadFile(updateLog)
		if err != nil || !strings.Contains(string(log), "refs/heads/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
			t.Fatalf("push was not rolled back to its previous ref: %q (%v)", log, err)
		}
	})

	t.Run("jj_import_failure_discards_persisted_push_events", func(t *testing.T) {
		t.Setenv("STUB_GIT_STATE_FILE", filepath.Join(t.TempDir(), "state"))
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"--git-dir\" ] && [ \"$3\" = \"update-ref\" ]; then exit 0; fi\nif [ \"$1\" = \"--git-dir\" ]; then\n  if [ -f \"$STUB_GIT_STATE_FILE\" ]; then printf 'refs/heads/main\\000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'; else printf 'refs/heads/main\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; fi\n  exit 0\nfi\nif [ \"$1\" = \"receive-pack\" ]; then cat >/dev/null; : > \"$STUB_GIT_STATE_FILE\"; printf ok; exit 0; fi\nexit 1\n")
		srv := newTestServerWithMock(t, &mockFFI{importGitRefsFn: func(string) error { return errors.New("import failed") }})
		srv.config.PushHookCallbackURL = "https://example.test/hook"
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", strings.NewReader("0000"))
		routerCovRequireStatus(t, rec, http.StatusInternalServerError)
		if files := outboxFiles(t, srv.pushOutbox.root()); len(files) != 0 {
			t.Fatalf("a rolled-back push must not leave push events behind: %v", files)
		}
	})

	t.Run("push_hook_callback_failure_keeps_event_for_replay", func(t *testing.T) {
		t.Setenv("STUB_GIT_STATE_FILE", filepath.Join(t.TempDir(), "state"))
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"--git-dir\" ]; then\n  if [ -f \"$STUB_GIT_STATE_FILE\" ]; then printf 'refs/heads/main\\000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'; else printf 'refs/heads/main\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; fi\n  exit 0\nfi\nif [ \"$1\" = \"receive-pack\" ]; then cat >/dev/null; : > \"$STUB_GIT_STATE_FILE\"; printf ok; exit 0; fi\nexit 1\n")
		callbacks := make(chan PushHookPayload, 1)
		callbackSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var payload PushHookPayload
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode callback: %v", err)
			}
			callbacks <- payload
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer callbackSrv.Close()

		srv := newTestServer(t)
		srv.config.PushHookCallbackURL = callbackSrv.URL
		srv.httpClient = callbackSrv.Client()
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/receive-pack", strings.NewReader("0000"))
		routerCovRequireStatus(t, rec, http.StatusOK)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			t.Fatalf("shutdown: %v", err)
		}
		select {
		case payload := <-callbacks:
			if payload.RefName != "refs/heads/main" || payload.CommitSHA != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
				t.Fatalf("unexpected callback payload: %+v", payload)
			}
		default:
			t.Fatal("expected push hook callback")
		}
		files := outboxFiles(t, srv.pushOutbox.root())
		if len(files) != 1 {
			t.Fatalf("a failed callback must leave its event in the outbox: %v", files)
		}
		var entry pushHookOutboxEntry
		content, err := os.ReadFile(files[0])
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(content, &entry); err != nil {
			t.Fatal(err)
		}
		if entry.Attempts != 1 || entry.Payload.CommitSHA != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
			t.Fatalf("unexpected outbox entry: %+v", entry)
		}
	})
}

func TestRouter_Cov_UploadPackAdditionalBranches(t *testing.T) {
	t.Run("invalid_repo", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo.docs/git/upload-pack", strings.NewReader("want"))
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("missing_git_dir", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/upload-pack", strings.NewReader("want"))
		routerCovRequireStatus(t, rec, http.StatusNotFound)
	})

	t.Run("export_error", func(t *testing.T) {
		mock := &mockFFI{exportGitRefsFn: func(storePath string) error { return conflict("export blocked") }}
		srv := newTestServerWithMock(t, mock)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/upload-pack", strings.NewReader("want"))
		routerCovRequireStatus(t, rec, http.StatusConflict)
	})

	t.Run("git_dir_removed_after_export", func(t *testing.T) {
		var gitDir string
		mock := &mockFFI{exportGitRefsFn: func(storePath string) error {
			if err := os.RemoveAll(gitDir); err != nil {
				t.Fatalf("remove git dir: %v", err)
			}
			return nil
		}}
		srv := newTestServerWithMock(t, mock)
		gitDir = srv.config.GitBackendPath("alice", "demo")
		if err := os.MkdirAll(gitDir, 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/upload-pack", strings.NewReader("want"))
		routerCovRequireStatus(t, rec, http.StatusNotFound)
	})

	t.Run("gzip_request_body", func(t *testing.T) {
		installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"upload-pack\" ]; then body=$(cat); if [ \"$body\" != \"want-data\" ]; then echo bad-body:$body >&2; exit 3; fi; printf upload-ok; exit 0; fi\nexit 1\n")
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/upload-pack", routerCovGzipBody(t, "want-data"), map[string]string{
			"Content-Encoding": "gzip",
		})
		routerCovRequireStatus(t, rec, http.StatusOK)
		if rec.Body.String() != "upload-ok" {
			t.Fatalf("upload-pack body = %q", rec.Body.String())
		}
	})

	t.Run("malformed_gzip_request_body", func(t *testing.T) {
		srv := newTestServer(t)
		if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
			t.Fatalf("mkdir git dir: %v", err)
		}
		rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, "/repos/alice/demo/git/upload-pack", strings.NewReader("not gzip"), map[string]string{
			"Content-Encoding": "gzip",
		})
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})
}

func TestRouter_Cov_WikiDocsInvalidRepoIDs(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		body   io.Reader
	}{
		{name: "commit_wiki", method: http.MethodPut, path: "/repos/not-an-id/wiki/pages/Home", body: routerCovJSONBody(t, wikiCommitRequest{})},
		{name: "commit_doc", method: http.MethodPut, path: "/repos/not-an-id/docs/files/readme.md", body: routerCovJSONBody(t, wikiCommitRequest{})},
		{name: "get_wiki", method: http.MethodGet, path: "/repos/not-an-id/wiki/pages/Home"},
		{name: "get_doc", method: http.MethodGet, path: "/repos/not-an-id/docs/files/readme.md"},
		{name: "wiki_history", method: http.MethodGet, path: "/repos/not-an-id/wiki/pages/Home/history"},
		{name: "doc_history", method: http.MethodGet, path: "/repos/not-an-id/docs/history/readme.md"},
		{name: "delete_wiki", method: http.MethodDelete, path: "/repos/not-an-id/wiki/pages/Home", body: routerCovJSONBody(t, wikiDeleteRequest{})},
		{name: "delete_doc", method: http.MethodDelete, path: "/repos/not-an-id/docs/files/readme.md", body: routerCovJSONBody(t, wikiDeleteRequest{})},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServer(t)
			rec := routerCovServe(t, srv.Handler(), tt.method, tt.path, tt.body)
			routerCovRequireStatus(t, rec, http.StatusBadRequest)
		})
	}
}

func TestRouter_Cov_WikiDocsSuccessRoutes(t *testing.T) {
	revisionTime := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	calls := map[string]int{}
	mock := &mockFFI{
		initWikiRepoFn: func(storePath string) (bool, error) {
			calls["initWiki"]++
			return true, nil
		},
		initDocsRepoFn: func(storePath string) (bool, error) {
			calls["initDocs"]++
			return true, nil
		},
		commitWikiPageFn: func(storePath, pageName, content, authorName, authorEmail, message string) (string, error) {
			calls["commitWiki"]++
			if pageName != "Home" || content != "# Home" || authorName != "Alice" || authorEmail != "alice@example.com" || message != "update home" {
				t.Fatalf("unexpected wiki commit args: %q %q %q %q %q", pageName, content, authorName, authorEmail, message)
			}
			return "wiki-sha", nil
		},
		commitDocFn: func(storePath, filePath, content, authorName, authorEmail, message string) (string, error) {
			calls["commitDoc"]++
			if filePath != "guides/intro.md" || content != "# Intro" {
				t.Fatalf("unexpected doc commit args: %q %q", filePath, content)
			}
			return "doc-sha", nil
		},
		getWikiPageContentFn: func(storePath, pageName, commitSHA string) (string, string, error) {
			calls["getWiki"]++
			if pageName != "Home" || commitSHA != "rev1" {
				t.Fatalf("unexpected wiki get args: %q %q", pageName, commitSHA)
			}
			return "# Home at rev1", "rev1", nil
		},
		getDocContentFn: func(storePath, filePath, commitSHA string) (string, string, error) {
			calls["getDoc"]++
			if filePath != "guides/intro.md" || commitSHA != "rev2" {
				t.Fatalf("unexpected doc get args: %q %q", filePath, commitSHA)
			}
			return "# Intro at rev2", "rev2", nil
		},
		listWikiPageHistoryFn: func(storePath, pageName string, limit uint32) ([]repohost.WikiRevision, error) {
			calls["wikiHistory"]++
			if pageName != "Home" || limit != 2 {
				t.Fatalf("unexpected wiki history args: %q %d", pageName, limit)
			}
			return []repohost.WikiRevision{{CommitSHA: "rev1", Message: "one", Author: "Alice", Email: "alice@example.com", Timestamp: revisionTime}}, nil
		},
		listDocHistoryFn: func(storePath, filePath string, limit uint32) ([]repohost.WikiRevision, error) {
			calls["docHistory"]++
			if filePath != "guides/intro.md" || limit != 3 {
				t.Fatalf("unexpected doc history args: %q %d", filePath, limit)
			}
			return []repohost.WikiRevision{{CommitSHA: "rev2", Message: "two", Author: "Bob", Email: "bob@example.com", Timestamp: revisionTime}}, nil
		},
		deleteWikiPageFn: func(storePath, pageName, authorName, authorEmail string) error {
			calls["deleteWiki"]++
			if pageName != "Home" || authorName != "Alice" || authorEmail != "alice@example.com" {
				t.Fatalf("unexpected wiki delete args: %q %q %q", pageName, authorName, authorEmail)
			}
			return nil
		},
		deleteDocFn: func(storePath, filePath, authorName, authorEmail string) error {
			calls["deleteDoc"]++
			if filePath != "guides/intro.md" || authorName != "Alice" || authorEmail != "alice@example.com" {
				t.Fatalf("unexpected doc delete args: %q %q %q", filePath, authorName, authorEmail)
			}
			return nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	routerCovRequireStatus(t, routerCovServe(t, handler, http.MethodPut, "/repos/alice%3Ademo/wiki", nil), http.StatusCreated)
	routerCovRequireStatus(t, routerCovServe(t, handler, http.MethodPut, "/repos/alice%3Ademo/docs", nil), http.StatusCreated)

	commitReq := wikiCommitRequest{Content: "# Home", AuthorName: "Alice", AuthorEmail: "alice@example.com", Message: "update home"}
	rec := routerCovServe(t, handler, http.MethodPut, "/repos/alice%3Ademo/wiki/pages/Home", routerCovJSONBody(t, commitReq))
	routerCovRequireStatus(t, rec, http.StatusOK)
	var commitResp wikiCommitResponse
	routerCovDecode(t, rec, &commitResp)
	if commitResp.CommitSHA != "wiki-sha" {
		t.Fatalf("wiki commit sha = %q", commitResp.CommitSHA)
	}

	docReq := wikiCommitRequest{Content: "# Intro", AuthorName: "Alice", AuthorEmail: "alice@example.com", Message: "update docs"}
	rec = routerCovServe(t, handler, http.MethodPut, "/repos/alice%3Ademo/docs/files/guides/intro.md", routerCovJSONBody(t, docReq))
	routerCovRequireStatus(t, rec, http.StatusOK)
	routerCovDecode(t, rec, &commitResp)
	if commitResp.CommitSHA != "doc-sha" {
		t.Fatalf("doc commit sha = %q", commitResp.CommitSHA)
	}

	rec = routerCovServe(t, handler, http.MethodGet, "/repos/alice%3Ademo/wiki/pages/Home?commit_sha=%20rev1%20", nil)
	routerCovRequireStatus(t, rec, http.StatusOK)
	var contentResp wikiContentResponse
	routerCovDecode(t, rec, &contentResp)
	if contentResp.Content != "# Home at rev1" || contentResp.CommitSHA != "rev1" {
		t.Fatalf("unexpected wiki content response: %+v", contentResp)
	}

	rec = routerCovServe(t, handler, http.MethodGet, "/repos/alice%3Ademo/docs/files/guides/intro.md?commit_sha=%20rev2%20", nil)
	routerCovRequireStatus(t, rec, http.StatusOK)
	routerCovDecode(t, rec, &contentResp)
	if contentResp.Content != "# Intro at rev2" || contentResp.CommitSHA != "rev2" {
		t.Fatalf("unexpected doc content response: %+v", contentResp)
	}

	rec = routerCovServe(t, handler, http.MethodGet, "/repos/alice%3Ademo/wiki/pages/Home/history?limit=2", nil)
	routerCovRequireStatus(t, rec, http.StatusOK)
	var revisions []repohost.WikiRevision
	routerCovDecode(t, rec, &revisions)
	if len(revisions) != 1 || revisions[0].CommitSHA != "rev1" {
		t.Fatalf("unexpected wiki revisions: %+v", revisions)
	}

	rec = routerCovServe(t, handler, http.MethodGet, "/repos/alice%3Ademo/docs/history/guides/intro.md?limit=3", nil)
	routerCovRequireStatus(t, rec, http.StatusOK)
	routerCovDecode(t, rec, &revisions)
	if len(revisions) != 1 || revisions[0].CommitSHA != "rev2" {
		t.Fatalf("unexpected doc revisions: %+v", revisions)
	}

	deleteReq := wikiDeleteRequest{AuthorName: "Alice", AuthorEmail: "alice@example.com"}
	routerCovRequireStatus(t, routerCovServe(t, handler, http.MethodDelete, "/repos/alice%3Ademo/wiki/pages/Home", routerCovJSONBody(t, deleteReq)), http.StatusNoContent)
	routerCovRequireStatus(t, routerCovServe(t, handler, http.MethodDelete, "/repos/alice%3Ademo/docs/files/guides/intro.md", routerCovJSONBody(t, deleteReq)), http.StatusNoContent)

	for _, name := range []string{"initWiki", "initDocs", "commitWiki", "commitDoc", "getWiki", "getDoc", "wikiHistory", "docHistory", "deleteWiki", "deleteDoc"} {
		if calls[name] != 1 {
			t.Fatalf("call %s = %d, want 1", name, calls[name])
		}
	}
}

func TestRouter_Cov_WikiDocsNoContentAndValidationErrors(t *testing.T) {
	t.Run("init_no_content", func(t *testing.T) {
		mock := &mockFFI{
			initWikiRepoFn: func(storePath string) (bool, error) { return false, nil },
			initDocsRepoFn: func(storePath string) (bool, error) { return false, nil },
		}
		srv := newTestServerWithMock(t, mock)
		handler := srv.Handler()
		routerCovRequireStatus(t, routerCovServe(t, handler, http.MethodPut, "/repos/alice%3Ademo/wiki", nil), http.StatusNoContent)
		routerCovRequireStatus(t, routerCovServe(t, handler, http.MethodPut, "/repos/alice%3Ademo/docs", nil), http.StatusNoContent)
	})

	tests := []struct {
		name   string
		method string
		path   string
		body   io.Reader
	}{
		{name: "init_wiki_invalid_id", method: http.MethodPut, path: "/repos/not-an-id/wiki"},
		{name: "init_docs_invalid_id", method: http.MethodPut, path: "/repos/not-an-id/docs"},
		{name: "commit_wiki_invalid_json", method: http.MethodPut, path: "/repos/alice%3Ademo/wiki/pages/Home", body: strings.NewReader("{")},
		{name: "commit_doc_invalid_json", method: http.MethodPut, path: "/repos/alice%3Ademo/docs/files/readme.md", body: strings.NewReader("{")},
		{name: "commit_doc_empty_path", method: http.MethodPut, path: "/repos/alice%3Ademo/docs/files/", body: routerCovJSONBody(t, wikiCommitRequest{})},
		{name: "get_doc_empty_path", method: http.MethodGet, path: "/repos/alice%3Ademo/docs/files/"},
		{name: "wiki_history_invalid_limit", method: http.MethodGet, path: "/repos/alice%3Ademo/wiki/pages/Home/history?limit=abc"},
		{name: "doc_history_invalid_limit", method: http.MethodGet, path: "/repos/alice%3Ademo/docs/history/guides/intro.md?limit=abc"},
		{name: "doc_history_empty_path", method: http.MethodGet, path: "/repos/alice%3Ademo/docs/history/"},
		{name: "delete_wiki_invalid_json", method: http.MethodDelete, path: "/repos/alice%3Ademo/wiki/pages/Home", body: strings.NewReader("{")},
		{name: "delete_doc_invalid_json", method: http.MethodDelete, path: "/repos/alice%3Ademo/docs/files/readme.md", body: strings.NewReader("{")},
		{name: "delete_doc_empty_path", method: http.MethodDelete, path: "/repos/alice%3Ademo/docs/files/", body: routerCovJSONBody(t, wikiDeleteRequest{})},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServer(t)
			rec := routerCovServe(t, srv.Handler(), tt.method, tt.path, tt.body)
			routerCovRequireStatus(t, rec, http.StatusBadRequest)
			assertGiteaErrorJSON(t, rec.Body.Bytes())
		})
	}
}

func TestRouter_Cov_WikiDocsFFIErrors(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		body   io.Reader
		mock   *mockFFI
		want   int
	}{
		{
			name: "init_wiki", method: http.MethodPut, path: "/repos/alice%3Ademo/wiki", want: http.StatusInternalServerError,
			mock: &mockFFI{initWikiRepoFn: func(storePath string) (bool, error) { return false, assertError("init wiki failed") }},
		},
		{
			name: "init_docs", method: http.MethodPut, path: "/repos/alice%3Ademo/docs", want: http.StatusInternalServerError,
			mock: &mockFFI{initDocsRepoFn: func(storePath string) (bool, error) { return false, assertError("init docs failed") }},
		},
		{
			name: "commit_wiki", method: http.MethodPut, path: "/repos/alice%3Ademo/wiki/pages/Home", body: routerCovJSONBody(t, wikiCommitRequest{}), want: http.StatusInternalServerError,
			mock: &mockFFI{commitWikiPageFn: func(storePath, pageName, content, authorName, authorEmail, message string) (string, error) {
				return "", assertError("commit wiki failed")
			}},
		},
		{
			name: "commit_doc", method: http.MethodPut, path: "/repos/alice%3Ademo/docs/files/readme.md", body: routerCovJSONBody(t, wikiCommitRequest{}), want: http.StatusInternalServerError,
			mock: &mockFFI{commitDocFn: func(storePath, filePath, content, authorName, authorEmail, message string) (string, error) {
				return "", assertError("commit doc failed")
			}},
		},
		{
			name: "get_wiki", method: http.MethodGet, path: "/repos/alice%3Ademo/wiki/pages/Home", want: http.StatusNotFound,
			mock: &mockFFI{getWikiPageContentFn: func(storePath, pageName, commitSHA string) (string, string, error) {
				return "", "", notFound("wiki page not found")
			}},
		},
		{
			name: "get_doc", method: http.MethodGet, path: "/repos/alice%3Ademo/docs/files/readme.md", want: http.StatusNotFound,
			mock: &mockFFI{getDocContentFn: func(storePath, filePath, commitSHA string) (string, string, error) {
				return "", "", notFound("doc not found")
			}},
		},
		{
			name: "list_wiki_history", method: http.MethodGet, path: "/repos/alice%3Ademo/wiki/pages/Home/history", want: http.StatusInternalServerError,
			mock: &mockFFI{listWikiPageHistoryFn: func(storePath, pageName string, limit uint32) ([]repohost.WikiRevision, error) {
				return nil, assertError("wiki history failed")
			}},
		},
		{
			name: "list_doc_history", method: http.MethodGet, path: "/repos/alice%3Ademo/docs/history/readme.md", want: http.StatusInternalServerError,
			mock: &mockFFI{listDocHistoryFn: func(storePath, filePath string, limit uint32) ([]repohost.WikiRevision, error) {
				return nil, assertError("doc history failed")
			}},
		},
		{
			name: "delete_wiki", method: http.MethodDelete, path: "/repos/alice%3Ademo/wiki/pages/Home", body: routerCovJSONBody(t, wikiDeleteRequest{}), want: http.StatusInternalServerError,
			mock: &mockFFI{deleteWikiPageFn: func(storePath, pageName, authorName, authorEmail string) error {
				return assertError("delete wiki failed")
			}},
		},
		{
			name: "delete_doc", method: http.MethodDelete, path: "/repos/alice%3Ademo/docs/files/readme.md", body: routerCovJSONBody(t, wikiDeleteRequest{}), want: http.StatusInternalServerError,
			mock: &mockFFI{deleteDocFn: func(storePath, filePath, authorName, authorEmail string) error {
				return assertError("delete doc failed")
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServerWithMock(t, tt.mock)
			rec := routerCovServe(t, srv.Handler(), tt.method, tt.path, tt.body)
			routerCovRequireStatus(t, rec, tt.want)
			assertGiteaErrorJSON(t, rec.Body.Bytes())
		})
	}
}

func TestRouter_Cov_ChangeEndpointInvalidRepoIDs(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		body   io.Reader
	}{
		{name: "list_bookmarks", method: http.MethodGet, path: "/repos/not-an-id/bookmarks"},
		{name: "create_bookmark", method: http.MethodPost, path: "/repos/not-an-id/bookmarks", body: routerCovJSONBody(t, repohost.CreateBookmarkRequest{})},
		{name: "delete_bookmark", method: http.MethodDelete, path: "/repos/not-an-id/bookmarks/main"},
		{name: "list_changes", method: http.MethodGet, path: "/repos/not-an-id/changes"},
		{name: "get_change", method: http.MethodGet, path: "/repos/not-an-id/changes/c1"},
		{name: "get_diff", method: http.MethodGet, path: "/repos/not-an-id/changes/c1/diff"},
		{name: "get_files", method: http.MethodGet, path: "/repos/not-an-id/changes/c1/files"},
		{name: "list_tree", method: http.MethodGet, path: "/repos/not-an-id/changes/c1/tree"},
		{name: "conflicts", method: http.MethodGet, path: "/repos/not-an-id/changes/c1/conflicts"},
		{name: "file_at_change", method: http.MethodGet, path: "/repos/not-an-id/file/c1/readme.md"},
		{name: "land", method: http.MethodPost, path: "/repos/not-an-id/land", body: routerCovJSONBody(t, repohost.LandRequest{ChangeIDs: []string{"c1"}})},
		{name: "operations", method: http.MethodGet, path: "/repos/not-an-id/operations"},
		{name: "status", method: http.MethodGet, path: "/repos/not-an-id/status"},
		{name: "snapshot", method: http.MethodPost, path: "/repos/not-an-id/snapshot", body: routerCovJSONBody(t, repohost.SnapshotRequest{ChangeID: "c1"})},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServer(t)
			rec := routerCovServe(t, srv.Handler(), tt.method, tt.path, tt.body)
			routerCovRequireStatus(t, rec, http.StatusBadRequest)
		})
	}
}

func TestRouter_Cov_ChangeEndpointAdditionalBranches(t *testing.T) {
	t.Run("get_change_files_success", func(t *testing.T) {
		mock := &mockFFI{getFilesFn: func(storePath, changeID string) ([]repohost.ChangeFile, error) {
			if changeID != "c1" {
				t.Fatalf("changeID = %q", changeID)
			}
			return []repohost.ChangeFile{{Path: "a.go"}, {Path: "b.go"}}, nil
		}}
		srv := newTestServerWithMock(t, mock)
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice%3Ademo/changes/c1/files", nil)
		routerCovRequireStatus(t, rec, http.StatusOK)
		var files []repohost.ChangeFile
		routerCovDecode(t, rec, &files)
		if len(files) != 2 || files[0].Path != "a.go" {
			t.Fatalf("unexpected files: %+v", files)
		}
	})

	t.Run("create_bookmark_invalid_json", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice%3Ademo/bookmarks", strings.NewReader("{"))
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("list_changes_bad_page", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice%3Ademo/changes?page=abc", nil)
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("list_operations_bad_limit", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice%3Ademo/operations?limit=abc", nil)
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("get_file_empty_path", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodGet, "/repos/alice%3Ademo/file/c1/", nil)
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("land_invalid_json", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice%3Ademo/land", strings.NewReader("{"))
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("snapshot_invalid_json", func(t *testing.T) {
		srv := newTestServer(t)
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/alice%3Ademo/snapshot", strings.NewReader("{"))
		routerCovRequireStatus(t, rec, http.StatusBadRequest)
	})
}

func TestRouter_Cov_ChangeEndpointFFIErrors(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		body   io.Reader
		mock   *mockFFI
		want   int
	}{
		{
			name: "list_bookmarks", method: http.MethodGet, path: "/repos/alice%3Ademo/bookmarks", want: http.StatusInternalServerError,
			mock: &mockFFI{listBookmarksFn: func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Bookmark], error) {
				return repohostffi.Paginated[repohost.Bookmark]{}, assertError("list bookmarks failed")
			}},
		},
		{
			name: "create_bookmark", method: http.MethodPost, path: "/repos/alice%3Ademo/bookmarks", body: routerCovJSONBody(t, repohost.CreateBookmarkRequest{Name: "main"}), want: http.StatusInternalServerError,
			mock: &mockFFI{createBookmarkFn: func(storePath, name, changeID string) (repohost.Bookmark, error) {
				return repohost.Bookmark{}, assertError("create bookmark failed")
			}},
		},
		{
			name: "delete_bookmark", method: http.MethodDelete, path: "/repos/alice%3Ademo/bookmarks/main", want: http.StatusInternalServerError,
			mock: &mockFFI{deleteBookmarkFn: func(storePath, name string) error { return assertError("delete bookmark failed") }},
		},
		{
			name: "list_changes", method: http.MethodGet, path: "/repos/alice%3Ademo/changes", want: http.StatusInternalServerError,
			mock: &mockFFI{listChangesFn: func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Change], error) {
				return repohostffi.Paginated[repohost.Change]{}, assertError("list changes failed")
			}},
		},
		{
			name: "get_diff", method: http.MethodGet, path: "/repos/alice%3Ademo/changes/c1/diff", want: http.StatusInternalServerError,
			mock: &mockFFI{getDiffFn: func(storePath, changeID string) (repohost.ChangeDiff, error) {
				return repohost.ChangeDiff{}, assertError("diff failed")
			}},
		},
		{
			name: "get_files", method: http.MethodGet, path: "/repos/alice%3Ademo/changes/c1/files", want: http.StatusInternalServerError,
			mock: &mockFFI{getFilesFn: func(storePath, changeID string) ([]repohost.ChangeFile, error) {
				return nil, assertError("files failed")
			}},
		},
		{
			name: "list_tree", method: http.MethodGet, path: "/repos/alice%3Ademo/changes/c1/tree", want: http.StatusInternalServerError,
			mock: &mockFFI{listTreeFilesFn: func(storePath, changeID, prefix string) ([]repohost.ChangeFile, error) {
				return nil, assertError("tree failed")
			}},
		},
		{
			name: "conflicts", method: http.MethodGet, path: "/repos/alice%3Ademo/changes/c1/conflicts", want: http.StatusInternalServerError,
			mock: &mockFFI{getConflictsFn: func(storePath, changeID string) ([]repohost.Conflict, error) {
				return nil, assertError("conflicts failed")
			}},
		},
		{
			name: "file_at_change", method: http.MethodGet, path: "/repos/alice%3Ademo/file/c1/readme.md", want: http.StatusInternalServerError,
			mock: &mockFFI{getFileContentFn: func(storePath, changeID, path string) (repohost.FileContent, error) {
				return repohost.FileContent{}, assertError("file failed")
			}},
		},
		{
			name: "list_operations", method: http.MethodGet, path: "/repos/alice%3Ademo/operations", want: http.StatusInternalServerError,
			mock: &mockFFI{listOperationsFn: func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Operation], error) {
				return repohostffi.Paginated[repohost.Operation]{}, assertError("operations failed")
			}},
		},
		{
			name: "snapshot", method: http.MethodPost, path: "/repos/alice%3Ademo/snapshot", body: routerCovJSONBody(t, repohost.SnapshotRequest{ChangeID: "c1"}), want: http.StatusInternalServerError,
			mock: &mockFFI{createSnapshotFn: func(storePath, changeID string) (repohost.SnapshotResult, error) {
				return repohost.SnapshotResult{}, assertError("snapshot failed")
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServerWithMock(t, tt.mock)
			rec := routerCovServe(t, srv.Handler(), tt.method, tt.path, tt.body)
			routerCovRequireStatus(t, rec, tt.want)
			assertGiteaErrorJSON(t, rec.Body.Bytes())
		})
	}
}

func TestRouter_Cov_RemoveEmptyOwnerDirReportsRemoveError(t *testing.T) {
	root := t.TempDir()
	ownerDir := filepath.Join(root, "alice")
	if err := os.MkdirAll(ownerDir, 0o755); err != nil {
		t.Fatalf("mkdir owner dir: %v", err)
	}
	if err := os.Chmod(root, 0o555); err != nil {
		t.Fatalf("chmod root: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o755) })

	err := removeEmptyOwnerDir(ownerDir)
	if err == nil {
		t.Fatal("expected remove error")
	}
	var appErr *appError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected appError, got %T: %v", err, err)
	}
	if appErr.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", appErr.StatusCode)
	}
}

func routerCovJSONBody(t *testing.T, value any) io.Reader {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal request body: %v", err)
	}
	return bytes.NewReader(body)
}

func routerCovGzipBody(t *testing.T, value string) io.Reader {
	t.Helper()
	var body bytes.Buffer
	zw := gzip.NewWriter(&body)
	if _, err := zw.Write([]byte(value)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return bytes.NewReader(body.Bytes())
}

func routerCovServe(t *testing.T, handler http.Handler, method, path string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	return routerCovServeWithHeaders(t, handler, method, path, body, nil)
}

func routerCovServeWithHeaders(t *testing.T, handler http.Handler, method, path string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, body)
	req.Header.Set("Authorization", validAuth())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func routerCovRequireStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, want, rec.Body.String())
	}
}

func routerCovDecode(t *testing.T, rec *httptest.ResponseRecorder, out any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
		t.Fatalf("unmarshal response %q: %v", rec.Body.String(), err)
	}
}
