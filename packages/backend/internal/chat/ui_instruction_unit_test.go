package chat

import (
	"encoding/json"
	"os"
	"slices"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"
)

// catalogRow is the part of a generated catalog operation these checks read.
type catalogRow struct {
	Name       string          `json:"name"`
	Actors     []string        `json:"actors"`
	Agent      string          `json:"agent"`
	Visibility string          `json:"visibility"`
	HTTP       json.RawMessage `json:"http"`
	CLI        json.RawMessage `json:"cli"`
	Payload    struct {
		Schema struct {
			Properties map[string]json.RawMessage `json:"properties"`
		} `json:"schema"`
	} `json:"payload"`
}

// Each UI instruction is a screen-only catalog row: the app agent runs it,
// no external agent can, and it has no HTTP door or CLI path. The fields it
// carries are exactly the ones the row declares.
func TestUIInstructionsMatchScreenOnlyCatalogRows(t *testing.T) {
	raw, err := os.ReadFile("../../../smithers/src/internal/backend/catalog.mvp.json")
	require.NoError(t, err)
	var catalog struct {
		Operations []catalogRow `json:"operations"`
	}
	require.NoError(t, json.Unmarshal(raw, &catalog))
	for command, declared := range uiInstructionFields {
		index := slices.IndexFunc(catalog.Operations, func(row catalogRow) bool { return row.Name == command })
		require.NotEqual(t, -1, index, command)
		row := catalog.Operations[index]
		require.True(t, slices.Contains(row.Actors, "app_agent"), command)
		require.False(t, slices.Contains(row.Actors, "external_agent"), command)
		require.Equal(t, []any{"run", "null", "null", false}, []any{row.Agent, string(row.HTTP), string(row.CLI), row.Visibility == "hidden"}, command)
		fields := []string{}
		for field := range row.Payload.Schema.Properties {
			fields = append(fields, field)
		}
		want := slices.Clone(declared)
		sort.Strings(fields)
		sort.Strings(want)
		require.Equal(t, want, fields, command)
		require.NotContains(t, declared, "command", command)
	}
}

// The view state serves each committed request as its command and payload.
func TestUIInstructionDecodeSplitsCommandFromPayload(t *testing.T) {
	instruction, err := decodeUIInstruction("turn:1:2", json.RawMessage(`{"command":"runs.trace.select","runId":"run-1","seq":4}`))
	require.NoError(t, err)
	encoded, err := json.Marshal(instruction)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"turn:1:2","command":"runs.trace.select","payload":{"runId":"run-1","seq":4}}`, string(encoded))
	instruction, err = decodeUIInstruction("turn:1:3", json.RawMessage(`{"command":"help"}`))
	require.NoError(t, err)
	encoded, err = json.Marshal(instruction)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"turn:1:3","command":"help","payload":{}}`, string(encoded))
	for _, raw := range []string{`null`, `[]`, `{"mode":"dark"}`, `{"command":""}`, `{"command":1}`} {
		_, err = decodeUIInstruction("turn:1:4", json.RawMessage(raw))
		require.ErrorIs(t, err, ErrCorrupt, raw)
	}
}
