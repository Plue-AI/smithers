package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func cgroupLiveFixture(scenario string) bool {
	switch scenario {
	case "cgroup-live-parent-replaced", "cgroup-live-parent-writable", "cgroup-live-child-replaced", "cgroup-live-child-writable":
		return true
	default:
		return false
	}
}

// Installed authenticated relay only. Mutation happens after enrollment, while
// both foreground and lingering processes are independently observed. The
// observer holds the original events descriptors before the path is changed.
func validateLiveCgroupBoundary(ctx context.Context, control relayControl, observe func(string) ([]byte, error), scenario string, outside []byte, evidence string) error {
	if !cgroupLiveFixture(scenario) {
		return errAuthority
	}
	retain := func(name string, body []byte) error {
		return os.WriteFile(filepath.Join(evidence, name+".json"), body, 0600)
	}
	stream, err := control.connect(ctx)
	if err != nil {
		return err
	}
	defer stream.Close()
	if _, err = controlExchange(stream, map[string]any{"type": "open_session", "kind": "exec", "argv": []string{"/bin/sh", "-c", "nohup sleep 10000 >/dev/null 2>&1 & exec sleep 100"}}); err != nil {
		return err
	}
	var old guestSnapshot
	ready := time.Now().Add(2 * time.Second)
	for {
		before, observeErr := observe("sample")
		if observeErr != nil {
			return observeErr
		}
		if err = retain("live-before", before); err != nil {
			return err
		}
		if json.Unmarshal(before, &old) != nil {
			return errors.New("invalid independent live cgroup sample")
		}
		if len(old.Processes) >= 2 && len(old.Cgroups) > 0 {
			break
		}
		if time.Now().After(ready) {
			return errors.New("foreground/background cgroup fixture did not become live")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	armed, err := observe("arm")
	if err != nil {
		return err
	}
	if err = retain("live-arm", armed); err != nil {
		return err
	}
	mutation, err := observe(scenario)
	if err != nil {
		return err
	}
	if err = retain("live-mutation", mutation); err != nil {
		return err
	}
	// Do not mistake a failed handshake, timeout or generic EOF for the specific
	// admission refusal: the live broker must return the invalid typed response.
	probe, err := control.connect(ctx)
	if err != nil {
		return err
	}
	request := []byte(`{"type":"open_session","kind":"exec","argv":["/bin/sh","-c","printf canary > /workspace/trm06-member-canary"]}`)
	refused, refusalErr := validationRefusal(probe, request, uint32(len(request)))
	probe.Close()
	if err = retain("live-admission-refusal", refused); err != nil {
		return err
	}
	if refusalErr != nil {
		return refusalErr
	}
	if string(refused) == `{"transport_closed":true}` {
		return errors.New("live cgroup replacement lacked explicit admission refusal")
	}
	invoked := time.Now().UTC()
	revokeErr := control.revoke(ctx)
	// Preserve the independent original-group observations even on a NO revoke.
	drained, observeErr := observe("drain")
	if err = retain("live-drain", drained); err != nil {
		return errors.Join(revokeErr, observeErr, err)
	}
	if err = retain("live-revoke", []byte(`{"invoked_utc":`+quoteUTC(invoked)+`}`)); err != nil {
		return err
	}
	if revokeErr != nil || observeErr != nil {
		return errors.Join(revokeErr, observeErr)
	}
	if err = validateLiveCgroupDrain(drained, old.Cgroups, invoked); err != nil {
		return err
	}
	boundary, err := observe("boundary-sample")
	if err != nil {
		return err
	}
	if err = retain("live-boundary", boundary); err != nil {
		return err
	}
	var state struct {
		Canary *bool `json:"member_canary_exists"`
	}
	if json.Unmarshal(boundary, &state) != nil || state.Canary == nil || *state.Canary {
		return errors.New("member payload ran after cgroup replacement")
	}
	return compareOutside(outside, boundary)
}

func quoteUTC(value time.Time) string {
	body, _ := json.Marshal(value.Format(time.RFC3339Nano))
	return string(body)
}

func validateLiveCgroupDrain(raw []byte, groups map[string]string, invoked time.Time) error {
	var result struct {
		Sample *struct {
			Processes *[]json.RawMessage `json:"processes"`
		} `json:"sample"`
		Observation struct {
			Groups  []string          `json:"groups"`
			Zero    map[string]string `json:"zero"`
			Samples []json.RawMessage `json:"samples"`
		} `json:"observation"`
	}
	if json.Unmarshal(raw, &result) != nil || len(groups) == 0 || result.Sample == nil || result.Sample.Processes == nil || len(*result.Sample.Processes) != 0 {
		return errors.New("independent live cgroup drain unavailable")
	}
	seen := map[string]bool{}
	for _, name := range result.Observation.Groups {
		if seen[name] {
			return errors.New("duplicate independently observed group")
		}
		seen[name] = true
	}
	if len(seen) != len(groups) {
		return errors.New("original cgroup observer set changed")
	}
	for name, original := range groups {
		stamp, exists := result.Observation.Zero[name]
		zero, err := time.Parse(time.RFC3339Nano, stamp)
		if !seen[name] || !exists || err != nil || !containsPopulatedOne(original) || zero.Before(invoked) || zero.Sub(invoked) > 5*time.Second || !zeroHasRawSample(name, stamp, result.Observation.Samples) {
			return errors.New("original live cgroup lacks timed independent populated 0")
		}
	}
	return nil
}

func containsPopulatedOne(events string) bool {
	// Require actual live controls; an already empty group proves no revocation.
	for _, line := range strings.Split(events, "\n") {
		if line == "populated 1" {
			return true
		}
	}
	return false
}
