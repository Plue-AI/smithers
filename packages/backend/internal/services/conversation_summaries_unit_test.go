package services

import (
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

func TestSummaryTextIsSealedInertText(t *testing.T) {
	for _, tc := range []struct {
		name, wire, want string
		fail             bool
	}{
		{"text", "{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"  Checked tests\\nextra\"}\n{\"type\":\"done\"}\n", "Checked tests", false},
		{"commands remain text", "{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"rm -rf /; import repo/flow.ts; tool()\"}\n{\"type\":\"done\"}\n", "rm -rf /; import repo/flow.ts; tool()", false},
		{"tools are ignored", "{\"type\":\"tool_call\",\"name\":\"exec\",\"arguments\":\"rm -rf /\"}\n{\"type\":\"done\"}\n", "", false},
		{"truncated", "{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"partial\"}\n", "", true},
		{"failed", "{\"type\":\"done\",\"error\":\"provider failed\"}\n", "", true},
		{"invalid", "{", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text, err := summaryText(strings.NewReader(tc.wire))
			if tc.fail {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				require.Equal(t, tc.want, text)
			}
		})
	}
	text, err := summaryText(strings.NewReader("{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"" + strings.Repeat("界", 300) + "\"}\n{\"type\":\"done\"}\n"))
	require.NoError(t, err)
	require.Equal(t, 240, len([]rune(text)))
}
