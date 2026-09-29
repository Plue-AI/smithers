package blob

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestFilesystemStore(t *testing.T, root string, mutate ...func(*FilesystemConfig)) *FilesystemStore {
	t.Helper()
	cfg := FilesystemConfig{Root: root, PublicBaseURL: "https://smithers.test", SigningKey: bytes.Repeat([]byte{0x42}, 32)}
	for _, fn := range mutate {
		fn(&cfg)
	}
	store, err := NewFilesystemStore(cfg)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	return store
}

func readObject(t *testing.T, store Store, key string) string {
	t.Helper()
	r, err := store.NewReader(context.Background(), key)
	require.NoError(t, err)
	defer func() { require.NoError(t, r.Close()) }()
	payload, err := io.ReadAll(r)
	require.NoError(t, err)
	return string(payload)
}

func TestFilesystemStoreRejectsUnsafeKeys(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	for _, key := range []string{"../escape", "/absolute", "a/../../escape", "a\\b", ".tmp/private", ".objects/private", ".smithers-transfer-key", ".smithers.lock", " repos/1/a"} {
		assert.Error(t, Put(context.Background(), store, key, "", strings.NewReader("x")), key)
	}
}

func TestFilesystemStoreRejectsIntermediateSymlinkReadAndDelete(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	store := newTestFilesystemStore(t, root)
	key := "repos/1/artifacts/object"
	require.NoError(t, store.Put(context.Background(), key, "", strings.NewReader("outside-data")))
	name, err := store.objectName(key)
	require.NoError(t, err)
	shard := filepath.Dir(name)
	outsideShard := filepath.Join(outside, "shard")
	require.NoError(t, os.Rename(filepath.Join(root, shard), outsideShard))
	require.NoError(t, os.Symlink(outsideShard, filepath.Join(root, shard)))

	_, err = store.NewReader(context.Background(), key)
	require.Error(t, err)
	err = store.Delete(context.Background(), key)
	require.Error(t, err)
	payload, readErr := os.ReadFile(filepath.Join(outsideShard, filepath.Base(name)))
	require.NoError(t, readErr)
	assert.Equal(t, "outside-data", string(payload))
}

func TestFilesystemStoreHashesLogicalKeysCaseExactly(t *testing.T) {
	root := t.TempDir()
	store := newTestFilesystemStore(t, root)
	require.NoError(t, store.Put(context.Background(), "repos/1/artifacts/A", "", strings.NewReader("upper")))
	require.NoError(t, store.Put(context.Background(), "repos/1/artifacts/a", "", strings.NewReader("lower")))
	assert.Equal(t, "upper", readObject(t, store, "repos/1/artifacts/A"))
	assert.Equal(t, "lower", readObject(t, store, "repos/1/artifacts/a"))
	_, err := os.Stat(filepath.Join(root, "repos"))
	assert.ErrorIs(t, err, os.ErrNotExist, "logical keys must never become native filesystem paths")
}

func TestFilesystemStoreRejectsUnsafeSigningKeyFile(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "key")
	require.NoError(t, os.WriteFile(outside, bytes.Repeat([]byte{1}, 32), 0o600))
	require.NoError(t, os.Symlink(outside, filepath.Join(root, filesystemKeyFile)))
	_, err := NewFilesystemStore(FilesystemConfig{Root: root, PublicBaseURL: "https://smithers.test"})
	require.ErrorContains(t, err, "private regular file")
}

func TestFilesystemStorePersistsAndReconcilesInterruptedSpools(t *testing.T) {
	root := t.TempDir()
	first := newTestFilesystemStore(t, root, func(cfg *FilesystemConfig) { cfg.SigningKey = nil })
	require.NoError(t, first.Put(context.Background(), "repos/1/lfs/object", "", strings.NewReader("persisted")))
	u, err := first.SignedDownloadURL(context.Background(), "repos/1/lfs/object", time.Minute)
	require.NoError(t, err)
	orphan := filepath.Join(root, filesystemTempDir, "upload-crashed")
	require.NoError(t, os.WriteFile(orphan, []byte("partial"), 0o600))
	require.NoError(t, first.Close())

	second := newTestFilesystemStore(t, root, func(cfg *FilesystemConfig) { cfg.SigningKey = nil })
	assert.Equal(t, "persisted", readObject(t, second, "repos/1/lfs/object"))
	_, err = os.Stat(orphan)
	assert.ErrorIs(t, err, os.ErrNotExist)

	req := httptest.NewRequest(http.MethodGet, mustURLPath(t, u), nil)
	rec := httptest.NewRecorder()
	second.TransferHandler().ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "persisted", rec.Body.String(), "persisted signing key keeps in-flight URLs valid across restart")
}

