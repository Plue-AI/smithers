package repohost

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// RefKey is the name every ref and bookmark guard compares: trimmed, without
// ignorable characters, and matched caselessly (NFC(fold(NFD(name)))). Git
// stores loose refs as files, and on a case-insensitive filesystem (macOS,
// Windows) refs/heads/Mythical is the file refs/heads/mythical, so names
// with one key are one ref.
func RefKey(name string) string {
	name = strings.TrimSpace(name)
	if isASCII(name) {
		return strings.ToLower(name)
	}
	name = strings.Map(func(r rune) rune {
		if IsIgnorableRune(r) {
			return -1
		}
		return r
	}, name)
	return norm.NFC.String(cases.Fold().String(norm.NFD.String(name)))
}

// IsIgnorableRune reports a character a filesystem may ignore in a name
// (default-ignorable code points such as U+200C, and other format
// characters). Repo-host refuses them in the refs it writes.
func IsIgnorableRune(r rune) bool {
	return unicode.In(r, unicode.Other_Default_Ignorable_Code_Point, unicode.Variation_Selector, unicode.Cf)
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// SameRef reports whether two ref or bookmark names are one ref.
func SameRef(a, b string) bool { return RefKey(a) == RefKey(b) }

// CaseVariantRefs returns the existing ref, or ref directory, that one of
// refs differs from only in case (each ref also checked against the ones
// before it), or "" when there is none. Repo-host refuses such a ref on
// every platform, so no write reaches another ref's file.
func CaseVariantRefs(refs, existing []string) string {
	// Only refs in a namespace (refs/<kind>) a written ref shares can
	// collide with it; the rest are never folded.
	namespaces := make(map[string]bool, len(refs))
	for _, ref := range refs {
		namespaces[refNamespaceKey(ref)] = true
	}
	known := refDirectory{}
	for _, name := range existing {
		if namespaces[refNamespaceKey(name)] {
			known.add(name)
		}
	}
	for _, ref := range refs {
		if variant := known.caseVariant(ref); variant != "" {
			return variant
		}
		known.add(ref)
	}
	return ""
}

// refNamespaceKey is the key of a ref's first two segments.
func refNamespaceKey(ref string) string {
	ref = strings.TrimSpace(ref)
	first, rest, _ := strings.Cut(ref, "/")
	second, _, _ := strings.Cut(rest, "/")
	return RefKey(first + "/" + second)
}

// refDirectory maps the key of every ref and ref directory to a stored
// spelling. A name stored exactly (two variants made before this rule)
// is never its own variant.
type refDirectory map[string]map[string]struct{}

func (d refDirectory) add(name string) {
	forRefPrefixes(name, func(prefix string) string {
		key := RefKey(prefix)
		if d[key] == nil {
			d[key] = map[string]struct{}{}
		}
		d[key][prefix] = struct{}{}
		return ""
	})
}

func (d refDirectory) caseVariant(ref string) string {
	return forRefPrefixes(ref, func(prefix string) string {
		stored := d[RefKey(prefix)]
		if _, exact := stored[prefix]; exact {
			return ""
		}
		for spelling := range stored {
			return spelling
		}
		return ""
	})
}

// forRefPrefixes calls visit with each directory of name and name itself,
// stopping at the first non-empty result.
func forRefPrefixes(name string, visit func(prefix string) string) string {
	name = strings.TrimSpace(name)
	for i := 0; i <= len(name); i++ {
		if i == len(name) || name[i] == '/' {
			if result := visit(name[:i]); result != "" {
				return result
			}
		}
	}
	return ""
}

// ReservedRefPrefix is the git ref namespace the control plane owns. Nothing
// under it is a bookmark or a tag: push hooks ignore it, jj import ignores it,
// and only the control plane's own credentials may write to it.
const ReservedRefPrefix = "refs/smithers/"

// JJRefPrefix is the git ref namespace jj itself writes (refs/jj/keep/*
// retention pins among them). Pushes may not create, move, or delete refs
// there.
const JJRefPrefix = "refs/jj/"

// WorkspaceSourceRefPrefix retains immutable workspace source commits.
const WorkspaceSourceRefPrefix = ReservedRefPrefix + "workspaces/"

var fullSourceCommitID = regexp.MustCompile(`^[0-9a-f]{40}$`)

// WorkspaceSourceRef is an immutable object-retention root, never a bookmark.
func WorkspaceSourceRef(workspaceID, commitID string) string {
	return WorkspaceSourceRefPrefix + workspaceID + "/sources/" + commitID
}

func WorkspaceSourceFromRef(ref string) (workspaceID, commitID string, ok bool) {
	rest, ok := strings.CutPrefix(ref, WorkspaceSourceRefPrefix)
	if !ok {
		return "", "", false
	}
	id, commit, ok := strings.Cut(rest, "/sources/")
	parsed, err := uuid.Parse(id)
	if !ok || err != nil || parsed.String() != id || parsed == uuid.Nil || !fullSourceCommitID.MatchString(commit) || commit == strings.Repeat("0", 40) {
		return "", "", false
	}
	return id, commit, true
}

// BranchHeadRefPrefix holds one captured head per branch.
const BranchHeadRefPrefix = ReservedRefPrefix + "branches/"

// BranchHeadRef returns the reserved captured head of a branch.
func BranchHeadRef(branchID string) string {
	return BranchHeadRefPrefix + strings.TrimSpace(branchID) + "/head"
}

// BranchIDFromHeadRef parses refs/smithers/branches/<uuid>/head. The id
// is returned in canonical lower-case form.
func BranchIDFromHeadRef(ref string) (string, bool) {
	rest, ok := strings.CutPrefix(ref, BranchHeadRefPrefix)
	if !ok {
		return "", false
	}
	id, ok := strings.CutSuffix(rest, "/head")
	if !ok || id == "" || strings.Contains(id, "/") {
		return "", false
	}
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}

// The mythical stack's refs are written only by the stack service (RFD-004
// control plane): its bookmark, its provenance notes, and its retention pins.
const (
	MythicalBookmarkRef   = "refs/heads/mythical"
	MythicalNotesRef      = "refs/notes/mythical"
	MythicalReservedRefNS = ReservedRefPrefix + "mythical/"
)

// UserRefPrefix holds work a user pushes from a local checkout (#1964):
// refs/smithers/users/<user id>/<name>, written only by that user. Under
// refs/smithers/ it is inert like every control-plane ref: no bookmark, no
// push hook, no jj import, no GitHub mirror. The numeric id, never the login,
// names the owner: a login can be renamed and reused, and internal pushers
// carry fixed logins.
const UserRefPrefix = ReservedRefPrefix + "users/"

var userRefName = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)

