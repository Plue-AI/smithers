package compose

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// liveHomeTodos are TODO cards as GET /api/todos served them in a J4
// rehearsal, plus failed, merged, paused and dropped copies.
func liveHomeTodos(t *testing.T) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "live", "home-todos.json"))
	require.NoError(t, err)
	var cards []map[string]any
	require.NoError(t, json.Unmarshal(raw, &cards))
	return cards
}

// TestLiveHomeIsTheAppsHome pins the home topic's model to
// testdata/live/home.json, which apps/app's HomeFromTodos test reads too:
// the browser's own Home from the same cards equals it and parses as
// HomeCardSchema. SMITHERS_UPDATE_LIVE_HOME=1 rewrites it.
func TestLiveHomeIsTheAppsHome(t *testing.T) {
	got, err := json.MarshalIndent(homeModel("rehearsal-owner/app", liveHomeTodos(t), nil), "", " ")
	require.NoError(t, err)
	golden := filepath.Join("testdata", "live", "home.json")
	if os.Getenv("SMITHERS_UPDATE_LIVE_HOME") == "1" {
		require.NoError(t, os.WriteFile(golden, append(got, '\n'), 0o644))
	}
	want, err := os.ReadFile(golden)
	require.NoError(t, err)
	require.JSONEq(t, string(want), string(got))

	var home struct {
		Items []struct {
			N       int64            `json:"n"`
			Actions []map[string]any `json:"actions"`
		} `json:"items"`
		Counts   map[string]int `json:"counts"`
		Machines struct {
			InUse int `json:"in_use"`
		} `json:"machines"`
	}
	require.NoError(t, json.Unmarshal(got, &home))
	// Merged and dropped TODOs are counted, never listed.
	var listed []int64
	for _, item := range home.Items {
		listed = append(listed, item.N)
	}
	require.Equal(t, []int64{1, 2, 3, 4, 6}, listed)
	require.Equal(t, map[string]int{"queued": 1, "starting": 0, "working": 0, "needs_you": 1, "paused": 1, "failed": 1, "in_review": 1, "merged": 1, "dropped": 1}, home.Counts)
	// T2's lane is awake and T6's waking: two machines in use.
	require.Equal(t, 2, home.Machines.InUse)
	tags := func(i int) (out []string) {
		for _, action := range home.Items[i].Actions {
			out = append(out, action["tag"].(string))
		}
		return out
	}
	require.Equal(t, []string{"todo", "merge"}, tags(0))
	require.Equal(t, []string{"todo", "todo.answer"}, tags(1))
	require.Equal(t, []string{"todo"}, tags(2))
	require.Equal(t, []string{"todo", "todo.retry"}, tags(3))
	require.Equal(t, []string{"todo", "todo.resume"}, tags(4))
}

// TestLiveHomeMainRowFollowsTheSync: main's row is the install's GitHub sync
// once it has an answer, as the app's withGitHubSync reads GET
// /api/github/sync.
func TestLiveHomeMainRowFollowsTheSync(t *testing.T) {
	at := time.Date(2026, 10, 5, 15, 0, 0, 123000000, time.UTC)
	retry := at.Add(time.Minute)
	for _, tc := range []struct {
		name string
		sync *services.GitHubSyncHealth
		want map[string]any
	}{
		{"no sync", nil, map[string]any{"sha": "", "title": "main", "last_success_at": "1970-01-01T00:00:00.000Z", "health": "limited"}},
		{"never read", &services.GitHubSyncHealth{State: "limited"}, map[string]any{"sha": "", "title": "main", "last_success_at": "1970-01-01T00:00:00.000Z", "health": "limited"}},
		{"fresh", &services.GitHubSyncHealth{State: "fresh", LastSuccessAt: &at}, map[string]any{"sha": "", "title": "main", "last_success_at": "2026-10-05T15:00:00.123Z", "health": "fresh"}},
		{"refused", &services.GitHubSyncHealth{State: "refused", Cause: "permission"}, map[string]any{"sha": "", "title": "main", "last_success_at": "1970-01-01T00:00:00.000Z", "health": "refused", "cause": "GitHub App permission missing"}},
		{"stale, retrying", &services.GitHubSyncHealth{State: "stale", LastSuccessAt: &at, RetryAt: &retry}, map[string]any{"sha": "", "title": "main", "last_success_at": "2026-10-05T15:00:00.123Z", "health": "stale", "retry_at": "2026-10-05T15:01:00.123Z"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, homeModel("o/r", nil, tc.sync)["main"])
		})
	}
}

