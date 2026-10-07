package main

import (
	"encoding/json"
	"testing"
)

func TestCompletedBudgetMiss(t *testing.T) {
	cells := []map[string]any{}
	for _, load := range []string{"idle", "busy"} {
		for _, count := range []int{0, 1, 12, 200} {
			cells = append(cells, map[string]any{"load": load, "changed_files": count, "stats": map[string]any{"n": 100, "p95_ns": 600000000}})
		}
	}
	data, _ := json.Marshal(map[string]any{"cells": cells, "idle_12_file_gate_passed": false})
	if !completedBudgetMiss(1, data) {
		t.Fatal("completed miss must allow remaining observations")
	}
	for _, input := range []string{`{`, `{}`, `{"idle_12_file_gate_passed":false,"cells":[]}`, `{"idle_12_file_gate_passed":true}`} {
		if completedBudgetMiss(1, []byte(input)) {
			t.Fatalf("accepted incomplete/passing summary %s", input)
		}
	}
	cells[7] = cells[0]
	data, _ = json.Marshal(map[string]any{"cells": cells, "idle_12_file_gate_passed": false})
	if completedBudgetMiss(1, data) {
		t.Fatal("duplicate cell accepted")
	}
	for _, tc := range []struct {
		input string
		want  bool
	}{
		{`{"growth_budget_passed":false,"captures":1000,"cycles":[{"captures":5760},{"captures":5760},{"captures":5760}],"versions":{"n":100,"p95_ns":1}}`, true},
		{`{"growth_budget_passed":true,"captures":1000,"cycles":[{"captures":5760},{"captures":5760},{"captures":5760}],"versions":{"n":100,"p95_ns":1}}`, false},
		{`{"growth_budget_passed":false,"captures":999,"versions":{"n":100,"p95_ns":1}}`, false},
		{`{"growth_budget_passed":false,"captures":1000,"cycles":[{"captures":5760},{"captures":5760},{"captures":5760}],"versions":{"n":99,"p95_ns":1}}`, false},
		{`{"growth_budget_passed":false,"captures":1000,"cycles":[{"captures":5760},{"captures":5760},{"captures":5760}],"versions":{"n":100,"p95_ns":0}}`, false},
	} {
		if got := completedBudgetMiss(2, []byte(tc.input)); got != tc.want {
			t.Fatalf("%s got %v", tc.input, got)
		}
		if completedBudgetMiss(0, []byte(tc.input)) {
			t.Fatal("preparation failure accepted")
		}
	}
}

func TestGuestProfileAdmission(t *testing.T) {
	for _, input := range []string{`{`, `{}`, `{"uid":0,"system":"Linux","machine":"aarch64"}`, `{"uid":19999,"system":"Darwin","machine":"aarch64"}`, `{"uid":19999,"system":"Linux","machine":"x86_64"}`, `{"uid":"19999","system":"Linux","machine":"aarch64"}`} {
		if validateGuestProfile([]byte(input)) == nil {
			t.Fatalf("accepted unqualified guest: %s", input)
		}
	}
	if err := validateGuestProfile([]byte(`{"uid":19999,"system":"Linux","machine":"aarch64"}`)); err != nil {
		t.Fatal(err)
	}
}
