package chat

import (
	"encoding/json"
	"math"
	"slices"
)

// uiInstructionFields lists the UI-only flows an app-agent turn may run on its
// author's own screen (spec §14.1.4, mvp.md Appendix B.1) and the payload
// fields each declares. It mirrors packages/rpc/src/UiInstruction.ts; both
// are checked against the generated catalog.
var uiInstructionFields = map[string][]string{
	"box.facet":            {"workspaceId", "facet"},
	"card.dismiss":         {"cardId"},
	"card.history.back":    {"cardId"},
	"card.history.forward": {"cardId"},
	"change.facet":         {"changeId", "facet"},
	"chat.reload":          {},
	"flow.plan.select":     {"cardId", "nodeId"},
	"flow.plan.tab":        {"cardId", "tab"},
	"form.set":             {"cardId", "field", "value"},
	"help":                 {},
	"prs.tab":              {"cardId", "tab"},
	"runs.coding.select":   {"sourceCard", "runId", "changeId"},
	"runs.graph.execution": {"sourceCard", "runId", "executionId"},
	"runs.graph.follow":    {"sourceCard", "runId", "follow"},
	"runs.graph.select":    {"sourceCard", "runId", "nodeId"},
	"runs.graph.tab":       {"sourceCard", "runId", "tab"},
	"runs.steps":           {"sourceCard", "runId"},
	"runs.trace.filter":    {"sourceCard", "runId", "filter"},
	"runs.trace.live":      {"sourceCard", "runId"},
	"runs.trace.select":    {"sourceCard", "runId", "nodeId", "seq"},
	"runs.trace.view":      {"sourceCard", "runId", "view", "state"},
	"search.changes":       {"query"},
	"search.files":         {"query"},
	"search.flows":         {"query"},
	"search.history":       {"query"},
	"search.issues":        {"query"},
	"search.runs":          {"query"},
	"search.wiki":          {"query"},
	"storage.recovery":     {},
	"theme":                {"mode"},
	"wiki.backlinks":       {"path"},
	"wiki.graph":           {"path"},
	"wiki.open":            {"path"},
	"wiki.space":           {"space", "repo"},
	"wiki.view":            {"view"},
}

// validUIInstruction checks a settled call's optional `ui` field: the call's
// own UI-only command beside its declared fields. Only runs.trace.view carries
// the structured per-member monitor selection declared by the catalog.
func validUIInstruction(frame map[string]any) bool {
	instruction, present := frame["ui"]
	if !present {
		return true
	}
	ui, ok := instruction.(map[string]any)
	if !ok {
		return false
	}
	command, ok := ui["command"].(string)
	if !ok || command != frame["name"] {
		return false
	}
	declared, ok := uiInstructionFields[command]
	if !ok {
		return false
	}
	for field, value := range ui {
		if field == "command" {
			continue
		}
		if !slices.Contains(declared, field) {
			return false
		}
		if command == "runs.trace.view" && field == "state" {
			if value == nil {
				continue
			}
			state, ok := value.(map[string]any)
			if !ok {
				return false
			}
			for key, entry := range state {
				switch key {
				case "selected":
					if _, ok := entry.(string); !ok && entry != nil {
						return false
					}
				case "at":
					if entry == nil {
						continue
					}
					n, ok := entry.(json.Number)
					if !ok {
						return false
					}
					position, err := n.Float64()
					if err != nil || position < 0 || math.IsInf(position, 0) || math.Trunc(position) != position {
						return false
					}
				case "tab":
					if entry != nil && entry != "run" && entry != "journal" && entry != "custom" {
						return false
					}
				default:
					return false
				}
			}
			continue
		}
		switch value.(type) {
		case string, bool, json.Number:
		default:
			return false
		}
	}
	return true
}

// uiInstruction is one committed request as the author's view state serves it.
type uiInstruction struct {
	ID      string                     `json:"id"`
	Command string                     `json:"command"`
	Payload map[string]json.RawMessage `json:"payload"`
}

// decodeUIInstruction splits a committed `ui` field into its command and payload.
func decodeUIInstruction(id string, raw json.RawMessage) (uiInstruction, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return uiInstruction{}, ErrCorrupt
	}
	var command string
	if err := json.Unmarshal(fields["command"], &command); err != nil || command == "" {
		return uiInstruction{}, ErrCorrupt
	}
	delete(fields, "command")
	return uiInstruction{ID: id, Command: command, Payload: fields}, nil
}
