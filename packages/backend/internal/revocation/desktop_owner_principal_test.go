package revocation

import "testing"

func TestDesktopOwnerPrincipalAffectsOnlyOwnerAccountAndRepositoryRevocations(t *testing.T) {
	principal := Principal{UserID: 2, OwnerUserID: 1, RepositoryID: 9, WorkspaceID: "ws-desktop"}
	for _, tc := range []struct {
		name  string
		event Event
		want  bool
	}{
		{name: "owner disabled", event: Event{Kind: KindUserDisabled, UserID: 1}, want: true},
		{name: "creator disabled", event: Event{Kind: KindUserDisabled, UserID: 2}, want: true},
		{name: "other user disabled", event: Event{Kind: KindUserDisabled, UserID: 3}},
		{name: "owner collaborator removed", event: Event{Kind: KindCollaboratorRemoved, UserID: 1, RepositoryID: 9}, want: true},
		{name: "creator collaborator removed", event: Event{Kind: KindCollaboratorRemoved, UserID: 2, RepositoryID: 9}, want: true},
		{name: "owner different repository", event: Event{Kind: KindCollaboratorRemoved, UserID: 1, RepositoryID: 10}},
		{name: "other collaborator removed", event: Event{Kind: KindCollaboratorRemoved, UserID: 3, RepositoryID: 9}},
		{name: "owner share removed", event: Event{Kind: KindWorkspaceShareRemoved, UserID: 1, WorkspaceID: "ws-desktop", SandboxIDs: []string{"vm-desktop"}}},
		{name: "creator share removed", event: Event{Kind: KindWorkspaceShareRemoved, UserID: 2, WorkspaceID: "ws-desktop"}, want: true},
		{name: "other share removed", event: Event{Kind: KindWorkspaceShareRemoved, UserID: 3, WorkspaceID: "ws-desktop"}},
		{name: "creator different workspace", event: Event{Kind: KindWorkspaceShareRemoved, UserID: 2, WorkspaceID: "ws-other"}},
		{name: "owner organization member removed", event: Event{Kind: KindOrgMemberRemoved, UserID: 1, OrganizationID: 8}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.event.Affects(principal); got != tc.want {
				t.Fatalf("Affects(%+v) = %v, want %v", tc.event, got, tc.want)
			}
		})
	}
}

func TestDesktopPrincipalAffectedByOwnerOrCreatorOrganizationRemoval(t *testing.T) {
	principal := Principal{UserID: 2, OwnerUserID: 1, RepositoryID: 9, OrganizationID: 8, WorkspaceID: "ws-desktop"}
	for _, tc := range []struct {
		name  string
		event Event
		want  bool
	}{
		{name: "owner removed", event: Event{Kind: KindOrgMemberRemoved, UserID: 1, OrganizationID: 8}, want: true},
		{name: "creator removed", event: Event{Kind: KindOrgMemberRemoved, UserID: 2, OrganizationID: 8}, want: true},
		{name: "other member removed", event: Event{Kind: KindOrgMemberRemoved, UserID: 3, OrganizationID: 8}},
		{name: "owner removed from another organization", event: Event{Kind: KindOrgMemberRemoved, UserID: 1, OrganizationID: 7}},
		{name: "creator removed from another organization", event: Event{Kind: KindOrgMemberRemoved, UserID: 2, OrganizationID: 7}},
		{name: "unscoped removal", event: Event{Kind: KindOrgMemberRemoved, UserID: 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.event.Affects(principal); got != tc.want {
				t.Fatalf("Affects(%+v) = %v, want %v", tc.event, got, tc.want)
			}
		})
	}
	// A user-owned repository's desktop carries no organization and is never
	// matched by an organization removal.
	userOwned := principal
	userOwned.OrganizationID = 0
	if (Event{Kind: KindOrgMemberRemoved, UserID: 1, OrganizationID: 8}).Affects(userOwned) {
		t.Fatal("organization removal matched a desktop without an organization")
	}
}
