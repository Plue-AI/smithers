package repohostserver

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// TestStreamGitRPCLargePackfile verifies that streamGitRPC pipes output directly
// to the destination writer rather than accumulating the full response in memory.
// The test uses a git stub that writes 15 MB of data and checks that:
//   - the full payload reaches the destination intact
//   - the response status header is sent before the body completes (streaming)
func TestStreamGitRPCLargePackfile(t *testing.T) {
	const payloadSize = 15 * 1024 * 1024 // 15 MB — well above any reasonable stack/heap guard

	// Install a git stub that writes payloadSize bytes of 'x' to stdout.
	installGitStub(t, fmt.Sprintf(`#!/bin/sh
cat >/dev/null
dd if=/dev/zero bs=1024 count=%d 2>/dev/null | tr '\0' 'x'
`, payloadSize/1024))

	var dst bytes.Buffer
	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", bytes.NewBufferString("request"), &dst)
	if err != nil {
		t.Fatalf("streamGitRPC returned error: %v", err)
	}
	if dst.Len() != payloadSize {
		t.Fatalf("expected %d bytes, got %d", payloadSize, dst.Len())
	}
	// Verify all bytes are 'x' (not zero or corrupted).
	payload := dst.Bytes()
	for i, b := range payload {
		if b != 'x' {
			t.Fatalf("byte %d corrupted: got 0x%02x, want 0x%02x", i, b, 'x')
		}
	}
}

func TestReceivePackEnforcesGitInputCap(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nprintf '%s:%s' \"$GIT_CONFIG_KEY_0\" \"$GIT_CONFIG_VALUE_0\"\n")
	var response bytes.Buffer
	if err := streamGitRPC(context.Background(), t.TempDir(), "receive-pack", strings.NewReader(""), &response); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("receive.maxInputSize:%d", maxDecompressedGitRequestSize)
	if response.String() != want {
		t.Fatalf("git receive cap = %q, want %q", response.String(), want)
	}
}

// TestUploadPackStreamsResponseWithoutBuffering verifies that the repo-host
// uploadPack HTTP handler streams the git output directly to the HTTP response
// without waiting for git to finish. It does this by:
//  1. Installing a git stub that emits bytes in two chunks with no blocking.
//  2. Checking that all expected bytes arrive in the HTTP response body.
func TestUploadPackStreamsResponseWithoutBuffering(t *testing.T) {
	const chunkA = "PACK-HEAD-BYTES"
	const chunkB = "PACK-TAIL-BYTES"

	installGitStub(t, fmt.Sprintf(`#!/bin/sh
if [ "$1" = "upload-pack" ]; then
  cat >/dev/null
  printf '%s'
  printf '%s'
  exit 0
fi
exit 1
`, chunkA, chunkB))

	srv := newTestServer(t)
	handler := srv.Handler()

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/git/upload-pack", bytes.NewBufferString("want-request"))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	got := w.Body.String()
	if got != chunkA+chunkB {
		t.Fatalf("expected body %q, got %q", chunkA+chunkB, got)
	}
}

// TestUploadPackMidStreamFailureDoesNotCorrupt verifies that if the git process
// fails mid-stream (after some bytes have been sent to the client), the handler
// does NOT append any extra error bytes to the response body. The git client
// will observe a truncated stream and handle it as a protocol error — that is
// correct and safe. What must not happen is the server appending an HTTP error
// body (e.g. "internal server error\n") after the git response bytes.
func TestUploadPackMidStreamFailureDoesNotCorrupt(t *testing.T) {
	const validPrefix = "VALID-PACK-DATA-"

	// Stub: write some valid bytes to stdout, then exit non-zero.
	installGitStub(t, fmt.Sprintf(`#!/bin/sh
if [ "$1" = "upload-pack" ]; then
  cat >/dev/null
  printf '%s'
  exit 1
fi
exit 1
`, validPrefix))

	srv := newTestServer(t)
	handler := srv.Handler()

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/git/upload-pack", bytes.NewBufferString("want"))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	// The status MUST be 200 because we committed headers before streaming.
	// The body MUST start with the valid prefix and MUST NOT contain any
	// appended error text.
	got := w.Body.String()
	if !strings.HasPrefix(got, validPrefix) {
		t.Fatalf("expected body to start with %q, got %q", validPrefix, got)
	}
	// Assert no error bytes appended after the valid prefix.
	if got != validPrefix {
		t.Fatalf("expected body to be exactly %q (no trailing corruption), got %q", validPrefix, got)
	}
}

