package chat

import (
	"encoding/json"
	"math"
)

// Validate only the transport envelope here. The packaged recall/model host
// owns selection and the RPC schema; Go never ranks or reads candidate files.
func validPreflight(value any) bool {
	result, ok := value.(map[string]any)
	if !ok {
		return false
	}
	model, ok := result["model"].(string)
	if !ok || model == "" {
		return false
	}
	duration, ok := result["durationMs"].(json.Number)
	if !ok {
		return false
	}
	ms, err := duration.Float64()
	if err != nil || ms < 0 || math.IsInf(ms, 0) || math.IsNaN(ms) {
		return false
	}
	for _, field := range []string{"context", "candidates"} {
		items, ok := result[field].([]any)
		if !ok {
			return false
		}
		for _, value := range items {
			item, ok := value.(map[string]any)
			if !ok {
				return false
			}
			kind, ok := item["kind"].(string)
			if !ok || !oneOf(kind, "file", "page", "todo", "run", "issue") {
				return false
			}
			if _, ok := item["label"].(string); !ok {
				return false
			}
			if _, ok := item["ref"].(string); !ok {
				return false
			}
			if revision, exists := item["revision"]; exists {
				if _, ok := revision.(string); !ok {
					return false
				}
			}
			if field == "context" {
				reason, ok := item["reason"].(string)
				if !ok || reason == "" {
					return false
				}
			}
		}
	}
	return true
}
