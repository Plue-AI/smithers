package live

import "encoding/json"

// KeptProjections are the run projections an install keeps from a lane's
// coding host, so a run reads after its lane stops: what Inspect reads of a
// run (spec §11.6).
var KeptProjections = map[string]bool{"run-summary": true, "run-events": true, "run-tree": true, "transcript": true, "approvals": true}

// RunProjection reads a relay Projection.Snapshot payload: it answers the
// projection and run when the payload's one key is a selector naming a kept
// projection of one run.
func RunProjection(payload json.RawMessage) (tag, run string, ok bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil || len(fields) != 1 || fields["selector"] == nil {
		return "", "", false
	}
	var selector struct {
		Tag   string `json:"_tag"`
		RunID string `json:"runId"`
	}
	if json.Unmarshal(fields["selector"], &selector) != nil || !KeptProjections[selector.Tag] || selector.RunID == "" {
		return "", "", false
	}
	return selector.Tag, selector.RunID, true
}
