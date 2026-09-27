package repohost

import (
	"strings"
	"testing"
)

func TestReservedWorkspaceSourcesAreImmutableAndOwned(t *testing.T) {
	mine := "0f8fad5b-d9cb-469f-a165-70867728950e"
	other := "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	id, different, zero := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("0", 40)
	for _, tc := range []struct {
		name, owner, ref, old, next string
		denied                      bool
	}{
		{"create", mine, WorkspaceSourceRef(mine, id), zero, id, false},
		{"replay", mine, WorkspaceSourceRef(mine, id), id, id, false},
		{"wrong owner", other, WorkspaceSourceRef(mine, id), zero, id, true},
		{"user", "", WorkspaceSourceRef(mine, id), zero, id, true},
		{"delete", mine, WorkspaceSourceRef(mine, id), id, zero, true},
		{"repoint", mine, WorkspaceSourceRef(mine, id), id, different, true},
		{"mismatched initial target", mine, WorkspaceSourceRef(mine, id), zero, different, true},
		{"already corrupted target", mine, WorkspaceSourceRef(mine, id), different, id, true},
		{"noncanonical workspace", mine, WorkspaceSourceRef(strings.ToUpper(mine), id), zero, id, true},
		{"malformed commit", mine, WorkspaceSourceRef(mine, "abc"), zero, id, true},
		{"root", mine, WorkspaceSourceRef(mine, zero), zero, zero, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			message := ReservedRefViolation([]ReceivePackCommand{{RefName: tc.ref, OldOID: tc.old, NewOID: tc.next}}, tc.owner, 0)
			if (message != "") != tc.denied {
				t.Fatalf("violation=%q denied=%v", message, tc.denied)
			}
		})
	}
}

func TestWorkspaceIDFromHeadRef(t *testing.T) {
	id := "0f8fad5b-d9cb-469f-a165-70867728950e"
	got, ok := WorkspaceIDFromHeadRef(WorkspaceHeadRef(id))
	if !ok || got != id {
		t.Fatalf("round trip = %q, %v", got, ok)
	}
	for _, ref := range []string{
		"refs/heads/main",
		"refs/smithers/workspaces/" + id,
		"refs/smithers/workspaces/" + id + "/head/extra",
		"refs/smithers/workspaces/not-a-uuid/head",
		"refs/smithers/workspaces//head",
		"refs/smithers/other/" + id + "/head",
	} {
		if _, ok := WorkspaceIDFromHeadRef(ref); ok {
			t.Fatalf("%q parsed as a workspace head ref", ref)
		}
	}
}

func TestReservedRefViolation(t *testing.T) {
	mine := "0f8fad5b-d9cb-469f-a165-70867728950e"
	other := "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	cases := []struct {
		name      string
		refs      []string
		workspace string
		denied    bool
	}{
		{"user pushes bookmark", []string{"refs/heads/main"}, "", false},
		{"user pushes tag", []string{"refs/tags/v1"}, "", false},
		{"user pushes reserved head", []string{WorkspaceHeadRef(mine)}, "", true},
		{"user pushes arbitrary reserved ref", []string{"refs/smithers/anything"}, "", true},
		{"workspace pushes own head", []string{WorkspaceHeadRef(mine)}, mine, false},
		{"workspace pushes own head upper-case token id", []string{WorkspaceHeadRef(mine)}, "0F8FAD5B-D9CB-469F-A165-70867728950E", false},
		{"workspace pushes other head", []string{WorkspaceHeadRef(other)}, mine, true},
		{"workspace pushes bookmark", []string{"refs/heads/main"}, mine, true},
		{"workspace pushes head and bookmark", []string{WorkspaceHeadRef(mine), "refs/heads/main"}, mine, true},
		{"workspace pushes malformed reserved ref", []string{"refs/smithers/workspaces/" + mine}, mine, true},
		{"user deletes jj retention pin", []string{"refs/jj/keep/0123456789abcdef0123456789abcdef01234567"}, "", true},
		{"user plants jj ref", []string{"refs/jj/anything"}, "", true},
		{"workspace pushes jj retention pin", []string{"refs/jj/keep/0123456789abcdef0123456789abcdef01234567"}, mine, true},
		{"empty command list", nil, mine, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			commands := make([]ReceivePackCommand, 0, len(tc.refs))
			for _, ref := range tc.refs {
				commands = append(commands, ReceivePackCommand{RefName: ref, OldOID: "0", NewOID: "1"})
			}
			msg := ReservedRefViolation(commands, tc.workspace, 0)
			if (msg != "") != tc.denied {
				t.Fatalf("violation=%q denied=%v", msg, tc.denied)
			}
		})
	}
}

