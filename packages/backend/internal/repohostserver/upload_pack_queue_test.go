package repohostserver

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

// Use TCP rather than a manually cancelled request context: net/http only
// discovers a peer disconnect after it finishes reading the negotiation body.
func TestUploadPackHTTPQueuedDisconnectReleasesWaiter(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1})
	h.request("active", "want", 4)
	h.waitStarts(1)
	queued := h.request("queued", "want", 4)
	require.NoError(t, queued.Close())
	h.waitDone("queued", time.Second)
	require.Equal(t, 1, h.starts(), "a disconnected waiter must never launch git")
	select {
	case <-h.done["active"]:
		t.Fatal("the running upload-pack ended before its pack was released")
	default:
	}
	h.releasePacks()
	h.waitDone("active", 5*time.Second)
}

func TestUploadPackHTTPRefSyncDoesNotOccupyProcessSlots(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{
		MaxConcurrentUploadPacks: 2, MaxQueuedUploadPacks: 2, UploadPackQueueTimeout: 10 * time.Second,
	})
	h.repohost.refExports.forget(h.repohost.config.RepoPath("alice", "active"))
	unlock, err := h.repohost.locks.Lock(context.Background(), h.repohost.config.RepoPath("alice", "active"))
	require.NoError(t, err)
	defer unlock()
	first := h.request("active", "want", 4)
	second := h.request("active", "want", 4)
	h.waitRepoRefs("active", 3)
	other := h.request("queued", "want", 4)
	require.Eventually(t, func() bool { return h.starts() == 1 }, time.Second, 10*time.Millisecond,
		"fetches waiting for one repository's writer must leave git slots available to other repositories")
	require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_waiting 2\n")
	require.NoError(t, first.Close())
	require.NoError(t, second.Close())
	h.waitDone("active", time.Second)
	h.waitDone("active", time.Second)
	h.waitRepoRefs("active", 1)
	h.releasePacks()
	status, body, _ := h.response(other)
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, "PACK", body)
	h.waitAdmissions(0)
}

func TestUploadPackHTTPRefSyncWaitIsBoundedAndCancelable(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		name := "timeout"
		if disconnect {
			name = "disconnect"
		}
		t.Run(name, func(t *testing.T) {
			h := newUploadPackQueueHTTPHarness(t, Config{
				MaxConcurrentUploadPacks: 1, MaxQueuedUploadPacks: 1, UploadPackQueueTimeout: 500 * time.Millisecond,
			})
			h.repohost.refExports.forget(h.repohost.config.RepoPath("alice", "active"))
			unlock, err := h.repohost.locks.Lock(context.Background(), h.repohost.config.RepoPath("alice", "active"))
			require.NoError(t, err)
			defer unlock()
			blocked := h.request("active", "want", 4)
			h.waitRepoRefs("active", 2)
			if disconnect {
				require.NoError(t, blocked.Close())
				h.waitDone("active", time.Second)
			} else {
				require.NoError(t, blocked.SetReadDeadline(time.Now().Add(time.Second)))
				response, err := http.ReadResponse(bufio.NewReader(blocked), nil)
				require.NoError(t, err, "the queue deadline must also bound ref-sync lock waiting")
				defer response.Body.Close()
				require.Equal(t, http.StatusServiceUnavailable, response.StatusCode)
				require.Equal(t, "1", response.Header.Get("Retry-After"))
			}
			h.waitAdmissions(0)
			h.waitRepoRefs("active", 1)
			require.Zero(t, h.starts())
			require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_waiting 0\n")
			require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_rejected_total{reason=\"ended\"} 1\n")
			h.releasePacks()
			recovery := h.request("recovery", "want", 4)
			status, body, _ := h.response(recovery)
			require.Equal(t, http.StatusOK, status)
			require.Equal(t, "PACK", body)
		})
	}
}

