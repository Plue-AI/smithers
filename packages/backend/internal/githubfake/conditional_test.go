package githubfake

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestConditionalRepositoryReadsCheckAccessAndCurrentRepresentation(t *testing.T) {
	s, cfg, key := fixture(t)
	status, body := request(t, s, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	number := s.OpenIssue("acme/app", "acme", "First", "body")
	read := func(path, token, etag string, want int) string {
		t.Helper()
		r, err := http.NewRequest("GET", s.URL+path, nil)
		require.NoError(t, err)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("If-None-Match", etag)
		response, err := s.Client().Do(r)
		require.NoError(t, err)
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.Equal(t, want, response.StatusCode, string(body))
		if want == 304 {
			require.Empty(t, body)
		}
		return response.Header.Get("ETag")
	}
	path := "/repos/acme/app/issues?per_page=100&page=1"
	etag := read(path, access.Token, "", 200)
	require.NotEmpty(t, etag)
	require.Equal(t, etag, read(path, access.Token, etag, 304))
	read(path, "invalid", etag, 401)
	s.FailNextReads("/repos/acme/app/issues", 1)
	read(path, access.Token, etag, 502)
	s.LabelIssue("acme/app", number, "acme", "todo")
	updated := read(path, access.Token, etag, 200)
	require.NotEqual(t, etag, updated)
	read(path, access.Token, updated, 304)
	reads := s.Reads()
	require.Len(t, reads, 6)
	require.Equal(t, []int{200, 304, 401, 502, 200, 304}, []int{reads[0].Status, reads[1].Status, reads[2].Status, reads[3].Status, reads[4].Status, reads[5].Status})
	for _, read := range reads {
		require.Equal(t, path, read.Path)
	}
}