// The mythical stack's refs belong to the stack service: only a control-plane
// push writes them, and a control-plane push writes nothing else.
func TestControlPlaneRefViolation(t *testing.T) {
	mine := "0f8fad5b-d9cb-469f-a165-70867728950e"
	cases := []struct {
		name         string
		refs         []string
		workspace    string
		controlPlane bool
		denied       bool
	}{
		{"user pushes the mythical bookmark", []string{MythicalBookmarkRef}, "", false, true},
		{"user deletes the mythical notes", []string{MythicalNotesRef}, "", false, true},
		{"user plants a mythical pin", []string{MythicalReservedRefNS + "keep/abc"}, "", false, true},
		{"workspace pushes the mythical bookmark", []string{MythicalBookmarkRef}, mine, false, true},
		{"workspace claims to be the control plane", []string{MythicalBookmarkRef}, mine, true, true},
		{"control plane writes the stack", []string{MythicalBookmarkRef, MythicalNotesRef}, "", true, false},
		{"control plane writes a pin", []string{MythicalReservedRefNS + "keep/abc"}, "", true, false},
		{"control plane cannot write main", []string{MythicalBookmarkRef, "refs/heads/main"}, "", true, true},
		{"control plane cannot write a workspace head", []string{WorkspaceHeadRef(mine)}, "", true, true},
		{"control plane cannot write jj refs", []string{"refs/jj/keep/x"}, "", true, true},
		{"user pushes other bookmarks as before", []string{"refs/heads/mythical-notes", "refs/heads/myth"}, "", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			commands := make([]ReceivePackCommand, 0, len(tc.refs))
			for _, ref := range tc.refs {
				commands = append(commands, ReceivePackCommand{RefName: ref, OldOID: "0", NewOID: "1"})
			}
			msg := ControlPlaneRefViolation(commands, tc.workspace, 0, tc.controlPlane)
			if (msg != "") != tc.denied {
				t.Fatalf("violation=%q denied=%v", msg, tc.denied)
			}
		})
	}
	if ReservedRefViolation([]ReceivePackCommand{{RefName: MythicalBookmarkRef}}, "", 0) == "" {
		t.Fatal("the ordinary policy must refuse the mythical bookmark")
	}
}

