package services

import (
	"fmt"
	"strconv"
	"time"
)

// homeStates are the TODO states Home counts (TodoStateSchema).
var homeStates = []string{"queued", "starting", "working", "needs_you", "paused", "failed", "in_review", "merged", "dropped"}

// HomePlaceholderAvatar is @smthrs/rpc's PlaceholderAvatarUrl.
const HomePlaceholderAvatar = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIyNCIgZmlsbD0iI2RkZCIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTgiIHI9IjgiIGZpbGw9IiM4ODgiLz48cGF0aCBkPSJNOCA0NGExNiAxNiAwIDAgMSAzMiAwIiBmaWxsPSIjODg4Ii8+PC9zdmc+"

// HomeSyncCauses are main's row causes for a refused sync (HomeContainer).
var HomeSyncCauses = map[string]string{"permission": "GitHub App permission missing", "not_installed": "GitHub App not installed"}

// homeModel builds Home from the TODO cards (as GET /api/todos serves them)
// and the sync's health.
func HomeModel(repository string, todos []map[string]any, sync *GitHubSyncHealth) map[string]any {
	counts := map[string]any{}
	for _, state := range homeStates {
		counts[state] = 0
	}
	items := []any{}
	slots := []any{}
	for _, todo := range todos {
		state, _ := todo["state"].(string)
		if count, ok := counts[state].(int); ok {
			counts[state] = count + 1
		}
		if state == "merged" || state == "dropped" {
			continue
		}
		n, _ := todo["n"].(float64)
		args := map[string]any{"n": strconv.FormatInt(int64(n), 10)}
		actions := []any{map[string]any{"tag": "todo", "label": todo["title"], "args": map[string]any{"n": args["n"], "door": "title"}}}
		merge, _ := todo["merge"].(map[string]any)
		switch state {
		case "needs_you":
			actions = append(actions, map[string]any{"tag": "todo.answer", "label": "Answer", "args": args, "primary": true})
		case "in_review":
			if merge["state"] == "ready" {
				actions = append(actions, map[string]any{"tag": "merge", "label": "Merge", "args": args, "primary": true})
			} else {
				actions = append(actions, map[string]any{"tag": "todo", "label": "Review", "args": args})
			}
		case "failed":
			actions = append(actions, map[string]any{"tag": "todo.retry", "label": "Retry", "args": args})
		case "paused":
			actions = append(actions, map[string]any{"tag": "todo.resume", "label": "Resume", "args": args})
		}
		item := map[string]any{"n": todo["n"], "title": todo["title"], "state": todo["state"], "owner": todo["owner"], "merge": todo["merge"],
			"present": todo["present"], "actions": actions, "branch": map[string]any{"id": "", "name": ""}}
		for _, field := range []string{"place", "queue", "step", "rebase_pending", "approval_cleared", "lessons"} {
			if value, ok := todo[field]; ok {
				item[field] = value
			}
		}
		if waits, _ := todo["waits"].([]any); len(waits) > 0 {
			if wait, ok := waits[0].(map[string]any); ok {
				item["needs_you"] = map[string]any{"kind": wait["kind"], "prompt": wait["prompt"]}
			}
		}
		if pr, ok := todo["pr"].(map[string]any); ok {
			item["pr"] = map[string]any{"number": pr["number"], "draft": pr["draft"]}
		}
		revisions, _ := todo["prompt_revisions"].([]any)
		item["amendments"] = max(0, len(revisions)-1)
		if branch, ok := todo["branch"].(map[string]any); ok {
			item["branch"] = map[string]any{"id": branch["id"], "name": branch["name"]}
			machine, _ := branch["machine"].(map[string]any)
			if machine["state"] == "awake" || machine["state"] == "waking" {
				slots = append(slots, map[string]any{"branch": branch["name"], "awake": machine["state"] == "awake",
					"actor": map[string]any{"kind": "agent", "id": fmt.Sprintf("agent:%v", branch["id"]), "agent": "coding", "avatar_url": HomePlaceholderAvatar,
						"for_member": todo["owner"], "todo": todo["n"], "color_index": 6}})
			}
		}
		items = append(items, item)
	}
	main := map[string]any{"sha": "", "title": "main", "last_success_at": time.Unix(0, 0).UTC().Format("2006-01-02T15:04:05.000Z"), "health": "limited"}
	// Health and pauses are authoritative even before the first successful read.
	if sync != nil {
		main["health"] = sync.State
		if sync.LastSuccessAt != nil {
			main["last_success_at"] = sync.LastSuccessAt.Format(time.RFC3339Nano)
		}
		if cause, ok := HomeSyncCauses[sync.Cause]; ok {
			main["cause"] = cause
		}
		if sync.RetryAt != nil {
			main["retry_at"] = sync.RetryAt.Format(time.RFC3339Nano)
		}
	}
	return map[string]any{
		"repository": repository, "main": main, "attention": []any{}, "items": items, "counts": counts,
		"merged_since_last_look": []any{}, "machines": map[string]any{"in_use": len(slots), "capacity": 0, "slots": slots},
		"background_runs": []any{},
	}
}
