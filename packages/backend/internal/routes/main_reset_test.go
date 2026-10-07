package routes

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type attentionReadFailure struct{}

func (attentionReadFailure) Read([]byte) (int, error) { return 0, errors.New("read failed") }

func TestStackAttentionBodyDispatch(t *testing.T) {
	for _, tc := range []struct {
		name, body, command string
		status              int
	}{
		{"order", `{"revision":2}`, "order.ok", 200},
		{"reset", `{"old":"old","new":"new"}`, "main.reset-to-github", 200},
		{"incomplete reset", `{"new":null}`, "main.reset-to-github", 200},
		{"mixed reset stays owner only", `{"revision":2,"old":"old"}`, "main.reset-to-github", 200},
		{"null is not a reset", `null`, "order.ok", 200},
		{"truncated", `{"old":`, "", 400},
		{"array", `[]`, "", 400},
		{"trailing document", `{"revision":2} {"old":"old"}`, "", 400},
		{"oversized", strings.Repeat(" ", 4097), "", http.StatusRequestEntityTooLarge},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/api/stack/attention/one", strings.NewReader(tc.body))
			response := httptest.NewRecorder()
			command, ok := StackAttentionCommand(response, request)
			require.Equal(t, tc.command, command)
			require.Equal(t, tc.command != "", ok)
			require.Equal(t, tc.status, response.Code)
			if ok {
				retained, err := io.ReadAll(request.Body)
				require.NoError(t, err)
				require.Equal(t, tc.body, string(retained))
			}
		})
	}
	request := httptest.NewRequest("POST", "/api/stack/attention/one", nil)
	request.Body = io.NopCloser(attentionReadFailure{})
	response := httptest.NewRecorder()
	_, ok := StackAttentionCommand(response, request)
	require.False(t, ok)
	require.Equal(t, 400, response.Code)
}
