package main

import (
	"errors"
	"time"
)

// Child replacement selectors need live children; a successful simultaneous
// revoke can remove them before mutation. Parent/ancestor selectors instead
// remain well-defined under either ordering, including after all children exit.
func cgroupRevokeRaceFixture(scenario string) bool {
	switch scenario {
	case "cgroup-live-ancestor-replaced", "cgroup-live-ancestor-writable", "cgroup-live-ancestor-owner",
		"cgroup-live-parent-replaced", "cgroup-live-parent-writable", "cgroup-live-parent-owner":
		return true
	default:
		return false
	}
}

type cgroupRaceOperation struct {
	Started   time.Time `json:"started_utc"`
	Completed time.Time `json:"completed_utc"`
	Raw       []byte    `json:"raw,omitempty"`
	Failure   string    `json:"failure,omitempty"`
	err       error
}

type cgroupRevokeRace struct {
	Released   time.Time           `json:"released_utc"`
	Mutation   cgroupRaceOperation `json:"mutation"`
	Revocation cgroupRaceOperation `json:"revocation"`
}

func (r cgroupRevokeRace) validateOverlap() error {
	if r.Released.IsZero() || r.Mutation.Started.Before(r.Released) || r.Revocation.Started.Before(r.Released) ||
		!r.Mutation.Completed.After(r.Mutation.Started) || !r.Revocation.Completed.After(r.Revocation.Started) ||
		!r.Mutation.Started.Before(r.Revocation.Completed) || !r.Revocation.Started.Before(r.Mutation.Completed) {
		return errors.New("cgroup mutation and revocation did not overlap")
	}
	return nil
}

// Release both installed operations only after each worker is waiting. No
// supervisor pause hook, credential bypass or alternate control transport is
// introduced. Both operations finish even on failure, retaining the timelines
// and raw mutation observations. The caller independently checks the original
// cgroup descriptors and the five-second bound from Revocation.Started.
func synchronizedCgroupRevoke(mutate func() ([]byte, error), revoke func() error) cgroupRevokeRace {
	ready := make(chan struct{}, 2)
	start := make(chan struct{})
	mutation := make(chan cgroupRaceOperation, 1)
	revocation := make(chan cgroupRaceOperation, 1)
	launch := func(operation func() ([]byte, error), result chan<- cgroupRaceOperation) {
		ready <- struct{}{}
		<-start
		sample := cgroupRaceOperation{Started: time.Now().UTC()}
		sample.Raw, sample.err = operation()
		sample.Completed = time.Now().UTC()
		if sample.err != nil {
			sample.Failure = sample.err.Error()
		}
		result <- sample
	}
	go launch(mutate, mutation)
	go launch(func() ([]byte, error) { return nil, revoke() }, revocation)
	<-ready
	<-ready
	result := cgroupRevokeRace{Released: time.Now().UTC()}
	close(start)
	result.Mutation, result.Revocation = <-mutation, <-revocation
	return result
}
