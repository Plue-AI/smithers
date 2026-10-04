package services

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Supplemental port test: this is not PostgreSQL or C-J8-01 evidence.
type learningFixture struct {
	pages, notes, lessons int
	done                  bool
	fail                  bool
}

func (s *learningFixture) Transaction(ctx context.Context, run func(LearningTransaction) error) error {
	next := *s
	if err := run(&next); err != nil {
		return err
	}
	*s = next
	return nil
}
func (s *learningFixture) Receipt(context.Context, LearningBinding) (bool, error) { return s.done, nil }
func (s *learningFixture) Page(context.Context, LearningBinding, LearningPage) error {
	s.pages++
	return nil
}
func (s *learningFixture) Proposal(context.Context, LearningBinding, LearningProposal, time.Time) (bool, error) {
	s.notes++
	return true, nil
}
func (s *learningFixture) RecordReceipt(_ context.Context, _ LearningBinding, lessons int) error {
	if s.fail {
		return errors.New("injected transaction failure")
	}
	s.lessons = lessons
	s.done = true
	return nil
}
func TestLearningReceiptReplayAndRollback(t *testing.T) {
	binding := LearningBinding{Repository: "smithers/canary", Todo: 7, Run: "learning-7", State: "merged"}
	output := LearningOutput{Repository: "smithers/canary", Todo: 7, Run: "learning-7",
		Pages:     []LearningPage{{Title: "Retry", Body: "Use the existing helper because it backs off; PR #41; attempt-1; attempt-2"}},
		Proposals: []LearningProposal{{Signature: "check:lint@review", Title: "Run lint", Prompt: "Run lint before review", Evidence: []string{"3 of the last 5"}, Todos: []int64{3, 5, 7}}}}
	store := &learningFixture{fail: true}
	if err := CommitLearning(context.Background(), store, binding, output, time.Now()); err == nil {
		t.Fatal("failure missing")
	}
	if store.pages != 0 || store.notes != 0 || store.lessons != 0 || store.done {
		t.Fatal("partial receipt")
	}
	store.fail = false
	for i := 0; i < 2; i++ {
		if err := CommitLearning(context.Background(), store, binding, output, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	if store.pages != 1 || store.notes != 1 || store.lessons != 2 {
		t.Fatalf("duplicate receipt: %+v", store)
	}
}
func TestLearningRefusesUnavailableAndWrongBinding(t *testing.T) {
	binding := LearningBinding{Repository: "smithers/canary", Todo: 7, Run: "learning-7", State: "merged"}
	output := LearningOutput{Repository: "smithers/canary", Todo: 7, Run: "learning-7"}
	if !errors.Is(CommitLearning(context.Background(), nil, binding, output, time.Now()), ErrLearningUnavailable) {
		t.Fatal("missing adapter must refuse")
	}
	for _, invalid := range []LearningBinding{
		{Repository: "other/canary", Todo: 7, Run: "learning-7", State: "merged"},
		{Repository: "smithers/canary", Todo: 8, Run: "learning-7", State: "merged"},
		{Repository: "smithers/canary", Todo: 7, Run: "other", State: "merged"},
		{Repository: "smithers/canary", Todo: 7, Run: "learning-7", State: "working"},
	} {
		store := &learningFixture{}
		if !errors.Is(CommitLearning(context.Background(), store, invalid, output, time.Now()), ErrLearningBinding) {
			t.Fatal("binding accepted")
		}
		if store.done {
			t.Fatal("write before validation")
		}
	}
}
func TestLearningDismissalWindow(t *testing.T) {
	now := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	for _, row := range []struct {
		days       int
		suppressed bool
	}{{30, true}, {90, true}, {91, false}, {-1, true}} {
		at := now.Add(-time.Duration(row.days) * 24 * time.Hour)
		if got := LearningSuppressed("rejected", &at, now); got != row.suppressed {
			t.Fatalf("%d days: %v", row.days, got)
		}
	}
	if !LearningSuppressed("pending", nil, now) || !LearningSuppressed("rejected", nil, now) || LearningSuppressed("accepted", nil, now) {
		t.Fatal("note status policy")
	}
}
