package services

import (
	"errors"
	"testing"
)

func TestMovedOffDetection(t *testing.T) {
	history := []ItemPosition{{false, false, "off"}, {true, true, "pre-move"}, {true, true, "older"}}
	for _, tc := range []struct {
		name                     string
		present, descends, moved bool
	}{
		{"git checkout main", true, false, true}, {"git switch from main", true, false, true},
		{"jj edit main identical tree", true, false, true}, {"jj new main", true, false, true},
		{"jj abandon item", false, false, true}, {"missing change", false, true, true},
		{"git commit on item", true, true, false}, {"jj new on item", true, true, false},
		{"rebase keeps change id", true, true, false}, {"git branch same commit", true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fact, err := DetectMovedOff("T2", "Maya", ItemPosition{tc.present, tc.descends, "now"}, history, nil)
			if err != nil {
				t.Fatal(err)
			}
			if !tc.moved {
				if fact != nil {
					t.Fatal(fact)
				}
				return
			}
			if *fact != (MovedOffFact{"Maya", "T2", "pre-move"}) {
				t.Fatal(fact)
			}
		})
	}
}

func TestMovedOffRecoveryAndRedelivery(t *testing.T) {
	prior := &MovedOffFact{"Maya", "T2", "original"}
	fact, err := DetectMovedOff("T2", "Ben", ItemPosition{}, nil, prior)
	if err != nil || fact == prior || *fact != *prior {
		t.Fatalf("%v %v", fact, err)
	}
	fact.By = "changed"
	if prior.By != "Maya" {
		t.Fatal("aliased persisted fact")
	}
	for _, item := range []string{"", "T2"} {
		fact, err = DetectMovedOff(item, "Ben", ItemPosition{true, true, "returned"}, nil, prior)
		if fact != nil || err != nil {
			t.Fatalf("%v %v", fact, err)
		}
	}
	for _, prior := range []*MovedOffFact{nil, {Item: "T3", PreMoveCommit: "wrong"}, {Item: "T2"}} {
		fact, err = DetectMovedOff("T2", "Ben", ItemPosition{}, []ItemPosition{{true, true, ""}}, prior)
		if fact != nil || !errors.Is(err, ErrMovedOffHistoryUnavailable) {
			t.Fatalf("%v %v", fact, err)
		}
	}
}

func TestMovedOffCaptureAndActivation(t *testing.T) {
	for _, tc := range []struct {
		fact               *MovedOffFact
		captured, expected string
		fails              bool
	}{
		{nil, "item-head", "off-head", false}, {&MovedOffFact{}, "item-head", "item-head", false},
		{&MovedOffFact{}, "", "", true},
	} {
		head, err := MovedOffCaptureTarget(tc.fact, tc.captured, "off-head")
		if head != tc.expected || (err != nil) != tc.fails {
			t.Fatalf("%s %v", head, err)
		}
	}
	if !errors.Is(ActivateMovedOff(), ErrMovedOffProviderUnavailable) {
		t.Fatal("activated absent guest authority")
	}
}