func TestFilesystemStoreExclusiveOwnerPreservesLiveSpools(t *testing.T) {
	root := t.TempDir()
	first := newTestFilesystemStore(t, root)
	spool := filepath.Join(root, filesystemTempDir, "upload-live")
	require.NoError(t, os.WriteFile(spool, []byte("in-flight"), 0o600))

	_, err := NewFilesystemStore(FilesystemConfig{
		Root: root, PublicBaseURL: "https://smithers.test", SigningKey: bytes.Repeat([]byte{0x42}, 32),
	})
	require.ErrorContains(t, err, "already owned")
	assert.FileExists(t, spool, "a refused second owner must not clean the active owner's spool")

	require.NoError(t, first.Close())
	second := newTestFilesystemStore(t, root)
	assert.NoFileExists(t, spool, "the next exclusive owner reclaims a crashed predecessor's spool")
	require.NotNil(t, second)
}

func TestFilesystemTransferConcurrentCreateOnly(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "pending/workflow-artifacts/repos/42/runs/1/a", "application/octet-stream", 8, time.Minute)
	require.NoError(t, err)
	requestPath := mustURLPath(t, upload.URL)

	const contenders = 12
	statuses := make(chan int, contenders)
	var wg sync.WaitGroup
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := strings.Repeat(string(rune('a'+i)), 8)
			req := httptest.NewRequest(http.MethodPut, requestPath, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/octet-stream")
			rec := httptest.NewRecorder()
			store.TransferHandler().ServeHTTP(rec, req)
			statuses <- rec.Code
		}(i)
	}
	wg.Wait()
	close(statuses)
	created := 0
	for status := range statuses {
		if status == http.StatusCreated {
			created++
		} else {
			assert.Equal(t, http.StatusPreconditionFailed, status)
		}
	}
	assert.Equal(t, 1, created)
	assert.Len(t, readObject(t, store, "pending/workflow-artifacts/repos/42/runs/1/a"), 8)
}

func TestFilesystemStoreConcurrentOverwriteKeepsAuthoritativeQuota(t *testing.T) {
	root := t.TempDir()
	store := newTestFilesystemStore(t, root, func(cfg *FilesystemConfig) { cfg.MaxBytes = 1 << 20 })
	const contenders = 24
	start := make(chan struct{})
	errs := make(chan error, contenders)
	var wg sync.WaitGroup
	for i := range contenders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			payload := strings.Repeat(string(rune('a'+i%26)), 64+i)
			errs <- store.Put(context.Background(), "repos/7/artifacts/current", "", strings.NewReader(payload))
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}

	attrs, err := store.Stat(context.Background(), "repos/7/artifacts/current")
	require.NoError(t, err)
	store.quotaMu.Lock()
	used := store.used
	store.quotaMu.Unlock()
	assert.Equal(t, attrs.Size, used)
	assert.Equal(t, attrs.Size, int64(len(readObject(t, store, "repos/7/artifacts/current"))))

	require.NoError(t, store.Close())
	reopened := newTestFilesystemStore(t, root, func(cfg *FilesystemConfig) { cfg.MaxBytes = 1 << 20 })
	reopened.quotaMu.Lock()
	recounted := reopened.used
	reopened.quotaMu.Unlock()
	assert.Equal(t, attrs.Size, recounted)
}

func TestFilesystemTransferPlainUploadOverwrites(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	u, err := store.SignedUploadURL(context.Background(), "repos/4/artifacts/output", "text/plain", 16, time.Minute)
	require.NoError(t, err)
	for _, payload := range []string{"first", "second"} {
		req := httptest.NewRequest(http.MethodPut, mustURLPath(t, u), strings.NewReader(payload))
		req.Header.Set("Content-Type", "text/plain")
		rec := httptest.NewRecorder()
		store.TransferHandler().ServeHTTP(rec, req)
		assert.Equal(t, http.StatusCreated, rec.Code)
	}
	assert.Equal(t, "second", readObject(t, store, "repos/4/artifacts/output"))
}

