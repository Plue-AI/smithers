package chat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestChatAdmissionUnitHTMLTextBelowBothByteCapsRemainsAdmissible(t *testing.T) {
	f := newContextFixture(t)
	f.handler.Dispatcher = &Dispatcher{}
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
			raw := `{"prompt":"` + item.rawText + `","idempotencyKey":"` + item.name + `"}`
			require.Less(t, len(raw), 1048576)
			response := postJSON(t, f.server.Client(), f.server.URL+"/api/conversations/main/prompt", []byte(raw))
			defer response.Body.Close()
			require.Equal(t, 202, response.StatusCode)
			var receipt promptReceipt
			require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
			var request []byte
			require.NoError(t, f.handler.Store.pool.QueryRow(t.Context(), `SELECT request_payload FROM chat_turns WHERE id=$1`, receipt.TurnID).Scan(&request))
			var decoded struct {
				Messages []struct {
					Content string `json:"content"`
				} `json:"messages"`
			}
			require.NoError(t, json.Unmarshal(request, &decoded))
			require.Equal(t, item.text, decoded.Messages[0].Content)

		})
	}
}
