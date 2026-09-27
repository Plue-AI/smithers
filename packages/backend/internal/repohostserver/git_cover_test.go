package repohostserver

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type gitCovErrReader struct{}

func (gitCovErrReader) Read([]byte) (int, error) {
	return 0, errors.New("read exploded")
}

type gitCovErrWriter struct{}

func (gitCovErrWriter) Write([]byte) (int, error) {
	return 0, errors.New("write exploded")
}

func TestGit_Cov_StreamGitRPCReportsStartError(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", nil, io.Discard)
	if err == nil {
		t.Fatal("expected start error")
	}
	if !strings.Contains(err.Error(), "start git upload-pack") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGit_Cov_StreamGitRPCReportsBodyCopyError(t *testing.T) {
	installGitStub(t, "#!/bin/sh\ncat >/dev/null\nexit 0\n")

	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", gitCovErrReader{}, io.Discard)
	if err == nil {
		t.Fatal("expected body copy error")
	}
	if !strings.Contains(err.Error(), "stream request body to git upload-pack") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGit_Cov_StreamGitRPCReportsOutputWriteError(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nprintf output\nexit 0\n")

	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", nil, gitCovErrWriter{})
	if err == nil {
		t.Fatal("expected output write error")
	}
	if !strings.Contains(err.Error(), "stream git upload-pack output") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGit_Cov_RunGitRPCBufferedSuccessAndFailure(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"upload-pack\" ]; then printf buffered; exit 0; fi\nexit 9\n")

	got, err := runGitRPCBuffered(context.Background(), t.TempDir(), "upload-pack", nil)
	if err != nil {
		t.Fatalf("runGitRPCBuffered success returned error: %v", err)
	}
	if string(got) != "buffered" {
		t.Fatalf("buffered output = %q", got)
	}

	_, err = runGitRPCBuffered(context.Background(), t.TempDir(), "receive-pack", nil)
	if err == nil {
		t.Fatal("expected buffered git failure")
	}
}

// lateEOFReader ends the request body only after git has exited: it waits
// for the marker git writes as its last act, so exec's own post-exit close
// of git's stdin comes first.
type lateEOFReader struct{ marker string }

func (r lateEOFReader) Read([]byte) (int, error) {
	for {
		if _, err := os.Stat(r.marker); err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	return 0, io.EOF
}

// Issue #2266: git exiting before the request body ends is a successful RPC,
// not "close |1: file already closed".
func TestGit_Cov_StreamGitRPCSucceedsWhenGitExitsBeforeBodyEOF(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "exited")
	installGitStub(t, "#!/bin/sh\nprintf done\n: > '"+marker+"'\nexit 0\n")

	var out strings.Builder
	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", lateEOFReader{marker: marker}, &out)
	if err != nil {
		t.Fatalf("streamGitRPC returned error: %v", err)
	}
	if out.String() != "done" {
		t.Fatalf("output = %q", out.String())
	}
}

// A git that exits without reading the whole body (receive-pack refusing a
// pack past receive.maxInputSize) failed the RPC even when it exits 0.
func TestGit_Cov_StreamGitRPCReportsUnreadBody(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nexit 0\n")

	err := streamGitRPC(context.Background(), t.TempDir(), "receive-pack", strings.NewReader(strings.Repeat("x", 1<<20)), io.Discard)
	if err == nil {
		t.Fatal("expected unread body error")
	}
	if !strings.Contains(err.Error(), "stream request body to git receive-pack") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// Issue #2266: a fast-exiting git never turns a successful RPC into an error.
// Like upload-pack, the stub reads its whole request, then exits without
// waiting for the body's EOF. A git that reads none of it is an unread body
// (TestGit_Cov_StreamGitRPCReportsUnreadBody), not a successful RPC.
func TestGit_Cov_StreamGitRPCFastExitStress(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nhead -c 4 >/dev/null\nprintf buffered\nexit 0\n")
	dir := t.TempDir()

	failures := 0
	for i := 0; i < 1000; i++ {
		got, err := runGitRPCBuffered(context.Background(), dir, "upload-pack", strings.NewReader("0000"))
		if err != nil || string(got) != "buffered" {
			failures++
			t.Logf("iteration %d: output %q, error %v", i, got, err)
		}
	}
	if failures != 0 {
		t.Fatalf("%d of 1000 successful RPCs failed", failures)
	}
}

func TestGit_Cov_ListGitRefsParsesRefsAndSkipsBlankLines(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nprintf '\\nrefs/heads/main\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n\\nrefs/tags/v1\\000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'\n")

	refs, err := listGitRefs(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("listGitRefs returned error: %v", err)
	}
	if refs["refs/heads/main"] != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("main ref = %q", refs["refs/heads/main"])
	}
	if refs["refs/tags/v1"] != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
		t.Fatalf("tag ref = %q", refs["refs/tags/v1"])
	}
}

func TestGit_Cov_ListGitRefsReportsGitFailure(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nexit 12\n")

	_, err := listGitRefs(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("expected list refs git failure")
	}
	if !strings.Contains(err.Error(), "list git refs") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGit_Cov_ListGitRefsRejectsMalformedLines(t *testing.T) {
	tests := []struct {
		name   string
		script string
	}{
		{name: "missing_separator", script: "#!/bin/sh\nprintf 'refs/heads/main\\n'\n"},
		{name: "empty_object", script: "#!/bin/sh\nprintf 'refs/heads/main\\000   \\n'\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			installGitStub(t, tt.script)

			_, err := listGitRefs(context.Background(), t.TempDir())
			if err == nil {
				t.Fatal("expected malformed ref listing error")
			}
			if !strings.Contains(err.Error(), "parse git ref listing") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// A repository with a pathological ref set must not make listGitRefs buffer
// an unbounded listing while the push holds the repository write lock: past
// the cap git is killed and the snapshot fails with a typed error.
func TestGit_Cov_ListGitRefsFailsClosedPastByteCap(t *testing.T) {
	oldMax := maxRefListingBytes
	maxRefListingBytes = 1024
	t.Cleanup(func() { maxRefListingBytes = oldMax })

	// An endless listing: only a killed subprocess ends it.
	installGitStub(t, "#!/bin/sh\nwhile :; do printf 'refs/heads/x\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; done\n")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	_, err := listGitRefs(ctx, t.TempDir())
	if !errors.Is(err, errRefListingTooLarge) {
		t.Fatalf("listGitRefs error = %v, want errRefListingTooLarge", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("listGitRefs took %s; git was not killed at the cap", elapsed)
	}
}
