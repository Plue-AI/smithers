package modelproxy

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/stretchr/testify/require"
)

func TestRelayUnitRequiresUsageAndOrderedTerminalEvidence(t *testing.T) {
	usageLine := `data: {"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}` + "\n"
	completed := `data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3,"input_tokens_details":{"cached_tokens":4}}}}`
	expected := modelprice.Usage{InputTokens: 8, CacheReadTokens: 4, OutputTokens: 3}
	for _, item := range []struct {
		name, body string
		final      bool
		usage      modelprice.Usage
	}{
		{"chat final", usageLine + "data: [DONE]\n", true, expected},
		{"usage without final", usageLine, false, expected},
		{"done without usage", "data: [DONE]\n", false, modelprice.Usage{}},
		{"done before usage", "data: [DONE]\n" + usageLine, false, expected},
		{"response completed without final newline", completed, true, expected},
		{"response incomplete", strings.Replace(completed, "response.completed", "response.incomplete", 1) + "\n", true, expected},
		{"response failed with billed usage", strings.Replace(completed, "response.completed", "response.failed", 1) + "\n", true, expected},
		{"later provider error clears terminal", completed + "\ndata: {\"type\":\"error\"}\n", false, expected},
		{"malformed usage and framing", ": keepalive\nevent: response\ndata: {\ndata: null\ndata: []\ndata: {\"usage\":{}}\n", false, modelprice.Usage{}},
	} {
		t.Run(item.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			usage, final := relayStream(response, strings.NewReader(item.body))
			require.Equal(t, item.body, response.Body.String(), "framing is relayed byte-for-byte")
			require.Equal(t, item.final, final)
			require.Equal(t, item.usage, usage)
		})
	}
}

func TestRelayUnitAnthropicMergesCumulativeUsageWithoutDoubleCounting(t *testing.T) {
	body := strings.Join([]string{
		`data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}`,
		`data: {"type":"message_delta","usage":{"output_tokens":5}}`,
		`data: {"type":"message_delta","usage":{"output_tokens":4}}`,
		`data: {"type":"message_stop"}`, "",
	}, "\n")
	response := httptest.NewRecorder()
	usage, final := relayStream(response, strings.NewReader(body))
	require.True(t, final)
	require.Equal(t, modelprice.Usage{InputTokens: 10, OutputTokens: 5, CacheReadTokens: 3, CacheWriteTokens: 2}, usage)
	require.Equal(t, body, response.Body.String())
}

type unitChunkReader struct {
	chunks   []string
	consumed int
}

func (r *unitChunkReader) Read(p []byte) (int, error) {
	if r.consumed == len(r.chunks) {
		return 0, io.EOF
	}
	next := r.chunks[r.consumed]
	if len(next) > len(p) {
		panic("fixture chunk exceeds read buffer")
	}
	r.consumed++
	return copy(p, next), nil
}

type unitDisconnectedWriter struct {
	header          http.Header
	writes, flushes int
}

func (w *unitDisconnectedWriter) Header() http.Header { return w.header }
func (w *unitDisconnectedWriter) WriteHeader(int)     {}
func (w *unitDisconnectedWriter) Write([]byte) (int, error) {
	w.writes++
	return 0, errors.New("client disconnected")
}
func (w *unitDisconnectedWriter) Flush() { w.flushes++ }

func TestRelayUnitClientDisconnectStillConsumesFinalProviderUsage(t *testing.T) {
	reader := &unitChunkReader{chunks: []string{
		"data: {\"delta\":\"partial text\"}\n",
		"data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n",
		"data: [DONE]\n",
	}}
	writer := &unitDisconnectedWriter{header: make(http.Header)}
	usage, final := relayStream(writer, reader)
	require.True(t, final)
	require.Equal(t, modelprice.Usage{InputTokens: 7, OutputTokens: 2}, usage)
	require.Equal(t, 3, reader.consumed, "later chunks must be consumed after the first failed write")
	require.Equal(t, 1, writer.writes, "no further writes to disconnected caller")
	require.Zero(t, writer.flushes)
}

type unitErrorReader struct{ err error }

func (r unitErrorReader) Read([]byte) (int, error) { return 0, r.err }

func TestRelayUnitTruncatedUpstreamDoesNotCertifyFinalUsage(t *testing.T) {
	for _, failure := range []error{io.ErrUnexpectedEOF, errors.New("transport interrupted")} {
		t.Run(failure.Error(), func(t *testing.T) {
			response := httptest.NewRecorder()
			raw := "data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\ndata: [DONE]\n"
			reader := io.MultiReader(strings.NewReader(raw), unitErrorReader{err: failure})
			usage, final := relayStream(response, reader)
			require.False(t, final, "a terminal frame does not turn a transport error into EOF")
			require.Equal(t, modelprice.Usage{InputTokens: 7, OutputTokens: 2}, usage)
			require.Equal(t, raw, response.Body.String())
		})
	}
}

func TestAnthropicUsageSplitsCacheLifetimes(t *testing.T) {
	haiku, ok := modelprice.Lookup("claude-haiku-4-5")
	require.True(t, ok)
	split := `"cache_creation_input_tokens":200,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":100}`
	want := modelprice.Usage{InputTokens: 10, OutputTokens: 5, CacheWriteTokens: 200, CacheWrite1hTokens: 100}

	usage, ok := usageFromJSON([]byte(`{"type":"message","usage":{"input_tokens":10,"output_tokens":5,` + split + `}}`))
	require.True(t, ok)
	require.Equal(t, want, usage)
	cost, err := modelprice.CostNanos(haiku, modelprice.Usage{CacheWriteTokens: usage.CacheWriteTokens, CacheWrite1hTokens: usage.CacheWrite1hTokens})
	require.NoError(t, err)
	require.Equal(t, int64(325_000), cost, "100 tokens at $1.25 plus 100 at $2 per million")

	body := strings.Join([]string{
		`data: {"type":"message_start","message":{"usage":{"input_tokens":10,` + split + `}}}`,
		`data: {"type":"message_delta","usage":{"output_tokens":5,"cache_creation_input_tokens":200}}`,
		`data: {"type":"message_stop"}`, "",
	}, "\n")
	streamed, final := relayStream(httptest.NewRecorder(), strings.NewReader(body))
	require.True(t, final)
	require.Equal(t, want, streamed)

	for _, item := range []struct {
		name, usage string
		want        modelprice.Usage
	}{
		{"split without total", `{"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":4}}`, modelprice.Usage{CacheWriteTokens: 7, CacheWrite1hTokens: 4}},
		{"total below its parts", `{"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":4}}`, modelprice.Usage{CacheWriteTokens: 7, CacheWrite1hTokens: 4}},
		{"1-hour only", `{"cache_creation_input_tokens":4,"cache_creation":{"ephemeral_1h_input_tokens":4}}`, modelprice.Usage{CacheWriteTokens: 4, CacheWrite1hTokens: 4}},
		{"total without split", `{"cache_creation_input_tokens":4}`, modelprice.Usage{CacheWriteTokens: 4}},
	} {
		t.Run(item.name, func(t *testing.T) {
			usage, ok := usageFromJSON([]byte(`{"usage":` + item.usage + `}`))
			require.True(t, ok)
			require.Equal(t, item.want, usage)
		})
	}
}