func TestUploadPackHTTPProgressingStreamOutlivesReadIdleTimeout(t *testing.T) {
	previous := gitRPCIdleTimeout
	gitRPCIdleTimeout = 250 * time.Millisecond
	t.Cleanup(func() { gitRPCIdleTimeout = previous })
	h := newUploadPackQueueHTTPHarnessWithOutput(t, Config{MaxConcurrentUploadPacks: 1}, `i=0
while [ "$i" -lt 12 ]; do
  dd if=/dev/zero bs=8192 count=1 2>/dev/null
  sleep 0.08
  i=$((i+1))
done
printf FINISHED`)
	h.releasePacks()
	conn := h.request("active", "want", 4)
	status, body, _ := h.response(conn)
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, 12*8192+len("FINISHED"), len(body),
		"a progressing response must not inherit a socket read deadline from its buffered negotiation")
	require.True(t, strings.HasSuffix(body, "FINISHED"))
	require.Equal(t, 12*8192, strings.Count(body, "\x00"))
	h.waitAdmissions(0)
}

func TestUploadPackHTTPRefSyncCachedReadLockWaitIsBounded(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1, UploadPackQueueTimeout: 500 * time.Millisecond})
	repoPath := h.repohost.config.RepoPath("alice", "active")
	h.repohost.refExports.record(repoPath, jjOperationHead(repoPath))
	unlock, err := h.repohost.locks.Lock(context.Background(), repoPath)
	require.NoError(t, err)
	defer unlock()
	blocked := h.request("active", "want", 4)
	h.waitRepoRefs("active", 2)
	require.NoError(t, blocked.SetReadDeadline(time.Now().Add(time.Second)))
	response, err := http.ReadResponse(bufio.NewReader(blocked), nil)
	require.NoError(t, err, "the queue deadline must also bound the post-slot read lock")
	defer response.Body.Close()
	require.Equal(t, http.StatusServiceUnavailable, response.StatusCode)
	require.Equal(t, "1", response.Header.Get("Retry-After"))
	h.waitAdmissions(0)
	h.waitRepoRefs("active", 1)
	require.Zero(t, h.starts())
	h.releasePacks()
	recovery := h.request("recovery", "want", 4)
	status, body, _ := h.response(recovery)
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, "PACK", body)
	require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_rejected_total{reason=\"ended\"} 1\n")
}

func TestUploadPackHTTPQueueRejectionClosesIncompleteConnection(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{
		MaxConcurrentUploadPacks: 1, MaxQueuedUploadPacks: 1, UploadPackQueueTimeout: 5 * time.Second,
	})
	h.request("active", "want", 4)
	h.waitStarts(1)
	queued := h.request("queued", "w", 4)
	h.waitAdmissions(2)
	overflow := h.request("overflow", "", 16)
	require.NoError(t, overflow.SetReadDeadline(time.Now().Add(time.Second)))
	reader := bufio.NewReader(overflow)
	response, err := http.ReadResponse(reader, nil)
	require.NoError(t, err)
	require.Equal(t, http.StatusServiceUnavailable, response.StatusCode)
	require.Equal(t, "1", response.Header.Get("Retry-After"))
	_, err = io.ReadAll(response.Body)
	require.NoError(t, err)
	_, err = reader.ReadByte()
	require.ErrorIs(t, err, io.EOF, "the server must close a rejected socket without waiting for the missing body")
	require.NoError(t, queued.Close())
	h.waitDone("queued", time.Second)
}

func TestUploadPackHTTPNegotiationProtocols(t *testing.T) {
	for _, protocol := range []string{"chunked", "100-continue"} {
		t.Run(protocol, func(t *testing.T) {
			h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1})
			h.releasePacks()
			var conn net.Conn
			var reader *bufio.Reader
			if protocol == "chunked" {
				conn = h.requestHeaders("active", "Transfer-Encoding: chunked\r\n", "4\r\nwant\r\n0\r\n\r\n")
				reader = bufio.NewReader(conn)
			} else {
				conn = h.requestHeaders("active", "Content-Length: 4\r\nExpect: 100-continue\r\n", "")
				reader = bufio.NewReader(conn)
				require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
				interim, err := http.ReadResponse(reader, nil)
				require.NoError(t, err)
				require.Equal(t, http.StatusContinue, interim.StatusCode)
				_, err = io.WriteString(conn, "want")
				require.NoError(t, err)
			}
			require.NoError(t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
			response, err := http.ReadResponse(reader, nil)
			require.NoError(t, err)
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.Equal(t, http.StatusOK, response.StatusCode)
			require.Equal(t, "PACK", string(body))
			require.Equal(t, 1, h.starts())
			h.waitAdmissions(0)
		})
	}
}

