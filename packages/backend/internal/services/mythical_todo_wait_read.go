package services

import "github.com/smithersai/smithers/packages/backend/internal/db"

// todoWaitCards retains every durable wait, including evidence on terminal
// TODOs. Only a question that is still open can offer Answer.
func todoWaitCards(item db.MythicalItem) []map[string]any {
	open := map[string]bool{}
	for _, wait := range todoOpenWaits(item) {
		open[wait.ID] = true
	}
	cards := []map[string]any{}
	for _, wait := range mythicalChecksOf(item).Waits {
		actions := []any{}
		if open[wait.ID] && wait.SettledAt == nil && wait.Kind == "question" && wait.Signal != nil {
			actions = append(actions, map[string]any{"tag": "todo.answer", "label": "Answer",
				"input": []any{map[string]any{"name": "answer", "label": "Answer", "kind": "text", "required": true}}})
		}
		card := map[string]any{"id": wait.ID, "kind": wait.Kind, "prompt": wait.Prompt, "since": wait.Since, "actions": actions}
		if len(wait.By) != 0 {
			card["by"] = wait.By
		}
		if wait.AnsweredBy != "" {
			card["answered_by"] = wait.AnsweredBy
		}
		if wait.SettledAt != nil {
			card["settled_at"] = *wait.SettledAt
		}
		cards = append(cards, card)
	}
	return cards
}
