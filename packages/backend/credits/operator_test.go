package credits

import (
	"bytes"
	"context"
	"io"
	"math"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseAndFormatUSD(t *testing.T) {
	for in, want := range map[string]int64{
		"25": 25 * NanosPerUSD, "0.50": 50 * NanosPerCent,
		"0.000000001": 1, " 000.000000001 ": 1,
		"9223372036.854775807": math.MaxInt64,
	} {
		got, err := ParseUSD(in)
		require.NoError(t, err, in)
		require.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "0", "0.000000000", "-1", "+1", ".5", "1.", "1,000", "abc", "0x19", "1/4", "0.0000000001", "1e30", "99999999999", "9223372036.854775808"} {
		_, err := ParseUSD(bad)
		require.Error(t, err, bad)
	}
	require.Equal(t, "25", FormatUSD(25*NanosPerUSD))
	require.Equal(t, "0.5", FormatUSD(50*NanosPerCent))
	require.Equal(t, "-0.000000001", FormatUSD(-1))
	require.Equal(t, "0", FormatUSD(0))
	require.Equal(t, "9223372036.854775807", FormatUSD(math.MaxInt64))
	require.Equal(t, "-9223372036.854775808", FormatUSD(math.MinInt64))
}

func TestOperatorCommandRejectsSyntaxBeforeDatabase(t *testing.T) {
	l := Ledger{}
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{name: "missing command", want: "usage: credits"},
		{name: "unknown command", args: []string{"transfer"}, want: "usage: credits"},
		{name: "unknown flag", args: []string{"balance", "-bogus"}, want: "flag provided but not defined"},
		{name: "extra argument", args: []string{"balance", "extra"}, want: "unexpected argument"},
		{name: "missing owner", args: []string{"balance"}, want: "-owner must be"},
		{name: "blank owner name", args: []string{"balance", "-owner", "user: "}, want: "-owner must be"},
		{name: "unknown owner type", args: []string{"balance", "-owner", "team:alice"}, want: "-owner must be"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out, diagnostics bytes.Buffer
			err := l.OperatorCommand(context.Background(), tc.args, &out, &diagnostics)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error=%v, want %q", err, tc.want)
			}
			if out.Len() != 0 {
				t.Fatalf("failed command wrote balance: %q", out.String())
			}
		})
	}
}

func TestOperatorCommandGrantsIdempotentlyByKey(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	_, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (41, 'Alice', 'alice')`)
	require.NoError(t, err)
	var out bytes.Buffer
	run := func(args ...string) error { out.Reset(); return l.OperatorCommand(ctx, args, &out, io.Discard) }
	require.NoError(t, run("grant", "-owner", "user:Alice", "-usd", "25", "-key", "2026-10"))
	require.Equal(t, "user:Alice balance 25 USD\n", out.String())
	require.NoError(t, run("grant", "-owner", "user:alice", "-usd", "25", "-key", "2026-10"), "a repeated grant is a no-op")
	require.NoError(t, run("balance", "-owner", "user:alice"))
	require.Equal(t, "user:alice balance 25 USD\n", out.String())
	require.ErrorIs(t, run("grant", "-owner", "user:alice", "-usd", "30", "-key", "2026-10"), ErrConflict)
	require.Error(t, run("grant", "-owner", "user:alice", "-usd", "5"), "a grant needs a key")
	require.Error(t, run("grant", "-owner", "user:nobody", "-usd", "5", "-key", "k"))
	require.Error(t, run("grant", "-owner", "team:alice", "-usd", "5", "-key", "k"))
	require.Error(t, run("spend", "-owner", "user:alice"))
	require.Error(t, run("grant", "-owner", "user:alice", "-usd", "5", "-key", "old", "-expires", "2020-01-01T00:00:00Z"))
}
