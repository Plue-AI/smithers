package chat

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestChatAdmissionUnitHTMLTextBelowBothByteCapsRemainsAdmissible(t *testing.T) {
	for _, item := range []struct {
		name    string
		rawText string
		text    string
	}{
		{"ascii", strings.Repeat("x", 350000), strings.Repeat("x", 350000)},
		{"less-than", strings.Repeat("<", 350000), strings.Repeat("<", 350000)},
		{"greater-than", strings.Repeat(">", 350000), strings.Repeat(">", 350000)},
		{"ampersand", strings.Repeat("&", 350000), strings.Repeat("&", 350000)},
		{"escaped-less-than", strings.Repeat(`\u003c`, 100000), strings.Repeat("<", 100000)},
	} {
		t.Run(item.name, func(t *testing.T) {
			raw := `{"runId":"run","journal":{"version":1,"legId":"leg","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"messages":[],"instructions":"` + item.rawText + `"}`
			expected := `{"instructions":"` + item.text + `","messages":[],"runId":"run"}`
			require.Less(t, len(raw), 1048576, "public request is below the documented shared HTTP body cap")
			require.Less(t, len(expected), 2097152, "canonical payload is below the chat canonical byte cap")
			_, _, err := parseCanonical([]byte(raw))
			require.NoError(t, err, "the original object satisfies canonical structural and byte admission")
			response := httptest.NewRecorder()
			runID, journal, payload, ok := readTurnRequest(response, httptest.NewRequest("POST", TurnPath, strings.NewReader(raw)))
			require.True(t, ok, "removing a credential cannot make an admitted object exceed its canonical byte cap")
			require.Equal(t, "run", runID)
			require.Equal(t, "leg", journal.LegID)
			require.Equal(t, expected, string(payload))
		})
	}
}
