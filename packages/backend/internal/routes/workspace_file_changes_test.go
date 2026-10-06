package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The recording service tests HTTP decoding/dispatch, not guest atomicity.
type fileBatchRouteService struct {
	mockWorkspaceRouteService
	write func(context.Context, string, int64, int64, []workspaceapi.FileMutation) ([]services.WorkspaceFileMutationResult, error)
}

func (s *fileBatchRouteService) WriteWorkspaceFiles(ctx context.Context, id string, repo, actor int64, changes []workspaceapi.FileMutation) ([]services.WorkspaceFileMutationResult, error) {
	return s.write(ctx, id, repo, actor, changes)
}

func fileBatchRequest(body, query string, authenticated bool) *http.Request {
	r := httptest.NewRequest(http.MethodPut, "/files/content"+query, strings.NewReader(body))
	r = withWorkspaceRepoCtx(withRouteParams(r, map[string]string{"id": "ws-batch"}), "alice", "demo")
	if authenticated {
		r = withAuth(r, 7, "alice")
	}
	return r
}

func TestWorkspaceHandler_FileBatchDispatch(t *testing.T) {
	const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	calls := 0
	h := &WorkspaceHandler{Service: &fileBatchRouteService{write: func(_ context.Context, id string, repo, actor int64, changes []workspaceapi.FileMutation) ([]services.WorkspaceFileMutationResult, error) {
		calls++
		require.Equal(t, "ws-batch", id)
		require.NotZero(t, repo)
		require.Equal(t, int64(7), actor)
		require.Equal(t, []workspaceapi.FileMutation{
			{Path: "old", BaseDigest: digest, Content: nil},
			{Path: "new", BaseDigest: "absent", Content: []byte{0, 255, 128}},
			{Path: "empty", BaseDigest: "absent", Content: []byte{}},
			{Path: " text ", BaseDigest: digest, Content: []byte("é\n")},
		}, changes)
		return []services.WorkspaceFileMutationResult{{Path: "old", Digest: "absent"}, {Path: "empty", Digest: digest}}, nil
	}}}
	r := fileBatchRequest(`{"changes":[{"path":"old","base_digest":"`+digest+`","content":null},{"path":"new","base_digest":"absent","content":"AP+A","encoding":"base64"},{"path":"empty","base_digest":"absent","content":"","encoding":"base64"},{"path":" text ","base_digest":"`+digest+`","content":"é\n","encoding":"utf-8"}]}`, "", true)
	w := httptest.NewRecorder()
	h.WriteWorkspaceFile(w, r)
	require.Equal(t, 200, w.Code, w.Body.String())
	require.JSONEq(t, `{"changes":[{"path":"old","digest":"absent"},{"path":"empty","digest":"`+digest+`"}]}`, w.Body.String())
	require.Equal(t, 1, calls, "one batch dispatch, never per-file writes")
}

