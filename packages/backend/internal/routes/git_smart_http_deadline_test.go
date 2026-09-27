package routes

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// slowSteadyBody sends size bytes in chunks, one every interval.
type slowSteadyBody struct {
	left     int
	chunk    int
	interval time.Duration
}

func (b *slowSteadyBody) Read(p []byte) (int, error) {
	if b.left == 0 {
		return 0, io.EOF
	}
	time.Sleep(b.interval)
	n := min(len(p), b.chunk, b.left)
	for i := range n {
		p[i] = 'x'
	}
	b.left -= n
	return n, nil
}

// A push that streams steadily for longer than the server's ReadTimeout is
// still read to the end on the git receive-pack route, behind the API's own
// middleware; other routes keep the ReadTimeout.
func TestReceivePackOutlastsTheServerReadTimeout(t *testing.T) {
	const size = 64 << 10
	received := make(chan int64, 1)
	handler := &GitSmartHandler{Service: &mockGitSmartRouteService{
		proxyReceivePackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
			n, err := io.Copy(io.Discard, stdin)
			received <- n
			if err != nil {
				return err
			}
			_, err = io.WriteString(stdout, "ok")
			return err
		},
		proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
			_, err := io.Copy(io.Discard, stdin)
			return err
		},
	}}
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.HTTPTracing("test"))
	r.Use(middleware.StructuredLogger(slog.New(slog.NewTextHandler(io.Discard, nil))))
	r.Use(middleware.HTTPMetrics(NewSmithersMetrics()))
	r.Use(middleware.DependencyRefusals)
	r.Use(middleware.JSONRecoverer)
	r.Post("/{owner}/{repo}/git-receive-pack", handler.ReceivePack)
	r.Post("/{owner}/{repo}/git-upload-pack", handler.UploadPack)
	server := httptest.NewUnstartedServer(r)
	server.Config.ReadTimeout = 300 * time.Millisecond
	server.Start()
	t.Cleanup(server.Close)

	post := func(path string) (*http.Response, error) {
		body := &slowSteadyBody{left: size, chunk: size / 16, interval: 60 * time.Millisecond}
		req, err := http.NewRequest(http.MethodPost, server.URL+path, body)
		require.NoError(t, err)
		req.ContentLength = -1
		return http.DefaultClient.Do(req)
	}
	resp, err := post("/alice/demo.git/git-receive-pack")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, int64(size), <-received, "the push was cut off")

	// upload-pack keeps the server's ReadTimeout.
	resp, err = post("/alice/demo.git/git-upload-pack")
	if err == nil {
		defer resp.Body.Close()
	}
	require.True(t, err != nil || resp.StatusCode != http.StatusOK, "upload-pack outlived the ReadTimeout")
}

// The push limit covers the wait for the repository and, afresh, the push
// from its start: a push that waited most of the limit still has all of it.
func TestReceivePackLimitRestartsWhenThePushStarts(t *testing.T) {
	t.Setenv(repohost.ReceivePackMaxDurationEnv, "500ms")
	const size = 15 << 10
	handler := &GitSmartHandler{Service: &mockGitSmartRouteService{
		proxyReceivePackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
			time.Sleep(400 * time.Millisecond) // waiting for the repository's lock
			repohost.PushStarted(ctx)
			n, err := io.Copy(io.Discard, stdin)
			if err != nil {
				return err
			}
			if n != size {
				return io.ErrUnexpectedEOF
			}
			_, err = io.WriteString(stdout, "ok")
			return err
		},
	}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ReceivePack(w, withRouteParams(r, map[string]string{"owner": "alice", "repo": "demo.git"}))
	}))
	t.Cleanup(server.Close)
	req, err := http.NewRequest(http.MethodPost, server.URL+"/alice/demo.git/git-receive-pack",
		&slowSteadyBody{left: size, chunk: size / 5, interval: 150 * time.Millisecond})
	require.NoError(t, err)
	req.ContentLength = -1
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
}
