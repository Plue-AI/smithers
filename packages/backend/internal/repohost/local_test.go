package repohost

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func localRequest(t *testing.T, ctx context.Context) *http.Request {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://repository.local/test", nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestLocalTransportCancellationInterruptsResponseBody(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport := &handlerTransport{handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "start")
		<-r.Context().Done()
	})}
	response, err := transport.RoundTrip(localRequest(t, ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	buf := make([]byte, 5)
	if _, err := io.ReadFull(response.Body, buf); err != nil || string(buf) != "start" {
		t.Fatalf("first chunk: %q, %v", buf, err)
	}
	cancel()
	read := make(chan error, 1)
	go func() { _, err := response.Body.Read(buf); read <- err }()
	select {
	case err := <-read:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("read error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled response read did not stop")
	}
}

func TestLocalTransportRecoversAbort(t *testing.T) {
	transport := &handlerTransport{handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) })}
	_, err := transport.RoundTrip(localRequest(t, context.Background()))
	if err == nil || !strings.Contains(err.Error(), "aborted") {
		t.Fatalf("abort error = %v", err)
	}
}

func TestLocalTransportReadDeadline(t *testing.T) {
	pr, pw := io.Pipe()
	defer pw.Close()
	transport := &handlerTransport{handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
			t.Errorf("set read deadline: %v", err)
		}
		_, err := io.Copy(io.Discard, r.Body)
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Errorf("read error = %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})}
	req := localRequest(t, context.Background())
	req.Body = pr
	response, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", response.StatusCode)
	}
}

func TestLocalTransportWriteDeadline(t *testing.T) {
	written := make(chan error, 1)
	transport := &handlerTransport{handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
			t.Errorf("set write deadline: %v", err)
		}
		_, err := io.WriteString(w, "response never read")
		written <- err
	})}
	response, err := transport.RoundTrip(localRequest(t, context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	select {
	case err := <-written:
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("write error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("write deadline did not stop blocked write")
	}
}

func TestInProcessIdentifiesOnlyEmbeddedClients(t *testing.T) {
	if !NewLocalClient(http.NotFoundHandler(), "token").InProcess() {
		t.Fatal("local client must report in-process")
	}
	if !NewLocalClientWithStagingEndpoint(http.NotFoundHandler(), "token", "http://127.0.0.1:1", false).InProcess() {
		t.Fatal("local staging client must report in-process")
	}
	if NewClient(&StaticStorageSetResolver{URL: "http://repo-host:8080"}, "token").InProcess() {
		t.Fatal("remote client must not report in-process")
	}
	var missing *Client
	if missing.InProcess() {
		t.Fatal("nil client must not report in-process")
	}
}

// The doors in front of an engine read its install fact from the client, so
// only the engine's own configuration turns the install main policy on.
func TestInstallMainMirrorIsTheEngineFact(t *testing.T) {
	if !NewLocalClientWithStagingEndpoint(http.NotFoundHandler(), "token", "http://127.0.0.1:1", true).InstallMainMirror() {
		t.Fatal("an install engine's client must report the install main policy")
	}
	for name, client := range map[string]*Client{
		"hosted local": NewLocalClientWithStagingEndpoint(http.NotFoundHandler(), "token", "http://127.0.0.1:1", false),
		"embedded":     NewLocalClient(http.NotFoundHandler(), "token"),
		"remote":       NewClient(&StaticStorageSetResolver{URL: "http://repo-host:8080"}, "token"),
		"nil":          nil,
	} {
		if client.InstallMainMirror() {
			t.Fatalf("%s client must not report the install main policy", name)
		}
	}
}