// A user's pushed local work (#1964) lives under that user's numeric id and
// nobody else's credential may write there.
func TestUserRefViolation(t *testing.T) {
	workspace := "0f8fad5b-d9cb-469f-a165-70867728950e"
	cases := []struct {
		name         string
		refs         []string
		workspace    string
		pusher       int64
		controlPlane bool
		denied       bool
	}{
		{"owner creates", []string{UserRef(42, "head")}, "", 42, false, false},
		{"owner nests a name", []string{UserRef(42, "feature/x.y_z-1")}, "", 42, false, false},
		{"owner writes two", []string{UserRef(42, "a"), UserRef(42, "b")}, "", 42, false, false},
		{"another user", []string{UserRef(42, "head")}, "", 43, false, true},
		{"no pusher", []string{UserRef(42, "head")}, "", 0, false, true},
		{"workspace credential of the owner", []string{UserRef(42, "head")}, workspace, 42, false, true},
		{"control plane", []string{UserRef(42, "head")}, "", 42, true, true},
		{"owner with main", []string{UserRef(42, "head"), "refs/heads/main"}, "", 42, false, false},
		{"no name", []string{UserRefPrefix + "42/"}, "", 42, false, true},
		{"bare id", []string{UserRefPrefix + "42"}, "", 42, false, true},
		{"prefix only", []string{UserRefPrefix}, "", 42, false, true},
		{"non-canonical id", []string{UserRefPrefix + "042/head"}, "", 42, false, true},
		{"login instead of id", []string{UserRefPrefix + "will/head"}, "", 42, false, true},
		{"dot segment", []string{UserRefPrefix + "42/a/../b"}, "", 42, false, true},
		{"lock suffix", []string{UserRefPrefix + "42/head.lock"}, "", 42, false, true},
		{"hidden segment", []string{UserRefPrefix + "42/.head"}, "", 42, false, true},
		{"empty segment", []string{UserRefPrefix + "42/a//b"}, "", 42, false, true},
		{"double dot inside", []string{UserRefPrefix + "42/a..b"}, "", 42, false, true},
		{"trailing dot", []string{UserRefPrefix + "42/head."}, "", 42, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			commands := make([]ReceivePackCommand, 0, len(tc.refs))
			for _, ref := range tc.refs {
				commands = append(commands, ReceivePackCommand{RefName: ref, OldOID: "0", NewOID: "1"})
			}
			msg := ControlPlaneRefViolation(commands, tc.workspace, tc.pusher, tc.controlPlane)
			if (msg != "") != tc.denied {
				t.Fatalf("violation=%q denied=%v", msg, tc.denied)
			}
		})
	}
}

func TestRefNamesCompareWithoutCase(t *testing.T) {
	for _, ref := range []string{"refs/heads/Mythical", "refs/heads/MYTHICAL", " refs/Heads/mythical", "refs/notes/Mythical", "refs/smithers/MYTHICAL/pin"} {
		if !IsMythicalRef(ref) {
			t.Errorf("IsMythicalRef(%q) = false", ref)
		}
	}
	if !SameRef("refs/heads/Main", "refs/heads/main") || SameRef("refs/heads/main", "refs/heads/maine") {
		t.Error("SameRef compares without case, and only that")
	}
	for _, ref := range []string{"refs/JJ/keep/x", "refs/Smithers/workspaces/x/head"} {
		if ReservedRefViolation([]ReceivePackCommand{{RefName: ref}}, "", 1) == "" {
			t.Errorf("%s is reserved whatever its case", ref)
		}
	}
}

func TestCaseVariantRefs(t *testing.T) {
	existing := []string{"refs/heads/main", "refs/heads/feature/a", "refs/tags/v1"}
	for ref, want := range map[string]string{
		"refs/heads/main":      "",
		"refs/heads/other":     "",
		"refs/heads/feature/b": "",
		"refs/heads/Main":      "refs/heads/main",
		"refs/heads/Feature/b": "refs/heads/feature",
		"refs/Heads/x":         "refs/heads",
		"refs/heads/main/x":    "",
	} {
		if got := CaseVariantRefs([]string{ref}, existing); got != want {
			t.Errorf("CaseVariantRefs(%q) = %q, want %q", ref, got, want)
		}
	}
	if got := CaseVariantRefs([]string{"refs/heads/new", "refs/heads/NEW"}, existing); got != "refs/heads/new" {
		t.Errorf("a push's own refs collide: got %q", got)
	}
	// Variants stored before the rule still update under their own names.
	if got := CaseVariantRefs([]string{"refs/heads/Old"}, []string{"refs/heads/old", "refs/heads/Old"}); got != "" {
		t.Errorf("exact existing ref refused: %q", got)
	}
}
