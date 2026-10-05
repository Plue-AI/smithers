package services

import (
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestTodoWaitCardsRetainSettlementAndTerminalEvidence(t *testing.T) {
	since := time.Unix(100, 0).UTC()
	settled := since.Add(12 * time.Second)
	waits := []TodoWait{
		{ID: "answered", Kind: "question", Prompt: "Which language?", Since: since, SettledAt: &settled, AnsweredBy: "alice", By: json.RawMessage(`{"kind":"person","login":"alice","name":"Alice","avatar_url":"https://example.test/alice"}`), Signal: &TodoWaitSignal{}},
		{ID: "open", Kind: "question", Prompt: "Which file?", Since: since, Signal: &TodoWaitSignal{}},
		{ID: "withdrawn", Kind: "question", Since: since, SettledAt: &settled},
	}
	for _, state := range []string{"running", "landed", "cancelled", "rejected", "declined"} {
		t.Run(state, func(t *testing.T) {
			cards := todoWaitCards(db.MythicalItem{State: state, Checks: mythicalChecks{Waits: waits}.encode()})
			require.Len(t, cards, 3)
			require.Equal(t, "alice", cards[0]["answered_by"])
			require.JSONEq(t, string(waits[0].By), string(cards[0]["by"].(json.RawMessage)))
			require.Equal(t, settled, cards[0]["settled_at"])
			require.Equal(t, since, cards[0]["since"])
			require.Empty(t, cards[0]["actions"])
			require.Empty(t, cards[2]["actions"])
			require.NotContains(t, cards[2], "answered_by")
			require.NotContains(t, cards[1], "settled_at")
			if state == "running" {
				require.Len(t, cards[1]["actions"], 1)
			} else {
				require.Empty(t, cards[1]["actions"])
			}
		})
	}
	require.Empty(t, todoWaitCards(db.MythicalItem{}))
}

func FuzzTodoWaitCardsPreserveEvidence(f *testing.F) {
	f.Add("alice", int64(12), true)
	f.Add("", int64(0), false)
	f.Fuzz(func(t *testing.T, login string, delay int64, terminal bool) {
		since := time.Unix(100, 0).UTC()
		settled := since.Add(time.Duration(delay%86400) * time.Second)
		state := "running"
		if terminal {
			state = "landed"
		}
		item := db.MythicalItem{State: state, Checks: mythicalChecks{Waits: []TodoWait{{ID: "q", Kind: "question", Since: since, SettledAt: &settled, AnsweredBy: login}}}.encode()}
		cards := todoWaitCards(item)
		require.Len(t, cards, 1)
		require.Equal(t, settled, cards[0]["settled_at"])
		require.Empty(t, cards[0]["actions"])
		require.Empty(t, todoOpenWaits(item))
	})
}