func TestFilesystemTransferCredentialScopeExpiryAndValidation(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	store.now = func() time.Time { return time.Unix(1_000, 0) }
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "lfs-pending/19/"+strings.Repeat("a", 64), "application/octet-stream", 3, time.Minute)
	require.NoError(t, err)
	requestPath := mustURLPath(t, upload.URL)

	wrongMethod := httptest.NewRecorder()
	store.TransferHandler().ServeHTTP(wrongMethod, httptest.NewRequest(http.MethodGet, requestPath, nil))
	assert.Equal(t, http.StatusMethodNotAllowed, wrongMethod.Code)

	wrongSize := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, requestPath, strings.NewReader("xx"))
	req.Header.Set("Content-Type", "application/octet-stream")
	store.TransferHandler().ServeHTTP(wrongSize, req)
	assert.Equal(t, http.StatusBadRequest, wrongSize.Code)

	tampered := tamperTransferKey(t, requestPath, "lfs-pending/20/"+strings.Repeat("a", 64))
	tamperedRec := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, tampered, strings.NewReader("xxx"))
	req.Header.Set("Content-Type", "application/octet-stream")
	store.TransferHandler().ServeHTTP(tamperedRec, req)
	assert.Equal(t, http.StatusForbidden, tamperedRec.Code)

	store.now = func() time.Time { return time.Unix(1_061, 0) }
	expired := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, requestPath, strings.NewReader("xxx"))
	req.Header.Set("Content-Type", "application/octet-stream")
	store.TransferHandler().ServeHTTP(expired, req)
	assert.Equal(t, http.StatusForbidden, expired.Code)
}

func TestFilesystemTransferRejectsDigestMismatchWithoutPublishing(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	oid := strings.Repeat("0", 64)
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "lfs-pending/9/"+oid, "application/octet-stream", 3, time.Minute)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPut, mustURLPath(t, upload.URL), strings.NewReader("bad"))
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	store.TransferHandler().ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	exists, err := store.Exists(context.Background(), "lfs-pending/9/"+oid)
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestFilesystemDownloadSupportsHeadRangeAndConditionalGET(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	require.NoError(t, store.Put(context.Background(), "repos/5/artifacts/result", "", strings.NewReader("0123456789")))
	u, err := store.SignedDownloadURL(context.Background(), "repos/5/artifacts/result", time.Minute)
	require.NoError(t, err)
	requestPath := mustURLPath(t, u)

	rangeRequest := httptest.NewRequest(http.MethodGet, requestPath, nil)
	rangeRequest.Header.Set("Range", "bytes=2-5")
	rangeResponse := httptest.NewRecorder()
	store.TransferHandler().ServeHTTP(rangeResponse, rangeRequest)
	assert.Equal(t, http.StatusPartialContent, rangeResponse.Code)
	assert.Equal(t, "2345", rangeResponse.Body.String())
	assert.Equal(t, "bytes 2-5/10", rangeResponse.Header().Get("Content-Range"))
	etag := rangeResponse.Header().Get("ETag")
	assert.NotEmpty(t, etag)

	headResponse := httptest.NewRecorder()
	store.TransferHandler().ServeHTTP(headResponse, httptest.NewRequest(http.MethodHead, requestPath, nil))
	assert.Equal(t, http.StatusOK, headResponse.Code)
	assert.Empty(t, headResponse.Body.String())
	assert.Equal(t, "10", headResponse.Header().Get("Content-Length"))

	conditionalRequest := httptest.NewRequest(http.MethodGet, requestPath, nil)
	conditionalRequest.Header.Set("If-None-Match", etag)
	conditionalResponse := httptest.NewRecorder()
	store.TransferHandler().ServeHTTP(conditionalResponse, conditionalRequest)
	assert.Equal(t, http.StatusNotModified, conditionalResponse.Code)
	assert.Empty(t, conditionalResponse.Body.String())
}

func TestFilesystemSignedDownloadDefersMissingObjectToTransfer(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	u, err := store.SignedDownloadURL(context.Background(), "repos/5/artifacts/missing", time.Minute)
	require.NoError(t, err)
	rec := httptest.NewRecorder()
	store.TransferHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, mustURLPath(t, u), nil))
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

type deadlineTrackingResponseWriter struct {
	mu                sync.Mutex
	header            http.Header
	body              bytes.Buffer
	status            int
	readDeadline      time.Time
	readDeadlineCalls int
}

func newDeadlineTrackingResponseWriter() *deadlineTrackingResponseWriter {
	return &deadlineTrackingResponseWriter{header: make(http.Header)}
}

