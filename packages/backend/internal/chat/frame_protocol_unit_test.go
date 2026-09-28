package chat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// These wire fixtures are independent examples of the NativeAgent frame union.
// They exercise the journal's admission boundary without a store or SQL fake.
func TestChatFrameUnitOptionalFieldsAndEnumeratedValues(t *testing.T) {
	frames := []string{
		`{"runId":"run","type":"delta","kind":"reasoning","text":""}`,
		`{"runId":"run","type":"tool_call","call_id":"call","name":"tool","arguments":"{}"}`,
		`{"runId":"run","type":"call.settled","link":0,"ordinal":1,"name":"tool","verdict":"hit","resultDigest":"digest"}`,
		`{"runId":"run","type":"call.settled","link":0,"ordinal":1,"name":"tool","verdict":"replay"}`,
		`{"runId":"run","type":"gate.rejected","link":0,"kind":"shape","message":"bad shape"}`,
		`{"runId":"run","type":"gate.rejected","link":0,"kind":"fuel"}`,
		`{"runId":"run","type":"gate.rejected","link":0,"kind":"catalog"}`,
		`{"runId":"run","type":"gate.rejected","link":0,"kind":"call_failed"}`,
		`{"runId":"run","type":"gate.rejected","link":0,"kind":"script_failed"}`,
		`{"runId":"run","type":"link.ended","link":0,"outcome":"done"}`,
		`{"runId":"run","type":"link.ended","link":0,"outcome":"to"}`,
		`{"runId":"run","type":"park","code":"event","card":{}}`,
		`{"runId":"run","type":"park","code":"timer"}`,
		`{"runId":"run","type":"park","code":"quota"}`,
		`{"runId":"run","type":"park","code":"plugin"}`,
	}
	for _, raw := range frames {
		t.Run(raw, func(t *testing.T) {
			var wire struct{ Type string }
			require.NoError(t, json.Unmarshal([]byte(raw), &wire))
			meta, err := validateFrames([]json.RawMessage{json.RawMessage(raw)}, "run")
			require.NoError(t, err)
			require.Equal(t, frameMeta{RunID: "run", Type: wire.Type}, meta)
			require.Equal(t, State("running"), terminalState(meta))
		})
	}
}

