package routes

import (
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestLiveCodecCommittedFrames(t *testing.T) {
	for _, raw := range []string{
		`{"t":"sub","id":7,"topic":"todo:12","cursor":1043}`,
		`{"t":"unsub","id":7}`,
		`{"t":"snap","id":7,"cursor":1050,"data":{"state":"queued"}}`,
		`{"t":"delta","id":7,"cursor":1051,"data":{"state":"starting"}}`,
		`{"t":"gap","id":7}`,
		`{"t":"err","id":7,"code":"unknown_topic"}`,
		`{"t":"err","id":7,"code":"forbidden"}`,
		`{"t":"err","id":7,"code":"unsupported"}`,
	} {
		var f live.Frame
		require.NoError(t, json.Unmarshal([]byte(raw), &f))
		encoded, err := json.Marshal(f)
		require.NoError(t, err)
		require.JSONEq(t, raw, string(encoded))
	}
	for _, raw := range []string{`null`, `{}`, `{"t":"sub","id":7,"topic":"home","cursor":null}`, `{"t":"sub","id":7}`, `{"t":"sub","id":7,"topic":"home","cursor":-1}`, `{"t":"sub","id":7,"topic":"home","cursor":9007199254740992}`, `{"t":"sub","id":7.5,"topic":"home"}`, `{"t":"wat","id":7}`} {
		_, err := live.DecodeRequest([]byte(raw))
		require.Error(t, err, raw)
	}
	for _, raw := range []string{`{"t":"sub","id":7,"topic":"home","cursor":0}`, `{"t":"presence","id":7}`, `{"t":"presence","id":7,"cursor":false,"topic":{}}`, `{"t":"unsub","id":7}`} {
		_, err := live.DecodeRequest([]byte(raw))
		require.NoError(t, err)
	}
}