// UserRef returns a user's ref for one pushed name.
func UserRef(userID int64, name string) string {
	return UserRefPrefix + strconv.FormatInt(userID, 10) + "/" + name
}

// UserIDFromRef parses refs/smithers/users/<id>/<name>. The id is canonical
// decimal and positive; the name is one or more [A-Za-z0-9._-] segments that
// git accepts: no "..", no segment starting or ending with ".", none ending
// in ".lock".
func UserIDFromRef(ref string) (int64, bool) {
	rest, ok := strings.CutPrefix(ref, UserRefPrefix)
	if !ok {
		return 0, false
	}
	idText, name, ok := strings.Cut(rest, "/")
	id, err := strconv.ParseInt(idText, 10, 64)
	if !ok || err != nil || id <= 0 || strconv.FormatInt(id, 10) != idText || !userRefName.MatchString(name) {
		return 0, false
	}
	if strings.Contains(name, "..") {
		return 0, false
	}
	for _, segment := range strings.Split(name, "/") {
		if strings.HasPrefix(segment, ".") || strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, ".lock") {
			return 0, false
		}
	}
	return id, true
}

// IsMythicalRef reports whether ref belongs to the mythical stack service.
func IsMythicalRef(ref string) bool {
	key := RefKey(ref)
	return key == MythicalBookmarkRef || key == MythicalNotesRef || strings.HasPrefix(key, MythicalReservedRefNS)
}

// ReservedRefViolation applies the reserved-namespace push policy to a
// receive-pack command list and returns an empty string when the push is
// allowed, or the reason it must be refused.
//
// workspaceID is the workspace a workspace-restricted credential is bound to
// ("" for every other credential); pusherID is the authenticated user (0 when
// none, as for internal pushers). Rules:
//   - nothing may write under refs/jj/: jj owns that namespace, and its
//     refs/jj/keep/* pins are what keep jj-only commits safe from git gc;
//   - a ref under refs/smithers/ must be a workspace head ref, and only the
//     owning workspace's credential may update it;
//   - a workspace credential may update nothing but its own head ref;
//   - refs/smithers/users/<id>/<name> may be written only by user <id>
//     through a user credential.
func ReservedRefViolation(commands []ReceivePackCommand, workspaceID string, pusherID int64) string {
	return ControlPlaneRefViolation(commands, workspaceID, pusherID, false)
}

// ControlPlaneRefViolation is ReservedRefViolation for a push the API made
// on its own behalf. Only such a push (controlPlane, never set from a
// client) may write the mythical stack's refs, and it may write nothing else.
func ControlPlaneRefViolation(commands []ReceivePackCommand, workspaceID string, pusherID int64, controlPlane bool) string {
	workspaceID = strings.ToLower(strings.TrimSpace(workspaceID))
	for _, command := range commands {
		ref := strings.TrimSpace(command.RefName)
		key := RefKey(ref)
		if strings.HasPrefix(key, JJRefPrefix) {
			return "refs/jj/ is managed by jj and cannot be pushed"
		}
		if IsMythicalRef(ref) {
			if !controlPlane || workspaceID != "" {
				return "the mythical stack is written only by the stack service"
			}
			continue
		}
		if controlPlane {
			return "a control-plane push may write only the mythical stack"
		}
		if strings.HasPrefix(key, ReservedRefPrefix) && !strings.HasPrefix(ref, ReservedRefPrefix) {
			return "refs/smithers/ is reserved for the control plane"
		}
		if !strings.HasPrefix(ref, ReservedRefPrefix) {
			if workspaceID != "" {
				return "workspace credentials may only update the workspace head ref"
			}
			continue
		}
		if strings.HasPrefix(ref, UserRefPrefix) {
			owner, ok := UserIDFromRef(ref)
			if !ok || workspaceID != "" || pusherID <= 0 || owner != pusherID {
				return "refs/smithers/users/<id>/<name> is written only by user <id>"
			}
			continue
		}
		if owner, commit, ok := WorkspaceSourceFromRef(ref); ok {
			if workspaceID == "" || owner != workspaceID {
				return "workspace sources are written only by the owning workspace"
			}
			if command.NewOID != commit || (command.OldOID != strings.Repeat("0", 40) && command.OldOID != commit) {
				return "workspace source refs permit only creation or identical replay of their named commit"
			}
			continue
		}
		owner, ok := BranchIDFromHeadRef(ref)
		if !ok {
			return "refs/smithers/ is reserved for the control plane"
		}
		if workspaceID == "" || owner != workspaceID {
			return "workspace head refs are written only by the owning workspace"
		}
	}
	return ""
}
