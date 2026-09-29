package services

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestCanaryComponent(t *testing.T) {
	now := time.Date(2026, time.September, 29, 12, 0, 0, 0, time.UTC)
	window := 15 * time.Minute
	success := func(at time.Time) CanaryRun {
		return CanaryRun{Status: "success", CompletedAt: at, FreshnessWindow: window}
	}
	failure := func(at time.Time) CanaryRun {
		return CanaryRun{Status: "failure", CompletedAt: at, FreshnessWindow: window}
	}

	for _, tc := range []struct {
		name       string
		runs       []CanaryRun
		err        error
		wantStatus string
		detailPart string
	}{
		{"no completed suites", nil, nil, "unknown", "no recorded"},
		{"missing suite", []CanaryRun{success(now.Add(-time.Minute)), {}}, nil, "unknown", "missing"},
		{"source failure", nil, errors.New("private database address and token"), "unknown", ""},
		{"fresh success", []CanaryRun{success(now.Add(-time.Minute))}, nil, "ok", ""},
		{"exact freshness boundary", []CanaryRun{success(now.Add(-window))}, nil, "ok", ""},
		{"stale success", []CanaryRun{success(now.Add(-window - time.Nanosecond))}, nil, "unknown", "stale"},
		{"fresh failure", []CanaryRun{failure(now.Add(-time.Minute))}, nil, "error", ""},
		{"failure and success", []CanaryRun{failure(now.Add(-time.Minute)), success(now.Add(-time.Minute))}, nil, "error", ""},
		{"stale outranks failure", []CanaryRun{failure(now.Add(-time.Minute)), success(now.Add(-window - time.Nanosecond))}, nil, "unknown", "stale"},
		{"missing outranks failure", []CanaryRun{failure(now.Add(-time.Minute)), {}}, nil, "unknown", "missing"},
		{"invalid status", []CanaryRun{{Status: "running", CompletedAt: now.Add(-time.Minute), FreshnessWindow: window}}, nil, "unknown", ""},
		{"zero timestamp", []CanaryRun{success(time.Time{})}, nil, "unknown", ""},
		{"future timestamp", []CanaryRun{success(now.Add(time.Nanosecond))}, nil, "unknown", ""},
		{"zero freshness window", []CanaryRun{{Status: "success", CompletedAt: now, FreshnessWindow: 0}}, nil, "unknown", ""},
		{"negative freshness window", []CanaryRun{{Status: "success", CompletedAt: now, FreshnessWindow: -time.Second}}, nil, "unknown", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			component := CanaryComponent(tc.runs, tc.err, now)
			assert.Equal(t, tc.wantStatus, component.Status)
			assert.NotEmpty(t, component.Detail)
			if tc.detailPart != "" {
				assert.Contains(t, strings.ToLower(component.Detail), tc.detailPart)
			}
			assert.NotContains(t, component.Detail, "private database address and token")
		})
	}
}
