package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func TestInstallRaceObservationRequiresOrderingAndSentinel(t *testing.T) {
	names := installRaceScenarios()
	if len(names) != 45 {
		t.Fatal(len(names))
	}
	for _, name := range names {
		if !installRaceFixture(name) {
			t.Fatal(name)
		}
	}
	for _, bad := range []string{"install-race-root-owner", "install-race-boot-canary --root=/", "install-race-opt-../"} {
		if installRaceFixture(bad) {
			t.Fatal(bad)
		}
	}
	digest := sha256.Sum256([]byte("outside-fixture\x00"))
	base := map[string]any{"selector": "install-race-positive", "held_ns": 10, "mutation_start_ns": 11, "mutation_end_ns": 12, "worker_pid": 123,
		"before": map[string]any{"sha256": hex.EncodeToString(digest[:]), "uid": 20001, "mode": 416}, "after": map[string]any{"sha256": hex.EncodeToString(digest[:]), "uid": 20001, "mode": 416}}
	for _, key := range []string{"selector", "held_ns", "mutation_start_ns", "mutation_end_ns", "worker_pid", "before", "after"} {
		t.Run(key, func(t *testing.T) {
			bad := map[string]any{}
			for k, v := range base {
				bad[k] = v
			}
			delete(bad, key)
			body, _ := json.Marshal(bad)
			if requireInstallRaceSample(body, "install-race-positive") == nil {
				t.Fatal("missing observation passed")
			}
		})
	}
}

func TestInstallRacePositiveAndInvalidOrdering(t *testing.T) {
	digest := sha256.Sum256([]byte("outside-fixture\x00"))
	sentinel := map[string]any{"sha256": hex.EncodeToString(digest[:]), "uid": 20001, "mode": 416}
	for _, values := range [][3]int64{{10, 11, 12}, {0, 11, 12}, {10, 9, 12}, {10, 11, 10}} {
		body, _ := json.Marshal(map[string]any{"selector": "install-race-positive", "held_ns": values[0], "mutation_start_ns": values[1], "mutation_end_ns": values[2], "worker_pid": 123, "before": sentinel, "after": sentinel})
		err := requireInstallRaceSample(body, "install-race-positive")
		if (err == nil) != (values == [3]int64{10, 11, 12}) {
			t.Fatal(values, err)
		}
	}
}
