// Package measure summarizes raw latency samples and transports bounded frames.
package measure

import (
	"fmt"
	"sort"
)

// Stats reports nearest-rank percentiles in the samples' original nanoseconds.
type Stats struct {
	N     int   `json:"n"`
	P50NS int64 `json:"p50_ns"`
	P95NS int64 `json:"p95_ns"`
	P99NS int64 `json:"p99_ns"`
	MinNS int64 `json:"min_ns"`
	MaxNS int64 `json:"max_ns"`
}

// Summary retains every positive sample and never modifies the caller's slice.
func Summary(values []int64) (Stats, error) {
	if len(values) == 0 {
		return Stats{}, fmt.Errorf("latency samples are empty")
	}
	for i, value := range values {
		if value <= 0 {
			return Stats{}, fmt.Errorf("latency sample %d is not positive: %d", i, value)
		}
	}
	ordered := append([]int64(nil), values...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	n := len(ordered)
	percentile := func(percent int) int64 {
		// ceil(n*percent/100), arranged to avoid overflowing n*percent.
		rank := (n/100)*percent + ((n%100)*percent+99)/100
		return ordered[rank-1]
	}
	return Stats{N: n, P50NS: percentile(50), P95NS: percentile(95), P99NS: percentile(99), MinNS: ordered[0], MaxNS: ordered[n-1]}, nil
}
