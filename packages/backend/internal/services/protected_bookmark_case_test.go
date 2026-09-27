package services

import "testing"

func TestBookmarkPatternsAndRefsCompareWithoutCase(t *testing.T) {
	for _, tc := range []struct {
		pattern, bookmark string
		want              bool
	}{
		{"Release-*", "release-1", true},
		{"release-*", "RELEASE-2", true},
		{"release", "Release", true},
		{"release-*", "main", false},
	} {
		if got, err := bookmarkMatchesPattern(tc.pattern, tc.bookmark); err != nil || got != tc.want {
			t.Errorf("bookmarkMatchesPattern(%q, %q) = %v, %v", tc.pattern, tc.bookmark, got, err)
		}
	}
	for ref, want := range map[string]string{
		"refs/heads/main": "main",
		"refs/Heads/main": "main",
		"refs/ſheads/x":   "", // not refs/heads
		"refs/headſ/Main": "Main",
		"refs/tags/v1":    "",
		"refs/heads/":     "",
	} {
		got, ok := BookmarkNameFromRef(ref)
		if got != want || ok != (want != "") {
			t.Errorf("BookmarkNameFromRef(%q) = %q, %v", ref, got, ok)
		}
	}
	if !isMythicalBookmark("My‌thical") {
		t.Error("an ignorable character is part of no ref name")
	}
}
