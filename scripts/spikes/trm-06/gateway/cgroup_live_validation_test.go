package main

import (
	"encoding/json"
	"testing"
	"time"
)

func TestLiveCgroupDrainRequiresOriginalTimedKernelObservations(t *testing.T) {
	invoked := time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)
	name := "s-0000000000000001"
	groups := map[string]string{name: "populated 1\nfrozen 0\n"}
	makeReceipt := func(stamp time.Time, population string, processes []int, observed []string, rawName string) []byte {
		value := stamp.Format(time.RFC3339Nano)
		body, err := json.Marshal(map[string]any{
			"sample":      map[string]any{"processes": processes},
			"observation": map[string]any{"groups": observed, "zero": map[string]string{name: value}, "samples": []any{map[string]any{"utc": value, "events": map[string]string{rawName: population}}}},
		})
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	for _, duration := range []time.Duration{0, time.Second, 5 * time.Second} {
		if err := validateLiveCgroupDrain(makeReceipt(invoked.Add(duration), "populated 0\n", []int{}, []string{name}, name), groups, invoked); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name      string
		stamp     time.Time
		events    string
		processes []int
		observed  []string
		rawName   string
	}{
		{"early", invoked.Add(-time.Nanosecond), "populated 0\n", []int{}, []string{name}, name},
		{"late", invoked.Add(5*time.Second + time.Nanosecond), "populated 0\n", []int{}, []string{name}, name},
		{"live", invoked, "populated 1\n", []int{}, []string{name}, name},
		{"missing", invoked, "", []int{}, []string{name}, name},
		{"survivor", invoked, "populated 0\n", []int{123}, []string{name}, name},
		{"wrong group", invoked, "populated 0\n", []int{}, []string{"s-0000000000000002"}, name},
		{"duplicate", invoked, "populated 0\n", []int{}, []string{name, name}, name},
		{"extra", invoked, "populated 0\n", []int{}, []string{name, "s-0000000000000002"}, name},
		{"wrong raw", invoked, "populated 0\n", []int{}, []string{name}, "s-0000000000000002"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateLiveCgroupDrain(makeReceipt(tc.stamp, tc.events, tc.processes, tc.observed, tc.rawName), groups, invoked); err == nil {
				t.Fatal("invalid observation passed")
			}
		})
	}
	good := makeReceipt(invoked, "populated 0\n", []int{}, []string{name}, name)
	for _, invalid := range [][]byte{nil, []byte(`{`), []byte(`{}`), []byte(`{"sample":{"processes":[]},"observation":null}`)} {
		if err := validateLiveCgroupDrain(invalid, groups, invoked); err == nil {
			t.Fatal("missing receipt passed")
		}
	}
	for _, original := range []map[string]string{nil, {}, {name: "populated 0\n"}, {name: "not populated 1\n"}} {
		if err := validateLiveCgroupDrain(good, original, invoked); err == nil {
			t.Fatal("no independent live control passed")
		}
	}
}

func TestLiveCgroupSelectorsAreFixed(t *testing.T) {
	for _, selector := range []string{"cgroup-live-ancestor-replaced", "cgroup-live-ancestor-writable", "cgroup-live-parent-replaced", "cgroup-live-parent-writable", "cgroup-live-child-replaced", "cgroup-live-child-writable", "cgroup-live-parent-owner", "cgroup-live-child-owner", "cgroup-live-ancestor-owner"} {
		if !cgroupLiveFixture(selector) || cgroupRestartFixture(selector) {
			t.Fatal("live mutation routed to restart fixture")
		}
	}
	for _, selector := range []string{"", "../cgroup-live-parent-replaced", "cgroup-parent-replaced", "cgroup-live-parent-replaced --pid=1"} {
		if cgroupLiveFixture(selector) {
			t.Fatal("caller selector accepted")
		}
	}
}

func TestCloseRetainsExactLingeringProcessOwnership(t *testing.T) {
	process := func(pid int, group string) json.RawMessage {
		raw, err := json.Marshal(map[string]any{"pid": pid, "cgroup": group})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	group := "0::/smithers/trm06-sessions-original/s-0000000000000001\n"
	before := guestSnapshot{Processes: []json.RawMessage{process(101, group), process(102, group)}}
	after := guestSnapshot{Processes: []json.RawMessage{process(102, group), process(101, group)}}
	if err := validateLingeringCgroupSample(before, after); err != nil {
		t.Fatal(err)
	}
	for _, processes := range [][]json.RawMessage{
		nil, {process(101, group)}, {process(101, group), process(103, group)},
		{process(101, group), process(102, "0::/other\n")},
		{process(101, group), process(101, group)},
		{process(0, group), process(102, group)},
		{process(101, ""), process(102, group)},
		{json.RawMessage(`{`), process(102, group)},
	} {
		if err := validateLingeringCgroupSample(before, guestSnapshot{Processes: processes}); err == nil {
			t.Fatalf("lost ownership accepted: %s", processes)
		}
	}
}

func TestRestartCgroupControlsDoNotRouteToLiveCampaign(t *testing.T) {
	for _, name := range []string{"cgroup-writable", "cgroup-parent-replaced", "cgroup-child-writable", "cgroup-ancestor-replaced", "cgroup-ancestor-writable", "cgroup-ancestor-owner", "cgroup-parent-owner", "cgroup-child-owner"} {
		if !cgroupRestartFixture(name) || cgroupLiveFixture(name) {
			t.Fatalf("restart selector: %s", name)
		}
	}
	for _, name := range []string{"", "../cgroup-child-owner", "cgroup-ancestor-owner-root", "cgroup-child-owner --pid=1"} {
		if cgroupRestartFixture(name) {
			t.Fatalf("caller selector: %s", name)
		}
	}
}
