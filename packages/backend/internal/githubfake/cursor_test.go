package githubfake

import (
	"encoding/json"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRepositoryCursorFiltersAndOrdersSourceTimestamps(t *testing.T) {
	s, cfg, key := fixture(t)
	status, body := request(t, s, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	stamp := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	first := s.OpenIssue("acme/app", "acme", "first", "body")
	second := s.OpenIssue("acme/app", "acme", "second", "body")
	third := s.OpenIssue("acme/app", "acme", "third", "body")
	s.SetIssueUpdatedAt("acme/app", first, stamp.Add(time.Second))
	s.SetIssueUpdatedAt("acme/app", second, stamp)
	s.SetIssueUpdatedAt("acme/app", third, stamp.Add(-time.Second))
	readNumbers := func(path string) []int64 {
		t.Helper()
		status, raw := request(t, s, "GET", path, access.Token, nil)
		require.Equal(t, 200, status)
		var objects []struct{ Number int64 }
		require.NoError(t, json.Unmarshal(raw, &objects))
		out := make([]int64, len(objects))
		for i, o := range objects {
			out[i] = o.Number
		}
		return out
	}
	query := "/repos/acme/app/issues?state=all&sort=updated&direction=desc&since=" + url.QueryEscape(stamp.Format(time.RFC3339))
	require.Equal(t, []int64{first}, readNumbers(query), "since excludes equal timestamps")
	require.Equal(t, []int64{first, second, third}, readNumbers("/repos/acme/app/issues?sort=updated&direction=desc"))
	require.Equal(t, []int64{second}, readNumbers("/repos/acme/app/issues?sort=updated&direction=desc&per_page=1&page=2"))
	require.Equal(t, []int64{third, second, first}, readNumbers("/repos/acme/app/issues?sort=updated&direction=asc"))
	var pulls []Pull
	for _, head := range []string{"one", "two"} {
		status, raw := request(t, s, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"head":"`+head+`","base":"main","title":"pull"}`))
		require.Equal(t, 201, status)
		var pull Pull
		require.NoError(t, json.Unmarshal(raw, &pull))
		require.Positive(t, pull.ID)
		require.False(t, pull.UpdatedAt.IsZero())
		pulls = append(pulls, pull)
	}
	s.UpdatePull("acme/app", pulls[0].Number, func(p *Pull) { p.UpdatedAt = stamp.Add(time.Second) })
	s.UpdatePull("acme/app", pulls[1].Number, func(p *Pull) { p.UpdatedAt = stamp })
	require.Equal(t, []int64{pulls[0].Number, pulls[1].Number}, readNumbers("/repos/acme/app/pulls?sort=updated&direction=desc"))
	require.Equal(t, []int64{pulls[1].Number, pulls[0].Number}, readNumbers("/repos/acme/app/pulls?sort=updated&direction=asc"))
	status, _ = request(t, s, "POST", "/repos/acme/app/issues/"+strconv.FormatInt(pulls[1].Number, 10)+"/labels", access.Token, []byte(`{"labels":["review"]}`))
	require.Equal(t, 200, status)
	require.Equal(t, []int64{pulls[1].Number, pulls[0].Number}, readNumbers("/repos/acme/app/pulls?sort=updated&direction=desc"), "a label edit advances the pull timestamp")
}