func TestWorkspaceHandler_FileBatchRejectsMalformed(t *testing.T) {
	h := &WorkspaceHandler{Service: &fileBatchRouteService{write: func(context.Context, string, int64, int64, []workspaceapi.FileMutation) ([]services.WorkspaceFileMutationResult, error) {
		t.Fatal("invalid input reached service")
		return nil, nil
	}}}
	valid := `{"path":"a","base_digest":"absent","content":""}`
	tooMany := `{"changes":[` + strings.TrimSuffix(strings.Repeat(valid+",", 257), ",") + `]}`
	cases := []struct {
		name, body, query string
		status            int
	}{
		{"null", `{"changes":null}`, "", 400},
		{"empty", `{"changes":[]}`, "", 400},
		{"object", `{"changes":{}}`, "", 400},
		{"limit", tooMany, "", 400},
		{"top actor", `{"changes":[` + valid + `],"actor":"alice"}`, "", 400},
		{"query", `{"changes":[` + valid + `]}`, "?path=", 400},
		{"mixed content", `{"changes":[` + valid + `],"content":null}`, "", 400},
		{"mixed base", `{"changes":[` + valid + `],"base_digest":null}`, "", 400},
		{"mixed encoding", `{"changes":[` + valid + `],"encoding":null}`, "", 400},
		{"missing content", `{"changes":[{"path":"a","base_digest":"absent"}]}`, "", 400},
		{"missing base", `{"changes":[{"path":"a","content":"x"}]}`, "", 400},
		{"null base", `{"changes":[{"path":"a","content":"x","base_digest":null}]}`, "", 400},
		{"upper base", `{"changes":[{"path":"a","content":"x","base_digest":"` + strings.Repeat("A", 64) + `"}]}`, "", 400},
		{"numeric content", `{"changes":[{"path":"a","content":1,"base_digest":"absent"}]}`, "", 400},
		{"null encoding", `{"changes":[{"path":"a","content":"","encoding":null,"base_digest":"absent"}]}`, "", 400},
		{"bad encoding", `{"changes":[{"path":"a","content":"","encoding":"hex","base_digest":"absent"}]}`, "", 400},
		{"deletion encoding", `{"changes":[{"path":"a","content":null,"encoding":"utf-8","base_digest":"absent"}]}`, "", 400},
		{"base64 bad", `{"changes":[{"path":"a","content":"%%%","encoding":"base64","base_digest":"absent"}]}`, "", 400},
		{"base64 padding bits", `{"changes":[{"path":"a","content":"Zh==","encoding":"base64","base_digest":"absent"}]}`, "", 400},
		{"base64 newline", `{"changes":[{"path":"a","content":"Zg==\n","encoding":"base64","base_digest":"absent"}]}`, "", 400},
		{"trailing", `{"changes":[` + valid + `]} {}`, "", 400},
		{"single missing content", `{"base_digest":"absent"}`, "?path=a", 400},
		{"single null content", `{"base_digest":"absent","content":null}`, "?path=a", 400},
		{"single encoding", `{"base_digest":"absent","content":"","encoding":"utf-8"}`, "?path=a", 400},
		{"body limit", `{"changes":[{"path":"a","base_digest":"absent","content":"` + strings.Repeat("a", 1<<20) + `"}]}`, "", 413},
	}
	for _, field := range []string{"actor", "uid", "machine", "branch", "mode", "extra"} {
		cases = append(cases, struct {
			name, body, query string
			status            int
		}{field, `{"changes":[{"path":"a","content":"","base_digest":"absent","` + field + `":0}]}`, "", 400})
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.WriteWorkspaceFile(w, fileBatchRequest(tt.body, tt.query, true))
			require.Equal(t, tt.status, w.Code, w.Body.String())
		})
	}
}

func TestWorkspaceHandler_FileBatchErrors(t *testing.T) {
	body := `{"changes":[{"path":"later","content":"x","base_digest":"absent"}]}`
	for _, tt := range []struct {
		name   string
		err    error
		status int
	}{
		{"stale", &workspaceapi.StaleFileError{Path: "later", CurrentDigest: "absent"}, 409},
		{"revoked", pkgerrors.Forbidden("revoked"), 403},
		{"unqualified", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "unqualified"), 503},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := &WorkspaceHandler{Service: &fileBatchRouteService{write: func(context.Context, string, int64, int64, []workspaceapi.FileMutation) ([]services.WorkspaceFileMutationResult, error) {
				return nil, tt.err
			}}}
			w := httptest.NewRecorder()
			h.WriteWorkspaceFile(w, fileBatchRequest(body, "", true))
			require.Equal(t, tt.status, w.Code, w.Body.String())
			if tt.status == 409 {
				require.JSONEq(t, `{"code":"stale","path":"later","current_digest":"absent"}`, w.Body.String())
			}
		})
	}
	for _, authenticated := range []bool{false, true} {
		h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{}}
		w := httptest.NewRecorder()
		h.WriteWorkspaceFile(w, fileBatchRequest(body, "", authenticated))
		if authenticated {
			require.Equal(t, 503, w.Code)
		} else {
			require.Equal(t, 401, w.Code)
		}
	}
}

func TestWorkspaceHandler_FileBatchMaximumCount(t *testing.T) {
	input := make([]map[string]any, 256)
	for i := range input {
		input[i] = map[string]any{"path": "a", "content": "", "base_digest": "absent"}
	}
	body, err := json.Marshal(map[string]any{"changes": input})
	require.NoError(t, err)
	// Path uniqueness belongs to the service. This test isolates the decoder's
	// inclusive entry limit; service tests exercise duplicates and ancestors.
	h := &WorkspaceHandler{Service: &fileBatchRouteService{write: func(_ context.Context, _ string, _, _ int64, changes []workspaceapi.FileMutation) ([]services.WorkspaceFileMutationResult, error) {
		require.Len(t, changes, 256)
		return nil, nil
	}}}
	w := httptest.NewRecorder()
	h.WriteWorkspaceFile(w, fileBatchRequest(string(body), "", true))
	require.Equal(t, 200, w.Code)
}
