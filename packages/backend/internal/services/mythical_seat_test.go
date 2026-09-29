package services

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMythicalSeatAliasesMatchProviders keeps the snapshot's model -> seat
// table in step with @smthrs/cli Providers seatAliases (#1752).
func TestMythicalSeatAliasesMatchProviders(t *testing.T) {
	raw, err := os.ReadFile("../../../smithers/src/Providers.ts")
	if os.IsNotExist(err) {
		t.Skip("Providers.ts is not in this checkout")
	}
	require.NoError(t, err)
	source := string(raw)
	block := func(name string) string {
		start := strings.Index(source, "export const "+name)
		require.GreaterOrEqual(t, start, 0, name)
		end := strings.Index(source[start:], "\n}")
		require.Greater(t, end, 0, name)
		return source[start : start+end]
	}
	defaults := map[string]string{}
	for _, m := range regexp.MustCompile(`(?m)^\s*"?([a-z0-9-]+)"?:\s*"([^"]+)"`).FindAllStringSubmatch(block("defaultSeat"), -1) {
		defaults[m[1]] = m[2]
	}
	want := map[string]string{}
	for _, m := range regexp.MustCompile(`(?m)^\s*([a-z0-9]+):\s*(?:"([^"]+)"|defaultSeat(?:\.([a-z0-9]+)|\["([a-z0-9-]+)"\]))`).FindAllStringSubmatch(block("seatAliases"), -1) {
		seat := m[2]
		if seat == "" {
			seat = defaults[m[3]+m[4]]
		}
		_, model, ok := strings.Cut(seat, ":")
		require.True(t, ok, "alias %s names provider:model", m[1])
		want[model] = m[1]
	}
	require.NotEmpty(t, want)
	assert.Equal(t, want, mythicalSeatAliases)
	assert.Equal(t, "luna", mythicalSeat("gpt-6-luna"))
	assert.Equal(t, "gpt-7-nova", mythicalSeat("gpt-7-nova"))
}