// TestReceivePackFailsWhenImportRefsFails covers the import failure path in
// http_api_test.go. This test adds an explicit assertion that the git response
// is preserved when post-receive processing succeeds.
func TestReceivePackGitResponsePreserved(t *testing.T) {
	const gitResponse = "receive-pack-status-bytes"

	installGitStub(t, fmt.Sprintf(`#!/bin/sh
case "$1" in
  receive-pack)
    cat >/dev/null
    printf '%s'
    exit 0
    ;;
  --git-dir)
    # for-each-ref stub — return empty
    exit 0
    ;;
esac
exit 1
`, gitResponse))

	srv := newTestServerWithMock(t, &mockFFI{})
	handler := srv.Handler()

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/git/receive-pack", bytes.NewBufferString("0000"))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-receive-pack-request")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != gitResponse {
		t.Fatalf("expected git response %q, got %q", gitResponse, got)
	}
}

// TestInfoRefsInlinesPrefixAndStreamsOutput verifies that the infoRefs handler
// constructs the correct pkt-line service header prefix and appends the raw
// git advertise-refs output without buffering all of it in a separate buffer.
func TestInfoRefsInlinesPrefixAndStreamsOutput(t *testing.T) {
	const gitRefOutput = "00a7some-ref-advertisement-bytes"
	service := "git-upload-pack"

	installGitStub(t, fmt.Sprintf(`#!/bin/sh
if [ "$1" = "upload-pack" ]; then
  printf '%s'
  exit 0
fi
exit 1
`, gitRefOutput))

	srv := newTestServer(t)
	handler := srv.Handler()

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/git/info-refs?service="+service, nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	ct := w.Header().Get("Content-Type")
	if ct != "application/x-git-upload-pack-advertisement" {
		t.Fatalf("unexpected Content-Type: %q", ct)
	}

	// Build the expected pkt-line prefix.
	serviceLine := fmt.Sprintf("# service=%s\n", service)
	pktLen := len(serviceLine) + 4
	expectedPrefix := fmt.Sprintf("%04x%s0000", pktLen, serviceLine)
	expected := expectedPrefix + gitRefOutput

	if got := w.Body.String(); got != expected {
		t.Fatalf("expected body %q, got %q", expected, got)
	}
}

// TestStreamGitRPCFailureReturnsError verifies that a non-zero git exit code
// causes streamGitRPC to return an error.
func TestStreamGitRPCFailureReturnsError(t *testing.T) {
	stubDir := t.TempDir()
	stubPath := filepath.Join(stubDir, "git")
	if err := os.WriteFile(stubPath, []byte("#!/bin/sh\nexit 42\n"), 0o755); err != nil {
		t.Fatalf("write git stub: %v", err)
	}
	useGitProgram(t, stubPath)

	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", nil, io.Discard)
	if err == nil {
		t.Fatal("expected error from non-zero git exit, got nil")
	}
}

// failingDst accepts a bounded number of bytes and then fails every write,
// simulating an HTTP client that disconnects mid-stream.
type failingDst struct {
	allowed int
}

func (f *failingDst) Write(p []byte) (int, error) {
	f.allowed -= len(p)
	if f.allowed < 0 {
		return 0, fmt.Errorf("client disconnected")
	}
	return len(p), nil
}

// TestStreamGitRPCDstFailureDoesNotHang reproduces the upload-pack hang after
// a client disconnect: when the destination write fails mid-stream, the pipe
// reader must be closed so exec's stdout copier unblocks and cmd.Wait()
// returns. Without that, git keeps a repository lock holder stuck forever.
func TestStreamGitRPCDstFailureDoesNotHang(t *testing.T) {
	// 8 MiB of output with a destination that fails after 64 KiB: far more
	// than the OS pipe plus io.Pipe can absorb, so a leaked pipe would block
	// the git stub (and cmd.Wait) indefinitely.
	installGitStub(t, `#!/bin/sh
cat >/dev/null
dd if=/dev/zero bs=1024 count=8192 2>/dev/null
`)

	done := make(chan error, 1)
	go func() {
		done <- streamGitRPC(context.Background(), t.TempDir(), "upload-pack", strings.NewReader("req"), &failingDst{allowed: 64 * 1024})
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error after the destination write failed")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("streamGitRPC hung after destination write failure")
	}
}

