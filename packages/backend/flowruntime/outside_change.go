package flowruntime

import (
	_ "embed"
	"encoding/json"
)

// The host and backend share this build-time switch. Enable only with the
// pinned durable consumer and daemon stale-write enforcement composed.
//
//go:generate node generate-outside-change.mjs
//go:embed outside_change.json
var outsideChangePolicy []byte

func OutsideChangeConsumerEnabled() bool {
	var policy struct {
		Enabled bool `json:"enabled"`
	}
	return json.Unmarshal(outsideChangePolicy, &policy) == nil && policy.Enabled
}