func TestUploadPackHTTPKeepaliveAfterSuccessAndQueueTimeout(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		name := "success"
		if timeout {
			name = "queue timeout"
		}
		t.Run(name, func(t *testing.T) {
			h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1, UploadPackQueueTimeout: 500 * time.Millisecond})
			if timeout {
				h.request("active", "want", 4)
				h.waitStarts(1)
			} else {
				h.releasePacks()
			}
			conn := h.request("queued", "want", 4)
			reader := bufio.NewReader(conn)
			require.NoError(t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
			response, err := http.ReadResponse(reader, nil)
			require.NoError(t, err)
			_, err = io.ReadAll(response.Body)
			require.NoError(t, err)
			require.False(t, response.Close)
			if timeout {
				require.Equal(t, http.StatusServiceUnavailable, response.StatusCode)
				require.Equal(t, "1", response.Header.Get("Retry-After"))
			} else {
				require.Equal(t, http.StatusOK, response.StatusCode)
			}
			h.releasePacks()
			_, err = fmt.Fprintf(conn, "POST /repos/alice/recovery/git/upload-pack HTTP/1.1\r\nHost: localhost\r\nAuthorization: %s\r\nContent-Length: 4\r\n\r\nwant", validAuth())
			require.NoError(t, err)
			response, err = http.ReadResponse(reader, nil)
			require.NoError(t, err, "the same TCP connection must remain reusable after a complete negotiation")
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.Equal(t, http.StatusOK, response.StatusCode)
			require.Equal(t, "PACK", string(body))
		})
	}
}

func TestUploadPackHTTPMetricsExistBeforeFirstRejection(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{})
	metrics := h.metrics()
	for _, reason := range []string{"body", "full", "ended"} {
		require.Contains(t, metrics, "smithers_repo_host_upload_pack_rejected_total{reason=\""+reason+"\"} 0\n")
	}
	require.Contains(t, metrics, "smithers_repo_host_upload_pack_wait_seconds_bucket{le=\"30\"} 0\n")
}

func TestUploadPackHTTPRefExportFailureReleasesAdmission(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1})
	h.repohost.refExports.forget(h.repohost.config.RepoPath("alice", "queued"))
	h.repohost.ffi.(*mockFFI).exportGitRefsFn = func(string) error { return errors.New("ref export failed") }
	conn := h.request("queued", "want", 4)
	status, _, _ := h.response(conn)
	require.Equal(t, http.StatusInternalServerError, status)
	h.waitAdmissions(0)
	require.Zero(t, h.starts())
	require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_waiting 0\n")
	h.repohost.ffi.(*mockFFI).exportGitRefsFn = nil
	h.releasePacks()
	recovery := h.request("recovery", "want", 4)
	status, body, _ := h.response(recovery)
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, "PACK", body)
}

func TestUploadPackHTTPSlowReaderReleasesProcessSlot(t *testing.T) {
	previous := gitRPCIdleTimeout
	gitRPCIdleTimeout = 800 * time.Millisecond
	t.Cleanup(func() { gitRPCIdleTimeout = previous })
	h := newUploadPackQueueHTTPHarnessWithOutput(t, Config{
		MaxConcurrentUploadPacks: 1, MaxQueuedUploadPacks: 1, UploadPackQueueTimeout: 5 * time.Second,
	}, `case "$3" in
*/active/.jj/repo/store/git) cat /dev/zero ;;
*) printf PACK ;;
esac`)
	active := h.request("active", "want", 4)
	h.waitStarts(1)
	h.releasePacks()
	require.NoError(t, active.SetReadDeadline(time.Now().Add(5*time.Second)))
	response, err := http.ReadResponse(bufio.NewReader(active), nil)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	// Leave the live TCP connection open without draining its response body.
	queued := h.request("queued", "want", 4)
	h.waitAdmissions(2)
	require.Equal(t, 1, h.starts(), "a stalled response must keep its process slot until terminated")
	h.waitDone("active", 5*time.Second)
	status, body, _ := h.response(queued)
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, "PACK", body)
	require.Equal(t, 2, h.starts(), "the next repository must run after the stalled writer exits")
	h.waitAdmissions(0)
}

