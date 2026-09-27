package repohost

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func cursorForPage(page, perPage int) string {
	if page <= 1 || perPage <= 0 {
		return ""
	}
	return fmt.Sprintf("%d", (page-1)*perPage)
}

func TestClient_Health_Success(t *testing.T) {
	t.Parallel()

	var capturedPath string
	var capturedMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.EscapedPath()
		capturedMethod = r.Method
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.Health(context.Background(), server.URL)
	require.NoError(t, err)

	assert.Equal(t, "/health", capturedPath)
	assert.Equal(t, http.MethodGet, capturedMethod)
}

func TestClient_Health_Non2xxReturnsStatusError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("repo-host unavailable"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.Health(context.Background(), server.URL)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "502")
	assert.NotContains(t, err.Error(), "repo-host unavailable")
}

func TestClient_InitRepo_SendsAutoInitOptions(t *testing.T) {
	t.Parallel()

	var capturedPath string
	var capturedMethod string
	var capturedBody initRepoRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.EscapedPath()
		capturedMethod = r.Method
		require.NoError(t, json.NewDecoder(r.Body).Decode(&capturedBody))
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.InitRepo(context.Background(), "alice", "demo", "trunk", true)
	require.NoError(t, err)

	assert.Equal(t, "/repos/init", capturedPath)
	assert.Equal(t, http.MethodPost, capturedMethod)
	assert.Equal(t, initRepoRequest{
		Owner:           "alice",
		Repo:            "demo",
		AutoInit:        true,
		DefaultBookmark: "trunk",
		RepoName:        "demo",
	}, capturedBody)
}

func TestClient_ImportRefs_Success(t *testing.T) {
	t.Parallel()

	var capturedPath string
	var capturedMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.EscapedPath()
		capturedMethod = r.Method
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.ImportRefs(context.Background(), "alice", "demo")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice/demo/git/import-refs", capturedPath)
	assert.Equal(t, http.MethodPost, capturedMethod)
}

func TestClient_ImportRefs_Non2xxReturnsStatusError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("missing"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.ImportRefs(context.Background(), "alice", "demo")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "404")
	assert.NotContains(t, err.Error(), "missing")
}

func TestClient_ProxyReceivePack_StreamsRequestAndResponse(t *testing.T) {
	t.Parallel()

	var capturedPath string
	var capturedBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path

		var err error
		capturedBody, err = io.ReadAll(r.Body)
		require.NoError(t, err)

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("receive-pack-response"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	stdout := &bytes.Buffer{}
	err := client.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		bytes.NewBufferString("receive-pack-request"),
		stdout,
	)
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice/demo/git/receive-pack", capturedPath)
	assert.Equal(t, "receive-pack-request", string(capturedBody))
	assert.Equal(t, "receive-pack-response", stdout.String())
}

