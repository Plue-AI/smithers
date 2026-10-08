package main

import (
	"encoding/json"
	"errors"
)

// Literal installed fixture selectors; never caller-selected paths or code.
func installRaceScenarios() []string {
	names := []string{"install-race-positive"}
	for _, parent := range []string{"opt", "opt-parent", "run", "run-parent", "prototype", "state"} {
		for _, mutation := range []string{"symlink", "clone", "held-leaves", "writable", "owner"} {
			names = append(names, "install-race-"+parent+"-"+mutation)
		}
	}
	for _, leaf := range []string{"supervisor", "boot"} {
		for _, mutation := range []string{"canary", "fifo", "directory", "hardlink", "same-size", "writable", "owner"} {
			names = append(names, "install-race-"+leaf+"-"+mutation)
		}
	}
	return names
}
func installRaceFixture(name string) bool {
	for _, selector := range installRaceScenarios() {
		if selector == name {
			return true
		}
	}
	return false
}

func requireInstallRaceSample(body []byte, selector string) error {
	var sample struct {
		Selector string          `json:"selector"`
		Held     int64           `json:"held_ns"`
		Start    int64           `json:"mutation_start_ns"`
		End      int64           `json:"mutation_end_ns"`
		Worker   int             `json:"worker_pid"`
		Before   json.RawMessage `json:"before"`
		After    json.RawMessage `json:"after"`
	}
	if !installRaceFixture(selector) || decodeStrict(body, &sample) != nil || sample.Selector != selector || sample.Held <= 0 || sample.Start < sample.Held || sample.End < sample.Start || sample.Worker <= 0 {
		return errors.New("installed replacement synchronization sample unavailable")
	}
	before, _ := json.Marshal(map[string]json.RawMessage{"outside": sample.Before})
	after, _ := json.Marshal(map[string]json.RawMessage{"outside": sample.After})
	return compareOutside(before, after)
}
