package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestReleaseJSONRequestsContainOneDocument(t *testing.T) {
	for _, mode := range []string{"ordinary", "optional", "strict"} {
		for _, tc := range []struct {
			body string
			want int
		}{
			{`{"name":"kept"}`, 204}, {"{\"name\":\"kept\"}\n\t ", 204},
			{`{"name":"kept"} {"name":"discarded"}`, 400},
			{`{"name":"kept"} garbage`, 400}, {`{"name":"kept"} null`, 400},
			{`{"name":"kept"} 1`, 400}, {`{"name":"kept"} [`, 400},
		} {
			t.Run(mode+"/"+tc.body, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
				rec := httptest.NewRecorder()
				var decoded struct {
					Name string `json:"name"`
				}
				var ok bool
				switch mode {
				case "ordinary":
					ok = decodeJSONBody(rec, req, &decoded)
				case "optional":
					ok = decodeOptionalJSONBody(rec, req, &decoded)
				case "strict":
					ok = decodeStrictJSONBody(rec, req, &decoded)
				}
				if ok {
					rec.WriteHeader(http.StatusNoContent)
				}
				require.Equal(t, tc.want, rec.Code, rec.Body.String())
				if ok {
					require.Equal(t, "kept", decoded.Name)
				}
			})
		}
	}
}

func TestReleaseMalformedOffsetCursorsAreRefused(t *testing.T) {
	for _, cursor := range []string{"garbage", "NQ", "-1", "9223372036854775808", "1.5"} {
		req := httptest.NewRequest(http.MethodGet, "/?cursor="+cursor, nil)
		_, _, err := parseOffsetPagination(req)
		require.Error(t, err, cursor)
	}
	for _, cursor := range []string{"", "0", "30", "9223372036854775807"} {
		req := httptest.NewRequest(http.MethodGet, "/?cursor="+cursor, nil)
		got, _, err := parseOffsetPagination(req)
		require.NoError(t, err)
		require.Equal(t, cursor, got)
	}
	// Repository-host cursors remain opaque and are validated by their host.
	cursor, _, err := parsePagination(httptest.NewRequest(http.MethodGet, "/?cursor=bookmark-name", nil))
	require.NoError(t, err)
	require.Equal(t, "bookmark-name", cursor)
}

func TestReleaseMalformedKeysetCursorsAreRefused(t *testing.T) {
	for _, cursor := range []string{"garbage", "-1", "LTE", "9223372036854775808", "MS41"} {
		_, _, err := parseKeysetPagination(httptest.NewRequest(http.MethodGet, "/?cursor="+cursor, nil))
		require.Error(t, err, cursor)
	}
	for _, cursor := range []string{"5", "NQ"} {
		id, _, err := parseKeysetPagination(httptest.NewRequest(http.MethodGet, "/?cursor="+cursor, nil))
		require.NoError(t, err)
		require.Equal(t, int64(5), id)
	}
}

func TestReleaseWorkspaceFileWriteRefusesTrailingDataBeforeStorage(t *testing.T) {
	for _, suffix := range []string{" {}", " null", " junk"} {
		// A nil service proves rejection occurs before touching workspace storage.
		h := WorkspaceHandler{}
		req := httptest.NewRequest(http.MethodPut, "/?path=discarded.txt", strings.NewReader(`{"content":"prefix"}`+suffix))
		req = withWorkspaceRepoCtx(withAuth(req, 1, "alice"), "alice", "demo")
		req = withRouteParams(req, map[string]string{"id": "workspace"})
		rec := httptest.NewRecorder()
		h.WriteWorkspaceFile(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}
