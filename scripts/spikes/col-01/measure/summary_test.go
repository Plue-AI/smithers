package measure

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func TestSummaryNearestRank(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values []int64
		want   Stats
	}{
		{"single", []int64{7}, Stats{N: 1, P50NS: 7, P95NS: 7, P99NS: 7, MinNS: 7, MaxNS: 7}},
		{"two", []int64{9, 1}, Stats{N: 2, P50NS: 1, P95NS: 9, P99NS: 9, MinNS: 1, MaxNS: 9}},
		{"duplicates", []int64{4, 4, 1, 4, 2}, Stats{N: 5, P50NS: 4, P95NS: 4, P99NS: 4, MinNS: 1, MaxNS: 4}},
		{"twenty", descending(20), Stats{N: 20, P50NS: 10, P95NS: 19, P99NS: 20, MinNS: 1, MaxNS: 20}},
		{"hundred", descending(100), Stats{N: 100, P50NS: 50, P95NS: 95, P99NS: 99, MinNS: 1, MaxNS: 100}},
		{"hundred_one", descending(101), Stats{N: 101, P50NS: 51, P95NS: 96, P99NS: 100, MinNS: 1, MaxNS: 101}},
		{"max_nanoseconds", []int64{math.MaxInt64}, Stats{N: 1, P50NS: math.MaxInt64, P95NS: math.MaxInt64, P99NS: math.MaxInt64, MinNS: math.MaxInt64, MaxNS: math.MaxInt64}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := append([]int64(nil), tc.values...)
			got, err := Summary(tc.values)
			if err != nil || got != tc.want {
				t.Fatalf("Summary = %+v, %v; want %+v", got, err, tc.want)
			}
			if !reflect.DeepEqual(tc.values, before) {
				t.Fatal("Summary mutated input")
			}
		})
	}
}

func TestSummaryRejectsInvalidSamples(t *testing.T) {
	for _, values := range [][]int64{nil, {}, {0}, {-1}, {1, 0, 2}, {1, -1, 2}, {math.MinInt64}} {
		before := append([]int64(nil), values...)
		got, err := Summary(values)
		if err == nil || got != (Stats{}) {
			t.Fatalf("Summary(%v) = %+v, %v; want zero stats and error", values, got, err)
		}
		if len(values) > 0 && !reflect.DeepEqual(values, before) {
			t.Fatal("invalid input mutated")
		}
	}
}

func TestSummaryRetainsEverySampleAndJSONUnits(t *testing.T) {
	got, err := Summary([]int64{1000000, 1, 2})
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"n":3,"p50_ns":2,"p95_ns":1000000,"p99_ns":1000000,"min_ns":1,"max_ns":1000000}`
	if string(b) != want {
		t.Fatalf("JSON = %s; want %s", b, want)
	}
}

func descending(n int) []int64 {
	values := make([]int64, n)
	for i := range values {
		values[i] = int64(n - i)
	}
	return values
}