func TestChatFrameUnitMalformedFieldsFailClosed(t *testing.T) {
	for _, raw := range []string{
		``, `{`, `[]`, `null`, `{"runId":"other","type":"done"}`,
		`{"runId":1,"type":"done"}`, `{"runId":"run"}`, `{"runId":"run","type":1}`,
		`{"runId":"run","type":"invented"}`,
		`{"runId":"run","type":"delta","kind":"audio","text":"x"}`,
		`{"runId":"run","type":"delta","kind":"text","text":null}`,
		`{"runId":"run","type":"tool_call","call_id":"call","name":"tool"}`,
		`{"runId":"run","type":"tool_call","call_id":1,"name":"tool","arguments":"{}"}`,
		`{"runId":"run","type":"card","card":[]}`,
		`{"runId":"run","type":"card.update","id":"card","patch":null}`,
		`{"runId":"run","type":"card.update","id":1,"patch":{}}`,
		`{"runId":"run","type":"link.authored","link":0,"scriptDigest":1,"script":"x"}`,
		`{"runId":"run","type":"call.started","link":0,"name":"tool"}`,
		`{"runId":"run","type":"call.started","link":0,"ordinal":0,"name":false}`,
		`{"runId":"run","type":"call.settled","link":0,"ordinal":0,"name":"tool","verdict":"cache"}`,
		`{"runId":"run","type":"call.settled","link":0,"ordinal":0,"name":"tool","verdict":"run","resultDigest":null}`,
		`{"runId":"run","type":"gate.rejected","link":0,"kind":"unknown"}`,
		`{"runId":"run","type":"gate.rejected","link":0,"kind":"denied","message":1}`,
		`{"runId":"run","type":"link.ended","link":0,"outcome":"failed"}`,
		`{"runId":"run","type":"steering.drained","link":0,"count":0}`,
		`{"runId":"run","type":"park","code":"unknown"}`,
		`{"runId":"run","type":"park","code":"approval","card":null}`,
		`{"runId":"run","type":"done","reason":"success"}`,
		`{"runId":"run","type":"done","reason":null}`,
		`{"runId":"run","type":"done","error":{}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			meta, err := validateFrames([]json.RawMessage{json.RawMessage(raw)}, "run")
			require.ErrorIs(t, err, ErrInvalidFrame)
			require.Equal(t, frameMeta{}, meta, "rejection must not publish partial terminal metadata")
		})
	}
}

func TestChatFrameUnitNumericAndBatchBoundaries(t *testing.T) {
	for _, row := range []struct {
		value string
		valid bool
	}{
		{"0", true}, {"9007199254740991", true}, {"9007199254740992", false},
		{"-1", false}, {"0.5", false}, {`"0"`, false}, {"null", false},
		{"1e309", false}, {"1e0", true},
	} {
		t.Run(row.value, func(t *testing.T) {
			raw := json.RawMessage(`{"runId":"run","type":"call.started","link":` + row.value + `,"ordinal":0,"name":"tool"}`)
			meta, err := validateFrames([]json.RawMessage{raw}, "run")
			if row.valid {
				require.NoError(t, err)
				require.Equal(t, frameMeta{RunID: "run", Type: "call.started"}, meta)
			} else {
				require.ErrorIs(t, err, ErrInvalidFrame)
				require.Equal(t, frameMeta{}, meta)
			}
		})
	}
	for _, count := range []int{0, 1, 256, 257} {
		frames := make([]json.RawMessage, count)
		for i := range frames {
			frames[i] = json.RawMessage(`{"runId":"run","type":"delta","kind":"text","text":"x"}`)
		}
		_, err := validateFrames(frames, "run")
		if count == 0 || count == 257 {
			require.ErrorIs(t, err, ErrInvalidFrame)
		} else {
			require.NoError(t, err)
		}
	}
	for _, count := range []string{"1", "9007199254740991"} {
		meta, err := validateFrames([]json.RawMessage{json.RawMessage(`{"runId":"run","type":"steering.drained","link":0,"count":` + count + `}`)}, "run")
		require.NoError(t, err)
		require.Equal(t, frameMeta{RunID: "run", Type: "steering.drained"}, meta)
	}
	invalidUTF8 := json.RawMessage(append([]byte(`{"runId":"run","type":"delta","kind":"text","text":"`), 0xff))
	invalidUTF8 = append(invalidUTF8, []byte(`"}`)...)
	_, err := validateFrames([]json.RawMessage{invalidUTF8}, "run")
	require.ErrorIs(t, err, ErrInvalidFrame, "invalid UTF-8 cannot silently alter committed text")
	// Pin the declared two-MiB frame cap, independently of the implementation constant.
	for _, size := range []int{2_097_151, 2_097_152, 2_097_153} {
		prefix, suffix := `{"runId":"run","type":"delta","kind":"text","text":"`, `"}`
		raw := json.RawMessage(prefix + strings.Repeat("x", size-len(prefix)-len(suffix)) + suffix)
		_, err := validateFrames([]json.RawMessage{raw}, "run")
		if size > 2_097_152 {
			require.ErrorIs(t, err, ErrInvalidFrame)
		} else {
			require.NoError(t, err)
		}
	}
}

func TestChatFrameUnitTerminalOrderingAndState(t *testing.T) {
	for _, row := range []struct {
		fields    string
		reason    string
		errorText string
		state     State
	}{
		{"", "", "", "completed"},
		{`,"reason":"stop"`, "stop", "", "completed"},
		{`,"reason":"tool_call"`, "tool_call", "", "completed"},
		{`,"reason":"tool_limit"`, "tool_limit", "", "completed"},
		{`,"error":"provider failed"`, "", "provider failed", "failed"},
		{`,"reason":"cancelled","error":"provider failed"`, "cancelled", "provider failed", "cancelled"},
	} {
		terminal := json.RawMessage(`{"runId":"run","type":"done"` + row.fields + `}`)
		delta := json.RawMessage(`{"runId":"run","type":"delta","kind":"text","text":"last text"}`)
		meta, err := validateFrames([]json.RawMessage{delta, terminal}, "run")
		require.NoError(t, err)
		require.Equal(t, frameMeta{RunID: "run", Type: "done", Reason: row.reason, Error: row.errorText}, meta)
		require.Equal(t, row.state, terminalState(meta))
		for _, after := range []json.RawMessage{delta, terminal} {
			meta, err := validateFrames([]json.RawMessage{terminal, after}, "run")
			require.ErrorIs(t, err, ErrInvalidFrame, "no frame may follow a terminal frame within a batch")
			require.Equal(t, frameMeta{}, meta)
		}
	}
	for _, row := range []struct {
		value    State
		terminal bool
	}{
		{"accepted", false}, {"running", false}, {"completed", true}, {"failed", true},
		{"cancelled", true}, {"uncertain", true}, {"retired", true}, {"unknown", false}, {"", false},
	} {
		require.Equal(t, row.terminal, row.value.Terminal(), string(row.value))
	}
}