func TestClient_ProxyUploadPack_StreamsRequestAndResponse(t *testing.T) {
	t.Parallel()

	var capturedPath string
	var capturedBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path

		var err error
		capturedBody, err = io.ReadAll(r.Body)
		require.NoError(t, err)

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("upload-pack-response"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	stdout := &bytes.Buffer{}
	err := client.ProxyUploadPack(
		context.Background(),
		"alice",
		"demo",
		bytes.NewBufferString("upload-pack-request"),
		stdout,
	)
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice/demo/git/upload-pack", capturedPath)
	assert.Equal(t, "upload-pack-request", string(capturedBody))
	assert.Equal(t, "upload-pack-response", stdout.String())
}

func TestClient_ProxyGitRPC_Non200IncludesStatusAndBody(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("repo-host unavailable"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		bytes.NewBufferString("receive-pack-request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "502")
	assert.NotContains(t, err.Error(), "repo-host unavailable")
}

func TestClient_InfoRefs_StreamsResponseAndReturnsContentType(t *testing.T) {
	t.Parallel()

	var capturedPath string
	var capturedService string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedService = r.URL.Query().Get("service")
		w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("001e# service=git-upload-pack\n0000"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	stdout := &bytes.Buffer{}

	contentType, err := client.InfoRefs(
		context.Background(),
		"alice",
		"demo",
		"git-upload-pack",
		stdout,
	)
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice/demo/git/info-refs", capturedPath)
	assert.Equal(t, "git-upload-pack", capturedService)
	assert.Equal(t, "application/x-git-upload-pack-advertisement", contentType)
	assert.Equal(t, "001e# service=git-upload-pack\n0000", stdout.String())
}

func TestClient_InfoRefs_Non2xxIncludesStatusAndBody(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("repo-host unavailable"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, err := client.InfoRefs(
		context.Background(),
		"alice",
		"demo",
		"git-upload-pack",
		io.Discard,
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "502")
	assert.NotContains(t, err.Error(), "repo-host unavailable")
}

func TestClient_ProxyUploadPack_EscapesOwnerAndRepoPathSegments(t *testing.T) {
	t.Parallel()

	var capturedEscapedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedEscapedPath = r.URL.EscapedPath()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.ProxyUploadPack(
		context.Background(),
		"alice/team",
		"demo",
		bytes.NewBufferString("upload-pack-request"),
		io.Discard,
	)
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice%2Fteam/demo/git/upload-pack", capturedEscapedPath)
}

func TestClient_InfoRefs_EscapesOwnerAndRepoPathSegments(t *testing.T) {
	t.Parallel()

	var capturedEscapedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedEscapedPath = r.URL.EscapedPath()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, err := client.InfoRefs(
		context.Background(),
		"alice/team",
		"demo",
		"git-upload-pack",
		io.Discard,
	)
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice%2Fteam/demo/git/info-refs", capturedEscapedPath)
}

func TestClient_ProxyGitRPC_ErrorMessageDoesNotIncludeLargeUpstreamBody(t *testing.T) {
	t.Parallel()

	upstreamBody := strings.Repeat("x", 8192)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(upstreamBody))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		bytes.NewBufferString("receive-pack-request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Less(t, len(err.Error()), 256)
	assert.NotContains(t, err.Error(), "xxxxxxxxxxxxxxxx")
}

func TestClient_ListOperations_ParsesISO8601Timestamp(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodGet, r.Method)
		require.Equal(t, "/repos/alice:demo/operations", r.URL.EscapedPath())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{
					"operation_id": "op-1",
					"description":  "bookmark create main",
					"timestamp":    "2024-01-01T00:00:01Z",
				},
			},
			"total_count": int64(1),
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	ops, _, err := client.ListOperations(context.Background(), "alice", "demo", cursorForPage(1, 30), 30)
	require.NoError(t, err)
	require.Len(t, ops, 1)
	assert.Equal(t, "2024-01-01T00:00:01Z", ops[0].Timestamp)
	_, err = time.Parse(time.RFC3339, ops[0].Timestamp)
	require.NoError(t, err)
}

func TestClient_ListBookmarks_ForwardsPaginationAndParsesTotalCount(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotPage string
	var gotPerPage string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		require.Equal(t, http.MethodGet, r.Method)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{
					"name":               "main",
					"target_change_id":   "chg-1",
					"target_commit_id":   "commit-1",
					"is_tracking_remote": true,
				},
			},
			"total_count": int64(11),
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	bookmarks, nextCursor, err := client.ListBookmarks(context.Background(), "alice", "demo", cursorForPage(3, 15), 15)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/bookmarks", gotPath)
	assert.Equal(t, "3", gotPage)
	assert.Equal(t, "15", gotPerPage)
	require.Len(t, bookmarks, 1)
	assert.Equal(t, "main", bookmarks[0].Name)
	assert.Empty(t, nextCursor)
}

// The repo-host server never returns next_cursor — the ONLY thing that lets a
// caller walk past the first page is the client-side synthesized offset cursor
// in doJSONPaginated (len(items)==limit && offset+limit < total_count). This
// walk is load-bearing for github_import's default-branch lookup on mirrors
// with >100 bookmarks; keep it covered end to end against a paging server.
func TestClient_ListBookmarks_SynthesizedOffsetCursorWalksAllPages(t *testing.T) {
	t.Parallel()

	const total = 228
	names := make([]string, 0, total)
	for i := range 190 {
		names = append(names, fmt.Sprintf("codex/branch-%03d", i))
	}
	names = append(names, "main")
	for i := range total - 191 {
		names = append(names, fmt.Sprintf("wip/branch-%03d", i))
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
		// Mirror the production router: per_page above 100 is a 400, not a
		// silent clamp. A client that ever asks for more must fail loudly here.
		if perPage < 1 || perPage > 100 || page < 1 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		start := min((page-1)*perPage, len(names))
		end := min(start+perPage, len(names))
		items := make([]map[string]any, 0, end-start)
		for _, name := range names[start:end] {
			items = append(items, map[string]any{
				"name":             name,
				"target_change_id": "chg-" + name,
				"target_commit_id": "commit-" + name,
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "total_count": int64(total)})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")

	var seen []string
	cursor := ""
	nexts := []string{}
	for {
		bookmarks, next, err := client.ListBookmarks(context.Background(), "alice", "demo", cursor, 100)
		require.NoError(t, err)
		for _, b := range bookmarks {
			seen = append(seen, b.Name)
		}
		nexts = append(nexts, next)
		if next == "" {
			break
		}
		cursor = next
	}

	assert.Equal(t, []string{"100", "200", ""}, nexts)
	require.Len(t, seen, total)
	assert.Equal(t, "main", seen[190])
}

func TestClient_ListChanges_ForwardsPaginationAndParsesTotalCount(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotPage string
	var gotPerPage string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		require.Equal(t, http.MethodGet, r.Method)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{
					"change_id":         "chg-abc123",
					"commit_id":         "commit-sha1",
					"parent_commit_id":  "parent-commit-sha",
					"description":       "Add feature",
					"author_name":       "Alice",
					"author_email":      "alice@example.com",
					"timestamp":         "2024-01-02T00:00:00Z",
					"has_conflict":      false,
					"is_empty":          false,
					"parent_change_ids": []string{"chg-parent"},
				},
			},
			"total_count": int64(23),
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	changes, nextCursor, err := client.ListChanges(context.Background(), "alice", "demo", cursorForPage(2, 20), 20)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/changes", gotPath)
	assert.Equal(t, "2", gotPage)
	assert.Equal(t, "20", gotPerPage)
	require.Len(t, changes, 1)
	assert.Equal(t, "chg-abc123", changes[0].ChangeID)
	assert.Equal(t, "parent-commit-sha", changes[0].ParentCommitID)
	assert.Empty(t, nextCursor)
}

func TestClient_ListOperations_ForwardsPaginationAndParsesTotalCount(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotPage string
	var gotPerPage string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		require.Equal(t, http.MethodGet, r.Method)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{
					"operation_id": "op-1",
					"description":  "bookmark create main",
					"timestamp":    "2024-01-01T00:00:01Z",
				},
			},
			"total_count": int64(9),
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	ops, nextCursor, err := client.ListOperations(context.Background(), "alice", "demo", cursorForPage(4, 5), 5)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/operations", gotPath)
	assert.Equal(t, "4", gotPage)
	assert.Equal(t, "5", gotPerPage)
	require.Len(t, ops, 1)
	assert.Equal(t, "op-1", ops[0].OperationID)
	assert.Empty(t, nextCursor)
}

func TestClient_ProxyReceivePack_SendsPushMetadataHeaders(t *testing.T) {
	t.Parallel()

	var capturedHeaders http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeaders = r.Header
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	meta := ReceivePackMetadata{
		RefName:      "refs/heads/main",
		CommitSHA:    "abc123def456",
		PusherID:     42,
		PusherLogin:  "alice",
		AllowedPaths: []string{"src/**", "README.md"},

		PusherCredential: middleware.CredentialAgentRun,
	}

	err := client.ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewReader(nil), io.Discard, meta)
	require.NoError(t, err)
	assert.Equal(t, "run", capturedHeaders.Get(PusherCredentialHeader))

	assert.Equal(t, "refs/heads/main", capturedHeaders.Get("X-Smithers-Push-Ref"))
	assert.Equal(t, "abc123def456", capturedHeaders.Get("X-Smithers-Push-Commit-Sha"))
	assert.Equal(t, "42", capturedHeaders.Get("X-Smithers-Pusher-Id"))
	assert.Equal(t, "alice", capturedHeaders.Get("X-Smithers-Pusher-Login"))
	encodedPaths, decodeErr := base64.RawURLEncoding.DecodeString(capturedHeaders.Get("X-Smithers-Allowed-Paths"))
	require.NoError(t, decodeErr)
	assert.JSONEq(t, `["src/**","README.md"]`, string(encodedPaths))
}

func TestClient_ProxyReceivePack_PeeksPktLineWhenNoMetadataGiven(t *testing.T) {
	t.Parallel()

	var capturedHeaders http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeaders = r.Header
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(server.Close)

	// Simulate a receive-pack pkt-line stream
	payload := "0000000000000000000000000000000000000000 deadbeefcafebabedeadbeefcafebabedeadbeef refs/heads/feature\x00report-status"
	pktLine := fmt.Sprintf("%04x%s", len(payload)+4, payload)
	stdin := bytes.NewReader([]byte(pktLine))

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.ProxyReceivePack(context.Background(), "alice", "demo", stdin, io.Discard)
	require.NoError(t, err)

	// Should have extracted ref and commit from pkt-line
	assert.Equal(t, "refs/heads/feature", capturedHeaders.Get("X-Smithers-Push-Ref"))
	assert.Equal(t, "deadbeefcafebabedeadbeefcafebabedeadbeef", capturedHeaders.Get("X-Smithers-Push-Commit-Sha"))
	// No pusher metadata provided, so these should be empty or absent
	assert.Equal(t, "", capturedHeaders.Get("X-Smithers-Pusher-Id"))
	assert.Equal(t, "", capturedHeaders.Get("X-Smithers-Pusher-Login"))
}

func TestClient_ProxyReceivePack_ShallowPreservesBodyAndMetadata(t *testing.T) {
	t.Parallel()
	const oid = "340ecc0ee56893ec516de12e72468ffe9a2886f0"
	const newOID = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	input := pktlineCovPacket("shallow "+oid+"\n") +
		pktlineCovPacket(oid+" "+newOID+" refs/heads/main\x00report-status") + "0000PACK\x00\xff"
	var capturedHeaders http.Header
	var capturedBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeaders = r.Header
		var err error
		capturedBody, err = io.ReadAll(r.Body)
		assert.NoError(t, err)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString(input), io.Discard,
		ReceivePackMetadata{PusherID: 42, PusherLogin: "alice"})
	require.NoError(t, err)
	assert.Equal(t, input, string(capturedBody))
	assert.Equal(t, "refs/heads/main", capturedHeaders.Get("X-Smithers-Push-Ref"))
	assert.Equal(t, newOID, capturedHeaders.Get("X-Smithers-Push-Commit-Sha"))
	assert.Equal(t, "42", capturedHeaders.Get("X-Smithers-Pusher-Id"))
	assert.Equal(t, "alice", capturedHeaders.Get("X-Smithers-Pusher-Login"))
}

func TestClient_ProxyReceivePack_ZeroPusherIDNotForwarded(t *testing.T) {
	t.Parallel()

	var capturedHeaders http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeaders = r.Header
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	meta := ReceivePackMetadata{
		RefName:     "refs/heads/main",
		CommitSHA:   "abc123",
		PusherID:    0, // Zero ID should not be forwarded
		PusherLogin: "alice",
	}

	err := client.ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewReader(nil), io.Discard, meta)
	require.NoError(t, err)

	assert.Equal(t, "refs/heads/main", capturedHeaders.Get("X-Smithers-Push-Ref"))
	assert.Equal(t, "abc123", capturedHeaders.Get("X-Smithers-Push-Commit-Sha"))
	// Zero PusherID should not set the header
	assert.Equal(t, "", capturedHeaders.Get("X-Smithers-Pusher-Id"))
	assert.Equal(t, "alice", capturedHeaders.Get("X-Smithers-Pusher-Login"))
}
