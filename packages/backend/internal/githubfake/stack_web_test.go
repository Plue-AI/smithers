package githubfake

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Exercise the same provider HTTP controls used by the browser stack walk.
func TestStackBrowserControls(t *testing.T) {
	cfg, err := LocalSeed()
	if err != nil {
		t.Fatal(err)
	}
	handler, err := Handler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := handler
	// Handler returns the production fake Server without opening a listener.
	s.pulls["local-owner/demo/1"] = Pull{Number: 1, State: "open", Repository: "local-owner/demo"}
	s.comments["local-owner/demo/1"] = []IssueComment{{Body: "Dropped in Smithers by @ben"}}
	request := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		s.serveHTTP(recorder, httptest.NewRequest(method, path, strings.NewReader(body)))
		if recorder.Code != status {
			t.Fatalf("%s: got %d: %s", path, recorder.Code, recorder.Body.String())
		}
		return recorder
	}
	request("POST", "/_fake/merge-refusal", `{`, http.StatusBadRequest)
	request("POST", "/_fake/merge-refusal", `{"repo":"local-owner/demo","number":1,"status":200,"message":"x"}`, http.StatusBadRequest)
	request("POST", "/_fake/merge-refusal", `{"repo":"local-owner/demo","number":9,"status":405,"message":"review required"}`, http.StatusNotFound)
	request("POST", "/_fake/merge-refusal", `{"repo":"local-owner/demo","number":1,"status":405,"message":"review required"}`, http.StatusNoContent)
	refusal := s.refusals["local-owner/demo/1"]
	if refusal.Status != 405 || refusal.Message != "review required" {
		t.Fatalf("wrong refusal: %+v", refusal)
	}
	request("GET", "/_fake/pull?repo=local-owner/demo&number=9", "", http.StatusNotFound)
	got := request("GET", "/_fake/pull?repo=local-owner/demo&number=1", "", http.StatusOK)
	var receipt struct {
		Pull     Pull
		Comments []IssueComment
		Parent   string
	}
	if err := json.Unmarshal(got.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Pull.Number != 1 || receipt.Pull.State != "open" || len(receipt.Comments) != 1 || receipt.Comments[0].Body != "Dropped in Smithers by @ben" || receipt.Parent != "" {
		t.Fatalf("wrong receipt: %+v", receipt)
	}
}
