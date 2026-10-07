package githubfake

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestStreamBudgetHeadersLimitsAndCounters(t *testing.T) {
	s, cfg, key := fixture(t)
	status, body := request(t, s, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	s.OpenIssue("acme/app", "acme", "Issue", "body")
	s.SetResourceBudget("core", 10000, 1999, 2000000000)
	read := func(path, etag string, want int) string {
		t.Helper()
		r, err := http.NewRequest("GET", s.URL+path, nil)
		require.NoError(t, err)
		r.Header.Set("Authorization", "Bearer "+access.Token)
		r.Header.Set("If-None-Match", etag)
		resp, err := s.Client().Do(r)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, want, resp.StatusCode)
		require.Equal(t, "core", resp.Header.Get("X-RateLimit-Resource"))
		require.Equal(t, "10000", resp.Header.Get("X-RateLimit-Limit"))
		require.Equal(t, "1999", resp.Header.Get("X-RateLimit-Remaining"))
		require.Equal(t, "2000000000", resp.Header.Get("X-RateLimit-Reset"))
		if want == 429 || want == 403 {
			require.Equal(t, "50", resp.Header.Get("Retry-After"))
		}
		return resp.Header.Get("ETag")
	}
	etag := read("/repos/acme/app/issues?per_page=100", "", 200)
	read("/repos/acme/app/issues?per_page=100", etag, 304)
	for _, code := range []int{403, 429} {
		s.LimitNextStream("issues", code, "50")
		read("/repos/acme/app/issues?per_page=100", etag, code)
		read("/repos/acme/app/pulls?per_page=50", "", 200)
	}
	read("/repos/acme/app/issues/events?per_page=100", "", 200)
	counters := s.RequestCounters()
	require.Equal(t, RequestCounter{Raw: 1, Charged: 1}, counters["issues"][200])
	require.Equal(t, RequestCounter{Raw: 1, Charged: 0}, counters["issues"][304])
	require.Equal(t, RequestCounter{Raw: 1, Charged: 1}, counters["issues"][403])
	require.Equal(t, RequestCounter{Raw: 1, Charged: 1}, counters["issues"][429])
	require.Equal(t, RequestCounter{Raw: 2, Charged: 2}, counters["pulls"][200])
	require.Equal(t, RequestCounter{Raw: 1, Charged: 1}, counters["issue-events"][200])
	require.Equal(t, RequestCounter{Raw: 1, Charged: 1}, counters["installation-token"][201])
	counters["issues"][200] = RequestCounter{}
	require.Equal(t, 1, s.RequestCounters()["issues"][200].Raw, "snapshots must not mutate server counters")
}
