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

func TestGitStatusErrorForbiddenRetainsMessage(t *testing.T) {
	const message = "an agent run cannot write the default bookmark; land its changes instead"
	status := gitStatusError(&http.Response{
		StatusCode: http.StatusForbidden,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(message + "\n")),
	})
	if status.StatusCode != http.StatusForbidden || status.Message != message {
		t.Fatalf("status = %+v, want forbidden with message %q", status, message)
	}
}
