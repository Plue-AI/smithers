package repohost

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestGitStatusErrorPushSizeMessage(t *testing.T) {
	for _, code := range []string{PushTooLargeCode, UserRefPushTooLargeCode, "unknown_error"} {
		t.Run(code, func(t *testing.T) {
			resp := &http.Response{
				StatusCode: http.StatusRequestEntityTooLarge,
				Header:     http.Header{"X-Smithers-Error-Code": []string{code}},
				Body:       io.NopCloser(strings.NewReader("push exceeded its size cap; nothing was changed\n")),
			}
			status := gitStatusError(resp)
			if status.Code != code || status.StatusCode != http.StatusRequestEntityTooLarge {
				t.Fatalf("status = %+v", status)
			}
			want := "push exceeded its size cap; nothing was changed"
			if code == "unknown_error" {
				want = ""
			}
			if status.Message != want {
				t.Fatalf("message = %q, want %q", status.Message, want)
			}
		})
	}
}
