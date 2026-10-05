package services

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// fuzzSteers are up to eight steers drawn from the fuzzer's text and bytes:
// each byte picks a steer's attempt (low 2 bits, 1..4) and whether it is
// pending its run's attach (bit 2); texts repeat to reach the feedback bound.
func fuzzSteers(texts string, shape []byte, repeat uint16) []todoSteer {
	parts := strings.Split(texts, "|")
	var steers []todoSteer
	for i, b := range shape {
		if i == 8 {
			break
		}
		text := parts[i%len(parts)]
		if i == 0 {
			text = strings.Repeat(text, int(repeat%2048)+1)
		}
		steers = append(steers, todoSteer{Text: text, Attempt: int32(b&3) + 1, Pending: b&4 != 0,
			Request: "k" + string(rune('a'+i)), At: time.Unix(int64(i), 0).UTC()})
	}
	return steers
}

// todoFeedback gives attempt every steer held for it or an earlier attempt,
// in order, except one pending its own attempt's attach; past the bound it
// keeps the newest whole bytes, cut at a rune start.
func FuzzTodoFeedback(f *testing.F) {
	f.Add("use the helper|keep it short|say hello", []byte{0, 1, 4, 5, 2}, uint16(0), uint8(2))
	f.Add("x", []byte{0, 0}, uint16(2047), uint8(1))
	f.Add("é漢🙂|b", []byte{1, 5, 0}, uint16(1500), uint8(2))
	f.Add("", []byte{}, uint16(0), uint8(1))
	f.Fuzz(func(t *testing.T, texts string, shape []byte, repeat uint16, at uint8) {
		attempt := int32(at%5) + 1
		steers := fuzzSteers(texts, shape, repeat)
		item := db.MythicalItem{Checks: mythicalChecks{Steers: steers}.encode()}
		var eligible []string
		for _, steer := range steers {
			if steer.Attempt < attempt || steer.Attempt == attempt && !steer.Pending {
				eligible = append(eligible, steer.Text)
			}
		}
		whole := strings.Join(eligible, "\n\n")
		feedback := todoFeedback(item, attempt)
		if len(whole) <= todoFeedbackBytes {
			if feedback != whole {
				t.Fatalf("feedback %q, want every eligible steer in order %q", feedback, whole)
			}
			return
		}
		if len(feedback) > todoFeedbackBytes || utf8.ValidString(whole) && len(feedback) < todoFeedbackBytes-utf8.UTFMax {
			t.Fatalf("feedback is %d bytes past a %d-byte join, want the newest %d", len(feedback), len(whole), todoFeedbackBytes)
		}
		if !strings.HasSuffix(whole, feedback) {
			t.Fatal("feedback is not the newest bytes of the eligible steers")
		}
		if utf8.ValidString(whole) && !utf8.ValidString(feedback) {
			t.Fatal("feedback cut a rune")
		}
	})
}

// todoAttachSteers sends each steer pending this attempt's attach exactly
// once, to the attached run under the launch's scope and target, and marks it
// sent; nothing else changes, and a second observation sends nothing.
func FuzzTodoAttachSteers(f *testing.F) {
	f.Add("a|b|c", []byte{4, 5, 0, 6}, uint8(1), false)
	f.Add("x", []byte{4, 4, 4}, uint8(1), true)
	f.Add("", []byte{}, uint8(3), false)
	f.Fuzz(func(t *testing.T, texts string, shape []byte, at uint8, ended bool) {
		attempt := int32(at%4) + 1
		steers := fuzzSteers(texts, shape, 0)
		item := db.MythicalItem{ID: pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, Attempt: attempt, RequestRunID: "run-9",
			Checks: mythicalChecks{Steers: steers, RunLaunched: true, RunAttached: true}.encode()}
		scope := jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}
		target := flowruntime.FlowRuntimeTarget{TenantID: "repository:5", PrincipalID: "user:9", WorkspaceID: "lane-1", BindingKind: mythicalBindingKind, BindingID: uuidString(item.ID)}
		state := jobs.StateWaiting
		if ended {
			state = jobs.StateCompleted
		}
		update := flowdispatch.ProjectionUpdate{State: state, Scope: scope, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "coding/request", Target: target}}
		next := item
		sent := todoAttachSteers(&next, mythicalProjection{Phase: "request"}, update, "run-9")
		after := mythicalChecksOf(next).Steers
		want := 0
		for i, before := range steers {
			due := !ended && before.Pending && before.Attempt == attempt
			if due {
				want++
				if after[i].Pending || after[i].Run != "run-9" {
					t.Fatalf("steer %d was due but is %+v", i, after[i])
				}
			} else if after[i].Pending != before.Pending || after[i].Run != before.Run {
				t.Fatalf("steer %d was not due but changed: %+v → %+v", i, before, after[i])
			}
		}
		if len(sent) != want {
			t.Fatalf("sent %d messages, want %d", len(sent), want)
		}
		ids := map[string]bool{}
		for _, signal := range sent {
			if signal.RunID != "run-9" || signal.Scope != scope || signal.Target != target || signal.FlowID != "coding/request" || signal.Steer == nil {
				t.Fatalf("message %+v is not for the attached run", signal)
			}
			if ids[signal.RequestID] || signal.Steer.MessageID != signal.RequestID {
				t.Fatalf("message id %q repeats or differs from its request", signal.RequestID)
			}
			ids[signal.RequestID] = true
			var authorization map[string]any
			if json.Unmarshal(signal.AuthorizationContext, &authorization) != nil {
				t.Fatal("authorization context is not JSON")
			}
		}
		again := next
		if resent := todoAttachSteers(&again, mythicalProjection{Phase: "request"}, update, "run-9"); len(resent) != 0 {
			t.Fatalf("a second observation sent %d more", len(resent))
		}
	})
}
