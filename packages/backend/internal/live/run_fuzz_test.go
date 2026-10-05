package live

import (
	"encoding/json"
	"testing"
)

// RunProjection reads a browser's relay payload: whatever it is given, it
// accepts only a payload whose one key is a kept run projection's selector
// naming a run, and answers that projection and run.
func FuzzRunProjection(f *testing.F) {
	for _, seed := range []string{
		`{"selector":{"_tag":"run-summary","runId":"run-1"}}`,
		`{"selector":{"_tag":"run-events","runId":""}}`,
		`{"selector":{"_tag":"node-output","runId":"run-1"}}`,
		`{"selector":{"_tag":"run-tree","runId":"run-1"},"after":1}`,
		`{"selector":null}`, `[]`, `null`, `{"selector":{"_tag":"transcript","runId":"x","extra":true}}`,
		`{"selector":{"_tag":"approvals","runId":"run-1"},"selector":{"_tag":"x"}}`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, payload []byte) {
		tag, run, ok := RunProjection(payload)
		if !ok {
			if tag != "" || run != "" {
				t.Fatalf("a refused payload named %q %q", tag, run)
			}
			return
		}
		if !KeptProjections[tag] || run == "" {
			t.Fatalf("accepted %q %q from %s", tag, run, payload)
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(payload, &fields) != nil || len(fields) != 1 || fields["selector"] == nil {
			t.Fatalf("accepted a payload that is not one selector: %s", payload)
		}
		var selector struct {
			Tag   string `json:"_tag"`
			RunID string `json:"runId"`
		}
		if json.Unmarshal(fields["selector"], &selector) != nil || selector.Tag != tag || selector.RunID != run {
			t.Fatalf("answered %q %q for selector %s", tag, run, fields["selector"])
		}
	})
}

func TestRunProjectionReadsOneKeptSelector(t *testing.T) {
	for payload, want := range map[string]string{
		`{"selector":{"_tag":"run-summary","runId":"run-1"}}`:          "run-summary run-1",
		`{"selector":{"_tag":"transcript","runId":"run-9","extra":1}}`: "transcript run-9",
		`{"selector":{"_tag":"node-output","runId":"run-1"}}`:          "",
		`{"selector":{"_tag":"run-tree","runId":"run-1"},"after":5}`:   "",
		`{"selector":{"_tag":"run-events"}}`:                           "",
		`{}`:                                                           "",
	} {
		tag, run, ok := RunProjection(json.RawMessage(payload))
		got := ""
		if ok {
			got = tag + " " + run
		}
		if got != want {
			t.Errorf("%s: got %q, want %q", payload, got, want)
		}
	}
}
