package compose

import (
	"bytes"
	"encoding/json"

	"github.com/smithersai/smithers/packages/backend/internal/live"
)

// Compare semantic snapshot bytes, including row metadata. JSONB and the card
// builder order object keys differently; that must not create extra snapshots.
func liveSnapshotKey(data json.RawMessage) json.RawMessage {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return nil
	}
	key, _ := json.Marshal(value)
	return key
}

func liveCardRefresh(source live.Source, field string) live.Source {
	source.RefreshSnapshot = liveSnapshotKey
	source.RefreshDelta = func(previous, event json.RawMessage) json.RawMessage {
		if len(previous) == 0 {
			return nil
		}
		var fact struct{ Data map[string]json.RawMessage }
		if json.Unmarshal(event, &fact) != nil {
			return nil
		}
		projection := fact.Data[field]
		if len(projection) == 0 {
			return nil
		}
		if field == "card" {
			return liveSnapshotKey(projection)
		}
		var model, patch map[string]json.RawMessage
		if json.Unmarshal(previous, &model) != nil || json.Unmarshal(projection, &patch) != nil {
			return nil
		}
		for key, value := range patch {
			model[key] = value
		}
		merged, _ := json.Marshal(model)
		return liveSnapshotKey(merged)
	}
	return source
}