func TestUploadPackHTTPBoundsWaitingAcrossRepositories(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{
		MaxConcurrentUploadPacks: 2, MaxQueuedUploadPacks: 1, UploadPackQueueTimeout: 10 * time.Second,
	})
	first := h.request("active", "want", 4)
	second := h.request("active-two", "want", 4)
	h.waitStarts(2)
	queued := h.request("queued", "want", 4)
	h.waitAdmissions(3)
	require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_waiting 1\n")
	overflow := h.request("overflow", "want", 4)
	status, _, headers := h.response(overflow)
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.Equal(t, "1", headers.Get("Retry-After"))
	require.Equal(t, repohost.UploadPackQueueFullCode, headers.Get("X-Smithers-Error-Code"))
	require.Equal(t, 2, h.starts(), "waiting and rejected requests must not launch git")
	require.NoError(t, queued.Close())
	h.waitDone("queued", time.Second)
	h.waitAdmissions(2)
	recovery := h.request("recovery", "want", 4)
	h.waitAdmissions(3)
	h.releasePacks()
	for _, conn := range []net.Conn{first, second, recovery} {
		status, body, _ := h.response(conn)
		require.Equal(t, http.StatusOK, status)
		require.Equal(t, "PACK", body)
	}
	require.Equal(t, 3, h.starts(), "the reclaimed waiting position must admit a new request")
	h.waitAdmissions(0)
	metrics := h.metrics()
	require.Contains(t, metrics, "smithers_repo_host_upload_pack_waiting 0\n")
	require.Contains(t, metrics, "smithers_repo_host_upload_pack_wait_seconds_count 4\n")
	require.Contains(t, metrics, "smithers_repo_host_upload_pack_rejected_total{reason=\"full\"} 1\n")
	require.Contains(t, metrics, "smithers_repo_host_upload_pack_rejected_total{reason=\"ended\"} 1\n")
}

func TestUploadPackHTTPQueueTimeoutReleasesAdmission(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{
		MaxConcurrentUploadPacks: 1, MaxQueuedUploadPacks: 1, UploadPackQueueTimeout: 500 * time.Millisecond,
	})
	active := h.request("active", "want", 4)
	h.waitStarts(1)
	queued := h.request("queued", "want", 4)
	status, _, headers := h.response(queued)
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.Equal(t, repohost.UploadPackQueueTimeoutCode, headers.Get("X-Smithers-Error-Code"))
	require.Equal(t, "1", headers.Get("Retry-After"))
	require.Equal(t, 1, h.starts(), "a timed-out waiter must never launch git")
	h.waitAdmissions(1)
	recovery := h.request("recovery", "want", 4)
	h.waitAdmissions(2)
	h.releasePacks()
	for _, conn := range []net.Conn{active, recovery} {
		status, body, _ := h.response(conn)
		require.Equal(t, http.StatusOK, status)
		require.Equal(t, "PACK", body)
	}
	h.waitAdmissions(0)
	require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_rejected_total{reason=\"ended\"} 1\n")
}

func TestUploadPackHTTPNegotiationReadIsBoundedAndDisconnectable(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		name := "read timeout"
		if disconnect {
			name = "disconnect"
		}
		t.Run(name, func(t *testing.T) {
			h := newUploadPackQueueHTTPHarness(t, Config{
				MaxConcurrentUploadPacks: 1, MaxQueuedUploadPacks: 1, UploadPackQueueTimeout: 500 * time.Millisecond,
			})
			active := h.request("active", "want", 4)
			h.waitStarts(1)
			// This client sends only one of its declared four body bytes.
			stalled := h.request("queued", "w", 4)
			h.waitAdmissions(2)
			overflow := h.request("overflow", "want", 4)
			status, _, _ := h.response(overflow)
			require.Equal(t, http.StatusServiceUnavailable, status, "body readers must also count against admission")
			if disconnect {
				require.NoError(t, stalled.Close())
				h.waitDone("queued", time.Second)
			} else {
				status, _, _ = h.response(stalled)
				require.Equal(t, http.StatusServiceUnavailable, status)
			}
			h.waitAdmissions(1)
			require.Equal(t, 1, h.starts())
			recovery := h.request("recovery", "want", 4)
			h.waitAdmissions(2)
			h.releasePacks()
			for _, conn := range []net.Conn{active, recovery} {
				status, body, _ := h.response(conn)
				require.Equal(t, http.StatusOK, status)
				require.Equal(t, "PACK", body)
			}
			h.waitAdmissions(0)
			require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_waiting 0\n")
		})
	}
}

