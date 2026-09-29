package services

import (
	"context"
	"time"
)

// CanaryRun is the latest completed run of one deployment canary suite. A
// missing run has a zero CompletedAt. FreshnessWindow follows that suite's
// configured cadence, including its execution deadline.
type CanaryRun struct {
	Status          string
	CompletedAt     time.Time
	FreshnessWindow time.Duration
}

// CanaryRunSource returns one entry per expected suite, including missing runs.
// Deployment adapters own run storage; product code owns the public verdict.
type CanaryRunSource interface {
	LatestCanaryRuns(context.Context) ([]CanaryRun, error)
}

type StatusComponent struct {
	Status string `json:"status"`
	Detail string `json:"detail"`
}

// CanaryComponent never publishes private run identifiers or upstream errors.
// Unknown or stale evidence takes precedence over a known failure: the watcher
// must distinguish a live, failing suite from a blind reporting pipeline.
func CanaryComponent(runs []CanaryRun, sourceErr error, now time.Time) StatusComponent {
	unknown := StatusComponent{Status: "unknown", Detail: "no recorded canary runs"}
	if sourceErr != nil {
		return StatusComponent{Status: "unknown", Detail: "canary runs unavailable"}
	}
	if len(runs) == 0 {
		return unknown
	}
	missing, stale, invalid, failed := false, false, false, false
	for _, run := range runs {
		switch {
		case run.CompletedAt.IsZero():
			missing = true
		case run.CompletedAt.After(now), run.FreshnessWindow <= 0:
			invalid = true
		case now.Sub(run.CompletedAt) > run.FreshnessWindow:
			stale = true
		case run.Status == "failure":
			failed = true
		case run.Status != "success":
			invalid = true
		}
	}
	switch {
	case missing:
		return StatusComponent{Status: "unknown", Detail: "canary run missing"}
	case invalid:
		return StatusComponent{Status: "unknown", Detail: "canary run invalid"}
	case stale:
		return StatusComponent{Status: "unknown", Detail: "latest canary run is stale"}
	case failed:
		return StatusComponent{Status: "error", Detail: "latest canary run failed"}
	default:
		return StatusComponent{Status: "ok", Detail: "latest canary runs passed"}
	}
}
