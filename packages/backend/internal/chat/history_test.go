package chat

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestConversationMetadataOnlyRestoresUserVisiblePrompt(t *testing.T) {
	cases := []struct {
		name, request, id, text string
		invalid                 bool
	}{
		{"legacy", `{"messages":[{"role":"user","content":"first"},{"role":"assistant","content":"private history"},{"type":"function_call_output","output":"private result"},{"role":"user","content":"last"}],"instructions":"private instruction"}`, "run", "last", false},
		{"branch", `{"conversationId":"branch","messages":[{"role":"user","content":"visible"}]}`, "branch", "visible", false},
		{"empty", `{}`, "run", "", false},
		{"untyped messages", `{"messages":{}}`, "run", "", false},
		{"untyped message", `{"messages":[null,{"role":"user","content":7}]}`, "run", "", false},
		{"invalid identity", `{"conversationId":""}`, "", "", true},
		{"wrong identity type", `{"conversationId":5}`, "", "", true},
		{"non-object", `[]`, "", "", true},
		{"malformed", `{`, "", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, canonical, _ := parseCanonical(json.RawMessage(c.request))
			turn := turnRecord{RunID: "run", Request: json.RawMessage(c.request), RequestHash: digestCanonical("request", canonical)}
			id, text, err := conversationMetadata(turn)
			if c.invalid {
				if !errors.Is(err, ErrCorrupt) {
					t.Fatalf("expected corruption, got %v", err)
				}
				return
			}
			if err != nil || id != c.id || text != c.text {
				t.Fatalf("metadata=(%q,%q,%v)", id, text, err)
			}
			turn.RequestHash = strings.Repeat("0", 64)
			if _, _, err = conversationMetadata(turn); !errors.Is(err, ErrCorrupt) {
				t.Fatalf("unverified request metadata=%v", err)
			}
		})
	}
}

func TestAccountHistoryAuthorityKeepsAccountAndRetirementFences(t *testing.T) {
	for _, scope := range []Scope{{}, {UserID: 1}, {UserID: -1, Owner: "owner"}, {UserID: 1, Owner: strings.Repeat("x", 161)}} {
		if _, err := accountHash(scope); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid scope accepted: %v", err)
		}
	}
	hash, err := accountHash(Scope{UserID: 1, Owner: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	wrong := strings.Repeat("0", 64)
	for _, owner := range []*string{nil, &wrong} {
		if !errors.Is(authorizeAccount(turnRecord{OwnerHash: owner}, hash), ErrForbidden) {
			t.Fatal("wrong account accepted")
		}
	}
	if err = authorizeAccount(turnRecord{OwnerHash: &hash, State: StateRetired}, hash); !errors.Is(err, ErrRetired) {
		t.Fatal(err)
	}
	if err = authorizeAccount(turnRecord{OwnerHash: &hash, State: StateCompleted}, hash); err != nil {
		t.Fatal(err)
	}
}
