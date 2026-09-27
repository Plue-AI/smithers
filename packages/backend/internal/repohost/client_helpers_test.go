package repohost

import (
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRepoClientEndpointHelpers(t *testing.T) {
	t.Parallel()

	t.Run("repo_by_id_endpoint", func(t *testing.T) {
		got := repoByIDEndpoint("https://repo.example.test/", "alice", "demo")
		assert.Equal(t, "https://repo.example.test/repos/alice:demo", got)

		got = repoByIDEndpoint("https://repo.example.test/base/", "alice team", "demo/repo")
		assert.Equal(t, "https://repo.example.test/base/repos/alice%20team:demo%2Frepo", got)
	})

	t.Run("repo_endpoint", func(t *testing.T) {
		got := repoEndpoint("https://repo.example.test/", "alice", "demo")
		assert.Equal(t, "https://repo.example.test/repos/alice/demo", got)

		got = repoEndpoint("https://repo.example.test/base/", "alice team", "demo/repo")
		assert.Equal(t, "https://repo.example.test/base/repos/alice%20team/demo%2Frepo", got)
	})

	t.Run("escape_path_segments", func(t *testing.T) {
		assert.Equal(t, "a/b/c", escapePathSegments("a/b/c"))
		assert.Equal(t, "dir%20name/file.txt", escapePathSegments("dir name/file.txt"))
		assert.Equal(t, "a/b", escapePathSegments("/a//b/"))
		assert.Equal(t, "a:b", escapePathSegments("a:b"))
		assert.Equal(t, "", escapePathSegments(""))
	})
}

func TestRepoClientErrorBodyHelpers(t *testing.T) {
	t.Parallel()

	t.Run("discard_error_body_handles_nil", func(t *testing.T) {
		discardErrorBody(nil)
	})

	t.Run("discard_error_body_drains_reader", func(t *testing.T) {
		reader := strings.NewReader(strings.Repeat("x", maxErrorBodyDiscardBytes*2))
		discardErrorBody(reader)
		remaining, err := io.ReadAll(reader)
		assert.NoError(t, err)
		assert.NotEmpty(t, remaining)
		assert.Len(t, remaining, maxErrorBodyDiscardBytes)
	})

	t.Run("read_error_message_nil", func(t *testing.T) {
		assert.Equal(t, "", readErrorResponse(nil).Message)
	})

	t.Run("read_error_message_prefers_message_field", func(t *testing.T) {
		body := strings.NewReader(`{"message":"upstream failure","error":"ignored"}`)
		assert.Equal(t, "upstream failure", readErrorResponse(body).Message)
	})

	t.Run("read_error_message_falls_back_to_error_field", func(t *testing.T) {
		body := strings.NewReader(`{"error":"backend exploded"}`)
		assert.Equal(t, "backend exploded", readErrorResponse(body).Message)
	})

	t.Run("read_error_message_falls_back_to_trimmed_text", func(t *testing.T) {
		body := strings.NewReader("  plain text error  ")
		assert.Equal(t, "plain text error", readErrorResponse(body).Message)
	})

	t.Run("read_error_message_empty_body", func(t *testing.T) {
		body := strings.NewReader("")
		assert.Equal(t, "", readErrorResponse(body).Message)
	})
}