func (w *deadlineTrackingResponseWriter) Header() http.Header { return w.header }

func (w *deadlineTrackingResponseWriter) WriteHeader(status int) { w.status = status }

func (w *deadlineTrackingResponseWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(p)
}

func (w *deadlineTrackingResponseWriter) SetReadDeadline(deadline time.Time) error {
	w.mu.Lock()
	w.readDeadline = deadline
	w.readDeadlineCalls++
	w.mu.Unlock()
	return nil
}

func (w *deadlineTrackingResponseWriter) SetWriteDeadline(time.Time) error { return nil }

func (w *deadlineTrackingResponseWriter) currentReadDeadline() time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.readDeadline
}

type deadlineAwareSlowReader struct {
	writer *deadlineTrackingResponseWriter
	chunks []string
	delay  time.Duration
	index  int
}

func (r *deadlineAwareSlowReader) Read(p []byte) (int, error) {
	if r.index >= len(r.chunks) {
		return 0, io.EOF
	}
	time.Sleep(r.delay)
	if deadline := r.writer.currentReadDeadline(); !deadline.IsZero() && time.Now().After(deadline) {
		return 0, deadlineTimeoutError{}
	}
	n := copy(p, r.chunks[r.index])
	r.index++
	return n, nil
}

type deadlineTimeoutError struct{}

func (deadlineTimeoutError) Error() string   { return "read deadline exceeded" }
func (deadlineTimeoutError) Timeout() bool   { return true }
func (deadlineTimeoutError) Temporary() bool { return true }

func TestFilesystemTransferRefreshesBoundedIdleDeadline(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	store.idleTimeout = 70 * time.Millisecond
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "repos/6/artifacts/slow", "application/octet-stream", 4, time.Minute)
	require.NoError(t, err)

	w := newDeadlineTrackingResponseWriter()
	body := &deadlineAwareSlowReader{writer: w, chunks: []string{"a", "b", "c", "d"}, delay: 40 * time.Millisecond}
	req := httptest.NewRequest(http.MethodPut, mustURLPath(t, upload.URL), body)
	req.Header.Set("Content-Type", "application/octet-stream")
	started := time.Now()
	store.TransferHandler().ServeHTTP(w, req)

	assert.Greater(t, time.Since(started), store.idleTimeout, "total transfer may exceed one idle window")
	assert.Equal(t, http.StatusCreated, w.status)
	assert.GreaterOrEqual(t, w.readDeadlineCalls, 4, "each body read refreshes the bounded deadline")
	assert.Equal(t, "abcd", readObject(t, store, "repos/6/artifacts/slow"))
}

type singleConnListener struct {
	mu        sync.Mutex
	conn      net.Conn
	closed    chan struct{}
	closeOnce sync.Once
}

func (l *singleConnListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if l.conn != nil {
		conn := l.conn
		l.conn = nil
		l.mu.Unlock()
		return conn, nil
	}
	l.mu.Unlock()
	<-l.closed
	return nil, net.ErrClosed
}

func (l *singleConnListener) Close() error {
	l.closeOnce.Do(func() { close(l.closed) })
	return nil
}

func (l *singleConnListener) Addr() net.Addr { return pipeAddr("blob-transfer") }

type pipeAddr string

func (a pipeAddr) Network() string { return "pipe" }
func (a pipeAddr) String() string  { return string(a) }

func TestFilesystemTransferOutlivesAbsoluteHTTPServerTimeouts(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	store.idleTimeout = 80 * time.Millisecond
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "repos/6/artifacts/server-slow", "application/octet-stream", 4, time.Minute)
	require.NoError(t, err)

	serverConn, clientConn := net.Pipe()
	listener := &singleConnListener{conn: serverConn, closed: make(chan struct{})}
	server := &http.Server{
		Handler:      store.TransferHandler(),
		ReadTimeout:  50 * time.Millisecond,
		WriteTimeout: 50 * time.Millisecond,
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	t.Cleanup(func() {
		_ = clientConn.Close()
		_ = server.Close()
		<-serveDone
	})
	require.NoError(t, clientConn.SetDeadline(time.Now().Add(3*time.Second)))

	requestPath := mustURLPath(t, upload.URL)
	_, err = io.WriteString(clientConn, "PUT "+requestPath+" HTTP/1.1\r\nHost: smithers.test\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\nConnection: close\r\n\r\n")
	require.NoError(t, err)
	started := time.Now()
	for _, part := range []string{"a", "b", "c", "d"} {
		time.Sleep(35 * time.Millisecond)
		_, err = io.WriteString(clientConn, part)
		require.NoError(t, err)
	}
	response, err := http.ReadResponse(bufio.NewReader(clientConn), &http.Request{Method: http.MethodPut})
	require.NoError(t, err)
	defer func() { _ = response.Body.Close() }()

	assert.Greater(t, time.Since(started), server.ReadTimeout)
	assert.Greater(t, time.Since(started), server.WriteTimeout)
	assert.Equal(t, http.StatusCreated, response.StatusCode)
	assert.Equal(t, "abcd", readObject(t, store, "repos/6/artifacts/server-slow"))
}

