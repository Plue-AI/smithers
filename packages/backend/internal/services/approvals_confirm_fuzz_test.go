package services

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

// FuzzConfirmationTodo: a terminal's TODO is either refused (400 invalid_todo
// or 403 permission) or normalized to a value that stays inside the TODO's
// bounds, holds only valid UTF-8 with no NUL, is appended from no issue, and
// is unchanged by a second pass and by the JSON round trip a replay compares
// (RequestConfirmation stores it and compares the stored JSON on replay).
func FuzzConfirmationTodo(f *testing.F) {
	f.Add("Follow-up", "Add a farewell to t3.md", "", "", false, int64(0), "")
	f.Add("  padded  ", "x", "append", "a line", false, int64(0), "")
	f.Add("", "x", "", "", false, int64(0), "")
	f.Add("t", " \n\t", "", "", false, int64(0), "")
	f.Add("t", "p", "before", "", false, int64(2), "")
	f.Add("t", "p", "amend", "", false, int64(0), "")
	f.Add("t", "p", "", "", true, int64(0), "")
	f.Add("t\x00", "p", "", "", false, int64(0), "")
	f.Add("\xff\xfe", "p\xc3", "", "\xed\xa0\x80", false, int64(0), "")
	f.Add(strings.Repeat("é", 128), "p", "", "", false, int64(0), "")
	f.Add(strings.Repeat("\xff", 86), "p", "", "", false, int64(0), "")
	f.Add("t", strings.Repeat("p", 64<<10+1), "", "", false, int64(0), "")
	f.Add("<script>&", "  ", "", "\\u0000", false, int64(0), "digest")
	f.Fuzz(func(t *testing.T, title, prompt, mode, line string, issue bool, n int64, digest string) {
		input := MythicalTodoInput{Title: title, Prompt: prompt, Place: MythicalTodoPlace{Mode: mode}, IssueDigest: digest, Request: "k"}
		if line != "" {
			input.Acceptance = []string{line}
		}
		if n != 0 {
			input.Place.N = &n
		}
		if issue {
			number := int64(7)
			input.Issue = &number
		}
		got, err := confirmationTodo(input)
		if err != nil {
			var control *TodoControlError
			var access *AccessError
			switch {
			case errors.As(err, &control) && control.Status == 400 && control.Code == "invalid_todo":
			case errors.As(err, &access) && access.Status == 403 && access.Code == "permission":
			default:
				t.Fatalf("refusal %T %v is neither 400 invalid_todo nor 403 permission", err, err)
			}
			return
		}
		if issue || digest != "" || n != 0 || mode != "" && mode != "append" {
			t.Fatalf("accepted a TODO placed %q before %d or made from an issue", mode, n)
		}
		texts := append([]string{got.Title, got.Prompt}, got.Acceptance...)
		for _, text := range texts {
			if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
				t.Fatalf("accepted text %q", text)
			}
		}
		if got.Title == "" || got.Title != strings.TrimSpace(got.Title) || len(got.Title) > 256 || strings.TrimSpace(got.Prompt) == "" || len(got.Prompt) > 64<<10 {
			t.Fatalf("accepted out-of-bounds title %q or prompt of %d bytes", got.Title, len(got.Prompt))
		}
		if got.Place.Mode != "append" || got.Place.N != nil || got.Issue != nil || got.Fixes != nil || got.IssueDigest != "" || got.Acceptance == nil || got.Request != "k" {
			t.Fatalf("accepted %+v", got)
		}
		again, err := confirmationTodo(got)
		if err != nil {
			t.Fatalf("a second pass refused %+v: %v", got, err)
		}
		first, _ := json.Marshal(got)
		second, _ := json.Marshal(again)
		if string(first) != string(second) {
			t.Fatalf("a second pass changed %s to %s", first, second)
		}
		var stored MythicalTodoInput
		if err = json.Unmarshal(first, &stored); err != nil {
			t.Fatalf("the stored JSON %s does not decode: %v", first, err)
		}
		replayed, _ := json.Marshal(stored)
		if string(replayed) != string(first) {
			t.Fatalf("the JSON round trip changed %s to %s", first, replayed)
		}
	})
}