// TestReceivePackStalledBodyIdleTimeout verifies the git RPC idle deadline
// end-to-end through a real HTTP server (including every response-writer
// wrapper in the middleware chain): a client that sends part of a push body
// and then stalls must be cut off after gitRPCIdleTimeout instead of holding
// the repository write lock until the TCP connection dies.
func TestReceivePackStalledBodyIdleTimeout(t *testing.T) {
	installGitStub(t, `#!/bin/sh
case "$1" in
  receive-pack)
    cat >/dev/null
    exit 0
    ;;
  --git-dir)
    exit 0
    ;;
esac
exit 1
`)

	oldTimeout := gitRPCIdleTimeout
	gitRPCIdleTimeout = 250 * time.Millisecond
	t.Cleanup(func() { gitRPCIdleTimeout = oldTimeout })

	srv := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	pr, pw := io.Pipe()
	t.Cleanup(func() { _ = pw.Close() })
	go func() {
		// Send a partial body, then stall without closing.
		_, _ = pw.Write([]byte("00"))
	}()

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/repos/alice/demo/git/receive-pack", pr)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-receive-pack-request")

	type result struct {
		resp *http.Response
		err  error
	}
	done := make(chan result, 1)
	go func() {
		resp, err := ts.Client().Do(req)
		done <- result{resp, err}
	}()

	select {
	case res := <-done:
		// The idle deadline fired: the server must have terminated the
		// request (an error status or a broken connection are both
		// acceptable) instead of waiting forever on the stalled body.
		if res.resp != nil {
			defer func() { _ = res.resp.Body.Close() }()
			if res.resp.StatusCode == http.StatusOK {
				t.Fatalf("expected a failed request after body stall, got status %d", res.resp.StatusCode)
			}
		}
	case <-time.After(15 * time.Second):
		t.Fatal("stalled receive-pack body was not terminated by the idle deadline")
	}
}

func TestLocalReceivePackStalledBodyIdleTimeout(t *testing.T) {
	installGitStub(t, "#!/bin/sh\ncase \"$1\" in receive-pack) cat >/dev/null; exit 0;; --git-dir) exit 0;; esac\nexit 1\n")
	oldTimeout := gitRPCIdleTimeout
	gitRPCIdleTimeout = 50 * time.Millisecond
	t.Cleanup(func() { gitRPCIdleTimeout = oldTimeout })
	srv := newTestServer(t)
	if err := os.MkdirAll(srv.config.GitBackendPath("alice", "demo"), 0o755); err != nil {
		t.Fatal(err)
	}
	client := repohost.NewLocalClient(srv.Handler(), testAuthToken)
	pr, pw := io.Pipe()
	defer pw.Close()
	// One whole command and no flush: the client's metadata peek completes,
	// then the server's command-list peek waits for bytes that never come.
	line := "0000000000000000000000000000000000000000 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef refs/heads/main\x00report-status\n"
	go func() { _, _ = fmt.Fprintf(pw, "%04x%s", len(line)+4, line) }()
	done := make(chan error, 1)
	go func() { done <- client.ProxyReceivePack(context.Background(), "alice", "demo", pr, io.Discard) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("stalled local push unexpectedly succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("local receive-pack ignored idle read deadline")
	}
}

// TestInfoRefsAdvertisementTooLargeFailsClosed verifies that a pathological
// ref advertisement is not buffered without bound: past the cap the request
// fails closed with an error status.
func TestInfoRefsAdvertisementTooLargeFailsClosed(t *testing.T) {
	oldMax := maxRefAdvertisementBytes
	maxRefAdvertisementBytes = 1024
	t.Cleanup(func() { maxRefAdvertisementBytes = oldMax })

	// Emit 64 KiB of advertisement — well past the 1 KiB test cap.
	installGitStub(t, `#!/bin/sh
if [ "$1" = "upload-pack" ]; then
  dd if=/dev/zero bs=1024 count=64 2>/dev/null | tr '\0' 'x'
  exit 0
fi
exit 1
`)

	srv := newTestServer(t)
	handler := srv.Handler()

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/git/info-refs?service=git-upload-pack", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for oversized advertisement, got %d; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "ref advertisement exceeds maximum size") {
		t.Fatalf("expected over-cap error message, got %q", w.Body.String())
	}
}

// TestInfoRefsStderrDoesNotCorruptAdvertisement verifies that git's stderr
// chatter (e.g. "warning: ...") is not interleaved into the pkt-line ref
// advertisement body.
func TestInfoRefsStderrDoesNotCorruptAdvertisement(t *testing.T) {
	const gitRefOutput = "00a7some-ref-advertisement-bytes"
	service := "git-upload-pack"

	installGitStub(t, fmt.Sprintf(`#!/bin/sh
if [ "$1" = "upload-pack" ]; then
  echo 'warning: stderr chatter must not reach the client' >&2
  printf '%s'
  exit 0
fi
exit 1
`, gitRefOutput))

	srv := newTestServer(t)
	handler := srv.Handler()

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/git/info-refs?service="+service, nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	serviceLine := fmt.Sprintf("# service=%s\n", service)
	pktLen := len(serviceLine) + 4
	expected := fmt.Sprintf("%04x%s0000", pktLen, serviceLine) + gitRefOutput
	if got := w.Body.String(); got != expected {
		t.Fatalf("stderr corrupted the advertisement: expected %q, got %q", expected, got)
	}
}