func TestUploadPackHTTPRejectsOversizedNegotiationBeforeGit(t *testing.T) {
	for _, encoding := range []string{"", "gzip"} {
		name := "plain"
		if encoding != "" {
			name = encoding
		}
		t.Run(name, func(t *testing.T) {
			h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1})
			body := strings.Repeat("w", (10<<20)+1)
			if encoding == "gzip" {
				var compressed bytes.Buffer
				writer := gzip.NewWriter(&compressed)
				_, err := writer.Write([]byte(body))
				require.NoError(t, err)
				require.NoError(t, writer.Close())
				body = compressed.String()
			}
			oversized := h.requestEncoded("oversized", body, len(body), encoding)
			status, _, headers := h.response(oversized)
			require.Equal(t, http.StatusRequestEntityTooLarge, status)
			require.Equal(t, repohost.UploadPackNegotiationTooLargeCode, headers.Get("X-Smithers-Error-Code"))
			require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_rejected_total{reason=\"body\"} 1\n")
			require.Zero(t, h.starts())
			h.waitAdmissions(0)
			h.releasePacks()
			recovery := h.request("recovery", "want", 4)
			status, body, _ = h.response(recovery)
			require.Equal(t, http.StatusOK, status)
			require.Equal(t, "PACK", body)
		})
	}
}

func TestUploadPackHTTPMalformedGzipReleasesAdmission(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1, MaxQueuedUploadPacks: 1})
	malformed := h.requestEncoded("queued", "not gzip", len("not gzip"), "gzip")
	status, _, _ := h.response(malformed)
	require.Equal(t, http.StatusBadRequest, status)
	h.waitAdmissions(0)
	require.Zero(t, h.starts())
	require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_rejected_total{reason=\"body\"} 1\n")
	h.releasePacks()
	recovery := h.request("recovery", "want", 4)
	status, body, _ := h.response(recovery)
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, "PACK", body)
}

func TestUploadPackHTTPRejectedPartialBodiesRespondPromptly(t *testing.T) {
	for _, tc := range []struct {
		name     string
		body     string
		encoding string
		status   int
		timeout  time.Duration
	}{
		{name: "malformed gzip", body: "not gzip!!", encoding: "gzip", status: http.StatusBadRequest, timeout: 5 * time.Second},
		{name: "oversized negotiation", body: "wants", status: http.StatusRequestEntityTooLarge, timeout: 5 * time.Second},
		{name: "stalled gzip header", body: "\x1f\x8b", encoding: "gzip", status: http.StatusServiceUnavailable, timeout: 500 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1, MaxGitRequestBytes: 4, UploadPackQueueTimeout: tc.timeout})
			// The error is knowable from this prefix; the peer never sends the rest.
			conn := h.requestEncoded("queued", tc.body, 16, tc.encoding)
			require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			require.NoError(t, err, "rejecting a known-invalid prefix must not wait to drain the missing body")
			defer response.Body.Close()
			require.Equal(t, tc.status, response.StatusCode)
			require.True(t, response.Close, "a rejected partial body cannot reuse its HTTP connection")
			_, err = io.ReadAll(response.Body)
			require.NoError(t, err)
			_, err = reader.ReadByte()
			require.ErrorIs(t, err, io.EOF, "the server must finish connection cleanup while the peer remains open")
			h.waitAdmissions(0)
			require.Zero(t, h.starts())
		})
	}
}