func TestFilesystemTransferStopsAfterIdleDeadline(t *testing.T) {
	store := newTestFilesystemStore(t, t.TempDir())
	store.idleTimeout = 25 * time.Millisecond
	upload, err := store.SignedCreateOnlyUploadURL(context.Background(), "repos/6/artifacts/stalled", "application/octet-stream", 1, time.Minute)
	require.NoError(t, err)

	w := newDeadlineTrackingResponseWriter()
	body := &deadlineAwareSlowReader{writer: w, chunks: []string{"x"}, delay: 60 * time.Millisecond}
	req := httptest.NewRequest(http.MethodPut, mustURLPath(t, upload.URL), body)
	req.Header.Set("Content-Type", "application/octet-stream")
	store.TransferHandler().ServeHTTP(w, req)

	assert.Equal(t, http.StatusRequestTimeout, w.status)
	exists, statErr := store.Exists(context.Background(), "repos/6/artifacts/stalled")
	require.NoError(t, statErr)
	assert.False(t, exists)
}

type failingReader struct {
	sent bool
}

func (r *failingReader) Read(p []byte) (int, error) {
	if !r.sent {
		r.sent = true
		copy(p, "part")
		return 4, nil
	}
	return 0, errors.New("connection interrupted")
}

func TestFilesystemStoreInterruptedAndQuotaFailuresPublishNothing(t *testing.T) {
	root := t.TempDir()
	store := newTestFilesystemStore(t, root, func(cfg *FilesystemConfig) { cfg.MaxBytes = 4 })
	_, err := store.writeObject(context.Background(), "repos/1/artifacts/interrupted", &failingReader{}, true, UnknownObjectSize, UnknownObjectSize, "")
	assert.EqualError(t, err, "connection interrupted")
	exists, statErr := store.Exists(context.Background(), "repos/1/artifacts/interrupted")
	require.NoError(t, statErr)
	assert.False(t, exists)

	err = store.Put(context.Background(), "repos/1/artifacts/full", "", strings.NewReader("12345"))
	assert.ErrorIs(t, err, ErrStorageFull)
	exists, statErr = store.Exists(context.Background(), "repos/1/artifacts/full")
	require.NoError(t, statErr)
	assert.False(t, exists)
	entries, err := os.ReadDir(filepath.Join(root, filesystemTempDir))
	require.NoError(t, err)
	assert.Empty(t, entries)
}

func TestFilesystemAgentLogsAreDurable(t *testing.T) {
	root := t.TempDir()
	first := NewFilesystemAgentLogStore(newTestFilesystemStore(t, root))
	require.NoError(t, first.PutSessionLog(context.Background(), 3, "session", []byte(`{"ok":true}`)))
	require.NoError(t, first.store.Close())
	second := NewFilesystemAgentLogStore(newTestFilesystemStore(t, root))
	payload, err := second.GetSessionLog(context.Background(), 3, "session")
	require.NoError(t, err)
	assert.JSONEq(t, `{"ok":true}`, string(payload))
}

func mustURLPath(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	require.NoError(t, err)
	return parsed.RequestURI()
}

func tamperTransferKey(t *testing.T, requestPath, key string) string {
	t.Helper()
	token := strings.TrimPrefix(requestPath, filesystemTransferPath)
	parts := strings.Split(token, ".")
	require.Len(t, parts, 2)
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	require.NoError(t, err)
	var claims transferClaims
	require.NoError(t, json.Unmarshal(payload, &claims))
	claims.Key = key
	payload, err = json.Marshal(claims)
	require.NoError(t, err)
	return filesystemTransferPath + base64.RawURLEncoding.EncodeToString(payload) + "." + parts[1]
}
