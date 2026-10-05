package chat

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHTTPChatHostUnitTypesProviderRefusals(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		code   string
	}{
		{502, `{"status":"error","code":"provider_quota"}`, "provider_quota"},
		{502, `{"status":"error","code":"provider_auth"}`, "provider_auth"},
		{502, `{"status":"error","code":"turn_failed"}`, ""},
		{502, `{"status":"error","code":"cancelled"}`, ""},
		{500, `not json`, ""},
	} {
		client := &http.Client{Transport: chatHostUnitTransport(func(sent *http.Request) (*http.Response, error) {
			_ = sent.Body.Close()
			return &http.Response{StatusCode: tc.status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(tc.body)), Request: sent}, nil
		})}
		host, err := NewHTTPChatHost("https://host.invalid", client, "host-token")
		require.NoError(t, err)
		err = host.RunChatTurn(t.Context(), chatHostUnitGrant())
		require.Error(t, err)
		var refusal *ProviderRefusal
		require.Equal(t, tc.code != "", errors.As(err, &refusal), tc.body)
		if tc.code != "" {
			require.Equal(t, tc.code, refusal.Code)
			require.Empty(t, refusal.Provider, "the transport does not know the binding")
		}
	}
}

func TestProviderRefusalTextNamesTheProviderAndReason(t *testing.T) {
	require.Equal(t, "OpenAI is out of quota or credits.", (&ProviderRefusal{Code: "provider_quota", Provider: "OpenAI"}).Text())
	require.Equal(t, "Cerebras rejected the key.", (&ProviderRefusal{Code: "provider_auth", Provider: "Cerebras"}).Text())
	require.Equal(t, "The model provider is out of quota or credits.", (&ProviderRefusal{Code: "provider_quota"}).Text())
	require.Equal(t, "model provider refused the turn: provider_auth", (&ProviderRefusal{Code: "provider_auth"}).Error())
}

// A refusal's receipt is mandatory, so it must fit the terminal reserve at the
// largest identities, as the generic failure receipt does.
func TestProviderRefusalReceiptFitsTerminalReserve(t *testing.T) {
	runID, legID := strings.Repeat("\x01", maxIdentityBytes), strings.Repeat("\x02", maxIdentityBytes)
	for _, refusal := range []*ProviderRefusal{{Code: "provider_quota"}, {Code: "provider_auth", Provider: "AI Gateway"}, {Code: "provider_quota", Provider: "OpenRouter"}} {
		cursor := Cursor{Version: 1, RunID: runID, LegID: legID, Batch: maxBatches, Position: maxSafeInteger - 1, Hash: strings.Repeat("f", 64)}
		_, size, err := makeBatch(cursor, []json.RawMessage{errorFrame(runID, refusal.Text())})
		require.NoError(t, err)
		require.LessOrEqual(t, size, terminalReserveBytes, refusal.Text())
	}
}