func TestUploadPackHTTPInvalidGzipChecksumReleasesAdmission(t *testing.T) {
	h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1})
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, err := writer.Write([]byte("want"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	corrupted := compressed.Bytes()
	corrupted[len(corrupted)-8] ^= 0xff
	conn := h.requestEncoded("queued", string(corrupted), len(corrupted), "gzip")
	status, _, _ := h.response(conn)
	require.Equal(t, http.StatusBadRequest, status)
	require.Zero(t, h.starts())
	h.waitAdmissions(0)
	require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_rejected_total{reason=\"body\"} 1\n")
}

func TestUploadPackHTTPHonorsLowerNegotiationLimit(t *testing.T) {
	for _, encoding := range []string{"", "gzip"} {
		name := "plain"
		if encoding != "" {
			name = encoding
		}
		t.Run(name, func(t *testing.T) {
			h := newUploadPackQueueHTTPHarness(t, Config{MaxConcurrentUploadPacks: 1, MaxGitRequestBytes: 4})
			encode := func(body string) string {
				if encoding == "" {
					return body
				}
				var compressed bytes.Buffer
				writer := gzip.NewWriter(&compressed)
				_, err := writer.Write([]byte(body))
				require.NoError(t, err)
				require.NoError(t, writer.Close())
				return compressed.String()
			}
			h.releasePacks()
			exactBody := encode("want")
			exact := h.requestEncoded("active", exactBody, len(exactBody), encoding)
			status, body, _ := h.response(exact)
			require.Equal(t, http.StatusOK, status)
			require.Equal(t, "PACK", body)
			oversizedBody := encode("wants")
			oversized := h.requestEncoded("oversized", oversizedBody, len(oversizedBody), encoding)
			status, _, _ = h.response(oversized)
			require.Equal(t, http.StatusRequestEntityTooLarge, status)
			require.Equal(t, 1, h.starts())
			h.waitAdmissions(0)
			require.Contains(t, h.metrics(), "smithers_repo_host_upload_pack_rejected_total{reason=\"body\"} 1\n")
		})
	}
}

type uploadPackQueueHTTPHarness struct {
	t           *testing.T
	server      *httptest.Server
	repohost    *Server
	startsFile  string
	releaseFile string
	entered     map[string]chan struct{}
	done        map[string]chan struct{}
}

func newUploadPackQueueHTTPHarness(t *testing.T, cfg Config) *uploadPackQueueHTTPHarness {
	t.Helper()
	return newUploadPackQueueHTTPHarnessWithOutput(t, cfg, "printf PACK")
}

func newUploadPackQueueHTTPHarnessWithOutput(t *testing.T, cfg Config, output string) *uploadPackQueueHTTPHarness {
	t.Helper()
	dir := t.TempDir()
	h := &uploadPackQueueHTTPHarness{
		t:           t,
		startsFile:  filepath.Join(dir, "starts"),
		releaseFile: filepath.Join(dir, "release"),
		entered:     make(map[string]chan struct{}),
		done:        make(map[string]chan struct{}),
	}
	installGitStub(t, `#!/bin/sh
[ "$1" = upload-pack ] || exit 1
cat >/dev/null
echo started >> '`+h.startsFile+`'
while [ ! -e '`+h.releaseFile+`' ]; do sleep 0.02; done
`+output+`
`)
	cfg.StoragePath = t.TempDir()
	cfg.AuthToken = testAuthToken
	srv, err := NewWithFFI(cfg, &mockFFI{})
	require.NoError(t, err)
	h.repohost = srv
	for _, repo := range []string{"active", "active-two", "queued", "queued-two", "overflow", "recovery", "oversized"} {
		require.NoError(t, os.MkdirAll(srv.config.GitBackendPath("alice", repo), 0o755))
		// Ordinary negotiation cases use an unchanged repository. Tests of
		// ref synchronization explicitly invalidate this cache receipt.
		repoPath := srv.config.RepoPath("alice", repo)
		heads := filepath.Join(repoPath, ".jj", "repo", "op_heads", "heads")
		require.NoError(t, os.MkdirAll(heads, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(heads, "initial"), nil, 0o644))
		srv.refExports.record(repoPath, "initial")
		h.entered[repo] = make(chan struct{}, 8)
		h.done[repo] = make(chan struct{}, 8)
	}
	handler := srv.Handler()
	h.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" {
			handler.ServeHTTP(w, r)
			return
		}
		repo := strings.Split(r.URL.Path, "/")[3]
		h.entered[repo] <- struct{}{}
		defer func() { h.done[repo] <- struct{}{} }()
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		h.releasePacks()
		h.server.CloseClientConnections()
		h.server.Close()
	})
	return h
}

