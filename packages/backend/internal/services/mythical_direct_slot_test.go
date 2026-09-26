package services

import "testing"

func TestMythicalDirectSlot(t *testing.T) {
	for _, tc := range []struct {
		source    string
		busy, max int
		want      bool
	}{
		{"issue", 0, 1, true}, {"chat", 0, 1, true}, {"chat", 1, 1, false},
		{"issue", 0, 2, true}, {"issue", 1, 2, false}, {"chat", 1, 2, true}, {"chat", 2, 2, false},
		{"issue", 6, 8, true}, {"issue", 7, 8, false}, {"chat", 7, 8, true},
	} {
		if got := mythicalLaunchSlot(tc.source, tc.busy, tc.max); got != tc.want {
			t.Fatalf("%+v: got %v", tc, got)
		}
	}
}