// Property: for any served cards, Home lists every TODO that is not merged
// or dropped, in the served order, counts each known state, offers Merge
// only on a ready in_review row, counts one machine per awake or waking
// branch, and encodes the same bytes every time.
func TestLiveHomeInvariantsOverRandomCards(t *testing.T) {
	states := append(slices.Clone(homeStates), "archived")
	machines := []string{"awake", "waking", "asleep", ""}
	for seed := int64(1); seed <= 300; seed++ {
		random := rand.New(rand.NewSource(seed))
		var cards []map[string]any
		for i := range random.Intn(12) {
			n := float64(i + 1)
			state := states[random.Intn(len(states))]
			revisions := make([]any, random.Intn(3))
			for r := range revisions {
				revisions[r] = map[string]any{"text": fmt.Sprint("prompt ", r)}
			}
			card := map[string]any{"n": n, "title": fmt.Sprint("T", i+1), "state": state, "present": []any{}, "waits": []any{},
				"owner":            map[string]any{"kind": "person", "login": "owner", "name": "Owner", "avatar_url": placeholderAvatar, "color_index": 0},
				"merge":            map[string]any{"state": []string{"ready", "waiting"}[random.Intn(2)]},
				"prompt_revisions": revisions}
			if random.Intn(2) == 0 {
				card["place"] = n
			}
			if machine := machines[random.Intn(len(machines))]; machine != "" {
				card["branch"] = map[string]any{"id": fmt.Sprint("b", i), "name": fmt.Sprint("TODO ", i+1), "machine": map[string]any{"state": machine}}
			}
			if random.Intn(2) == 0 {
				card["waits"] = []any{map[string]any{"id": "q", "kind": "question", "prompt": "Which?"}}
			}
			cards = append(cards, card)
		}
		model := homeModel("o/r", cards, nil)
		encoded, err := json.Marshal(model)
		require.NoError(t, err)
		again, _ := json.Marshal(homeModel("o/r", cards, nil))
		require.Equal(t, string(encoded), string(again), "seed %d: Home encodes the same bytes", seed)
		var home struct {
			Items []struct {
				N          float64          `json:"n"`
				State      string           `json:"state"`
				Amendments int              `json:"amendments"`
				NeedsYou   map[string]any   `json:"needs_you"`
				Actions    []map[string]any `json:"actions"`
			} `json:"items"`
			Counts   map[string]int `json:"counts"`
			Machines struct {
				InUse int   `json:"in_use"`
				Slots []any `json:"slots"`
			} `json:"machines"`
		}
		require.NoError(t, json.Unmarshal(encoded, &home))
		var open []map[string]any
		counts, inUse := map[string]int{}, 0
		for _, card := range cards {
			state := card["state"].(string)
			if slices.Contains(homeStates, state) {
				counts[state]++
			}
			if state == "merged" || state == "dropped" {
				continue
			}
			open = append(open, card)
			if branch, ok := card["branch"].(map[string]any); ok {
				if machine := branch["machine"].(map[string]any)["state"]; machine == "awake" || machine == "waking" {
					inUse++
				}
			}
		}
		for _, state := range homeStates {
			require.Equal(t, counts[state], home.Counts[state], "seed %d: %s counted", seed, state)
		}
		require.Len(t, home.Counts, len(homeStates))
		require.Len(t, home.Items, len(open), "seed %d", seed)
		require.Equal(t, inUse, home.Machines.InUse, "seed %d", seed)
		require.Len(t, home.Machines.Slots, inUse)
		for i, item := range home.Items {
			card := open[i]
			require.Equal(t, card["n"], item.N, "seed %d: served order", seed)
			require.Equal(t, "todo", item.Actions[0]["tag"])
			require.Equal(t, "title", item.Actions[0]["args"].(map[string]any)["door"])
			merge := slices.ContainsFunc(item.Actions, func(action map[string]any) bool { return action["tag"] == "merge" })
			require.Equal(t, item.State == "in_review" && card["merge"].(map[string]any)["state"] == "ready", merge, "seed %d: Merge on T%v", seed, item.N)
			require.Equal(t, max(0, len(card["prompt_revisions"].([]any))-1), item.Amendments)
			require.Equal(t, len(card["waits"].([]any)) > 0, item.NeedsYou != nil)
		}
	}
}