func (h *uploadPackQueueHTTPHarness) request(repo, body string, contentLength int) net.Conn {
	h.t.Helper()
	return h.requestEncoded(repo, body, contentLength, "")
}

func (h *uploadPackQueueHTTPHarness) requestEncoded(repo, body string, contentLength int, encoding string) net.Conn {
	h.t.Helper()
	return h.requestHeaders(repo, fmt.Sprintf("Content-Length: %d\r\nContent-Encoding: %s\r\n", contentLength, encoding), body)
}

func (h *uploadPackQueueHTTPHarness) requestHeaders(repo, headers, body string) net.Conn {
	h.t.Helper()
	conn, err := net.DialTimeout("tcp", h.server.Listener.Addr().String(), 5*time.Second)
	require.NoError(h.t, err)
	h.t.Cleanup(func() { _ = conn.Close() })
	require.NoError(h.t, conn.SetWriteDeadline(time.Now().Add(5*time.Second)))
	_, err = fmt.Fprintf(conn, "POST /repos/alice/%s/git/upload-pack HTTP/1.1\r\nHost: localhost\r\nAuthorization: %s\r\n%s\r\n%s", repo, validAuth(), headers, body)
	require.NoError(h.t, err)
	select {
	case <-h.entered[repo]:
	case <-time.After(5 * time.Second):
		h.t.Fatalf("%s never reached the HTTP handler", repo)
	}
	return conn
}

func (h *uploadPackQueueHTTPHarness) response(conn net.Conn) (int, string, http.Header) {
	h.t.Helper()
	require.NoError(h.t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	require.NoError(h.t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(h.t, err)
	return response.StatusCode, string(body), response.Header
}

func (h *uploadPackQueueHTTPHarness) starts() int {
	h.t.Helper()
	raw, err := os.ReadFile(h.startsFile)
	if os.IsNotExist(err) {
		return 0
	}
	require.NoError(h.t, err)
	return strings.Count(string(raw), "started")
}

func (h *uploadPackQueueHTTPHarness) metrics() string {
	h.t.Helper()
	client := h.server.Client()
	client.Timeout = 5 * time.Second
	response, err := client.Get(h.server.URL + "/metrics")
	require.NoError(h.t, err)
	defer response.Body.Close()
	require.Equal(h.t, http.StatusOK, response.StatusCode)
	body, err := io.ReadAll(response.Body)
	require.NoError(h.t, err)
	return string(body)
}

func (h *uploadPackQueueHTTPHarness) waitStarts(n int) {
	h.t.Helper()
	require.Eventually(h.t, func() bool { return h.starts() == n }, 5*time.Second, 10*time.Millisecond)
}

func (h *uploadPackQueueHTTPHarness) waitAdmissions(n int) {
	h.t.Helper()
	require.Eventually(h.t, func() bool { return len(h.repohost.uploadPackQueue.requests) == n }, 5*time.Second, 10*time.Millisecond)
}

func (h *uploadPackQueueHTTPHarness) waitRepoRefs(repo string, n int) {
	h.t.Helper()
	key := h.repohost.config.RepoPath("alice", repo)
	require.Eventually(h.t, func() bool {
		h.repohost.locks.mu.Lock()
		defer h.repohost.locks.mu.Unlock()
		entry := h.repohost.locks.locks[key]
		return entry != nil && entry.refs == n
	}, 5*time.Second, 10*time.Millisecond)
}

func (h *uploadPackQueueHTTPHarness) waitDone(repo string, timeout time.Duration) {
	h.t.Helper()
	select {
	case <-h.done[repo]:
	case <-time.After(timeout):
		h.t.Fatalf("%s HTTP handler did not finish within %s", repo, timeout)
	}
}

func (h *uploadPackQueueHTTPHarness) releasePacks() {
	h.t.Helper()
	require.NoError(h.t, os.WriteFile(h.releaseFile, nil, 0o644))
}
