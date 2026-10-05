package githubfake

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// peopleFake is the local seed's fake with one open pull request, #5 on
// local-owner/demo, as the App would have opened it.
func peopleFake(t *testing.T) *Server {
	t.Helper()
	fake, err := newPeopleFake()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fake.Close)
	return fake
}

func newPeopleFake() (*Server, error) {
	cfg, err := LocalSeed()
	if err != nil {
		return nil, err
	}
	fake, err := New(cfg)
	if err != nil {
		return nil, err
	}
	p := Pull{Repository: "local-owner/demo", Number: 5, Title: "Retry webhooks", Body: "Prompt", State: "open"}
	p.Head.Ref, p.Head.SHA, p.Base.Ref = "smithers/retry-webhooks", strings.Repeat("a", 40), "main"
	fake.pulls["local-owner/demo/5"] = p
	return fake, nil
}

// reviewsOf reads the fake's review records under its lock.
func reviewsOf(fake *Server, key string) ([]PullReview, map[string]string) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]PullReview(nil), fake.pullReviews[key]...), fake.reviews[key]
}

func call(t *testing.T, fake *Server, method, path, body, token string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(method, fake.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(raw)
}

func TestPeopleReviewOnALineReachesGitHubsLists(t *testing.T) {
	fake := peopleFake(t)
	status, raw := call(t, fake, "POST", "/_fake/reviews", `{"repo":"local-owner/demo","number":5,"login":"alice","state":"COMMENTED","body":"Retry 502 too","path":"JOURNEY.md","line":14}`, "")
	if status != 200 || !strings.Contains(raw, `"commit_id":"`+strings.Repeat("a", 40)) {
		t.Fatal(status, raw)
	}
	// GitHub's own lists answer the review and its line comment to a token holder.
	status, raw = call(t, fake, "GET", "/repos/local-owner/demo/pulls/5/comments", "", "ghs_any")
	var comments []map[string]any
	if status != 200 || json.Unmarshal([]byte(raw), &comments) != nil || len(comments) != 1 || comments[0]["path"] != "JOURNEY.md" || comments[0]["line"] != float64(14) ||
		comments[0]["user"].(map[string]any)["login"] != "alice" || comments[0]["body"] != "Retry 502 too" {
		t.Fatal(status, raw)
	}
	status, raw = call(t, fake, "GET", "/repos/local-owner/demo/pulls/5/reviews", "", "ghs_any")
	if status != 200 || !strings.Contains(raw, `"state":"COMMENTED"`) {
		t.Fatal(status, raw)
	}
	// Without a token GitHub answers 401; an unknown pull 404.
	if status, _ := call(t, fake, "GET", "/repos/local-owner/demo/pulls/5/reviews", "", ""); status != 401 {
		t.Fatal(status)
	}
	if status, _ := call(t, fake, "GET", "/repos/local-owner/demo/pulls/9/comments", "", "ghs_any"); status != 404 {
		t.Fatal(status)
	}
	// A comment-only review sets no review decision.
	if _, decisions := reviewsOf(fake, "local-owner/demo/5"); decisions["alice"] != "" {
		t.Fatal(decisions)
	}
}

func TestPeopleReviewRefusesBadInput(t *testing.T) {
	fake := peopleFake(t)
	for body, want := range map[string]int{
		`{"repo":"local-owner/demo","number":5,"login":"alice","state":"LGTM","body":"x"}`:                  400,
		`{"repo":"local-owner/demo","number":5,"login":"","state":"COMMENTED","body":"x"}`:                  400,
		`{"repo":"local-owner/demo","number":5,"login":"alice","state":"COMMENTED"}`:                        400,
		`{"repo":"local-owner/demo","number":5,"login":"alice","state":"COMMENTED","body":"x","line":3}`:    400,
		`{"repo":"local-owner/demo","number":5,"login":"alice","state":"COMMENTED","body":"x","path":"a"}`:  400,
		`{"repo":"local-owner/demo","number":9,"login":"alice","state":"COMMENTED","body":"x"}`:             404,
		`not json`: 400,
	} {
		if status, raw := call(t, fake, "POST", "/_fake/reviews", body, ""); status != want {
			t.Fatal(body, status, raw)
		}
	}
	if reviews, _ := reviewsOf(fake, "local-owner/demo/5"); len(reviews) != 0 {
		t.Fatal(reviews)
	}
}

func TestPeopleProtectionApprovalAndMerge(t *testing.T) {
	fake := peopleFake(t)
	if status, _ := call(t, fake, "POST", "/_fake/protection", `{"reviews":1}`, ""); status != 204 {
		t.Fatal(status)
	}
	// GitHub refuses the merge in its own words until someone approves.
	status, raw := call(t, fake, "POST", "/_fake/merge", `{"repo":"local-owner/demo","number":5}`, "")
	if status != 405 || !strings.Contains(raw, "At least 1 approving review is required by reviewers with write access.") {
		t.Fatal(status, raw)
	}
	if status, raw := call(t, fake, "POST", "/_fake/reviews", `{"repo":"local-owner/demo","number":5,"login":"ben","state":"APPROVED"}`, ""); status != 200 {
		t.Fatal(status, raw)
	}
	status, raw = call(t, fake, "GET", "/_fake/pulls?repo=local-owner/demo", "", "")
	if status != 200 || !strings.Contains(raw, `"review_decision":"APPROVED"`) || !strings.Contains(raw, `"labels":`) {
		t.Fatal(status, raw)
	}
	if status, raw := call(t, fake, "POST", "/_fake/merge", `{"repo":"local-owner/demo","number":5}`, ""); status != 200 || !strings.Contains(raw, `"merged":true`) {
		t.Fatal(status, raw)
	}
	// A merged pull request takes no second merge and no review.
	if status, _ := call(t, fake, "POST", "/_fake/merge", `{"repo":"local-owner/demo","number":5}`, ""); status != 405 {
		t.Fatal(status)
	}
	if status, _ := call(t, fake, "POST", "/_fake/reviews", `{"repo":"local-owner/demo","number":5,"login":"ben","state":"APPROVED"}`, ""); status != 422 {
		t.Fatal(status)
	}
	_, raw = call(t, fake, "GET", "/_fake/pulls?repo=local-owner/demo", "", "")
	if !strings.Contains(raw, `"merged":true`) || !strings.Contains(raw, `"state":"closed"`) {
		t.Fatal(raw)
	}
	for body, want := range map[string]int{`{"reviews":-1}`: 400, `{"reviews":7}`: 400, `[]`: 400} {
		if status, _ := call(t, fake, "POST", "/_fake/protection", body, ""); status != want {
			t.Fatal(body, status)
		}
	}
	if status, _ := call(t, fake, "POST", "/_fake/merge", `{"repo":"local-owner/demo","number":8}`, ""); status != 404 {
		t.Fatal(status)
	}
}

func TestPeopleDraftIsNotMergeable(t *testing.T) {
	fake := peopleFake(t)
	fake.UpdatePull("local-owner/demo", 5, func(p *Pull) { p.Draft = true })
	if status, _ := call(t, fake, "POST", "/_fake/merge", `{"repo":"local-owner/demo","number":5}`, ""); status != 405 {
		t.Fatal(status)
	}
}

func TestPeopleOutageAnswers502UntilBack(t *testing.T) {
	fake := peopleFake(t)
	if status, _ := call(t, fake, "POST", "/_fake/outage", `{"down":true}`, ""); status != 204 {
		t.Fatal(status)
	}
	for _, path := range []string{"/repos/local-owner/demo/pulls/5", "/repos/local-owner/demo/pulls/5/reviews", "/local-owner/demo.git/info/refs?service=git-upload-pack", "/user"} {
		if status, _ := call(t, fake, "GET", path, "", "ghs_any"); status != 502 {
			t.Fatal(path, status)
		}
	}
	// The fake's own controls still answer while GitHub is down.
	if status, _ := call(t, fake, "GET", "/_fake/pulls?repo=local-owner/demo", "", ""); status != 200 {
		t.Fatal(status)
	}
	if status, _ := call(t, fake, "POST", "/_fake/outage", `{}`, ""); status != 400 {
		t.Fatal(status)
	}
	if status, _ := call(t, fake, "POST", "/_fake/outage", `{"down":false}`, ""); status != 204 {
		t.Fatal(status)
	}
	if status, _ := call(t, fake, "GET", "/repos/local-owner/demo/pulls/5/reviews", "", "ghs_any"); status != 200 {
		t.Fatal(status)
	}
}

func TestPeopleIssueReadBack(t *testing.T) {
	fake := peopleFake(t)
	number := fake.OpenIssue("local-owner/demo", "alice", "Retry webhooks", "They drop on 502.")
	fake.CommentIssue("local-owner/demo", number, "ben", "Seen it.")
	status, raw := call(t, fake, "GET", "/_fake/issue?repo=local-owner/demo&number="+itoa(number), "", "")
	var view IssueView
	if status != 200 || json.Unmarshal([]byte(raw), &view) != nil || view.State != "open" || len(view.Comments) != 1 || view.Author != "alice" {
		t.Fatal(status, raw)
	}
	if status, _ := call(t, fake, "GET", "/_fake/issue?repo=local-owner/demo&number=99", "", ""); status != 404 {
		t.Fatal(status)
	}
}


// FuzzPeopleControls: any body to any control answers a defined status and
// never panics; a refused request records no review.
func FuzzPeopleControls(f *testing.F) {
	for _, seed := range []string{`{"repo":"local-owner/demo","number":5,"login":"alice","state":"COMMENTED","body":"x","path":"a","line":1}`,
		`{"reviews":2}`, `{"down":true}`, `{"repo":"local-owner/demo","number":5}`, `{"line":-4}`, `null`, ``} {
		for control := range 4 {
			f.Add(control, seed)
		}
	}
	fake, err := newPeopleFake()
	if err != nil {
		f.Fatal(err)
	}
	f.Cleanup(fake.Close)
	f.Fuzz(func(t *testing.T, control int, body string) {
		path := []string{"/_fake/reviews", "/_fake/merge", "/_fake/protection", "/_fake/outage"}[(control%4+4)%4]
		reviews, _ := reviewsOf(fake, "local-owner/demo/5")
		before := len(reviews)
		status, _ := call(t, fake, "POST", path, body, "")
		if !map[int]bool{200: true, 204: true, 400: true, 404: true, 405: true, 422: true}[status] {
			t.Fatal(path, body, status)
		}
		reviews, _ = reviewsOf(fake, "local-owner/demo/5")
		if after := len(reviews); path == "/_fake/reviews" && (status == 200) != (after == before+1) {
			t.Fatal(body, status, before, after)
		}
	})
}
