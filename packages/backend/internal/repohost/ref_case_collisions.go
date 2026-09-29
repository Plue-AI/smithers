package repohost

import (
	"path"
	"sort"
	"strconv"
	"strings"
)

// RefCaseCollisionPrefix holds the backups the case-collision repair keeps:
// refs/smithers/case-collision/<timestamp>/<n>/<ref without "refs/">. Under
// refs/smithers/ they are inert: no bookmark, no push, no jj import, and
// repo-host hides them from fetches and pushes, so a `git push --mirror`
// never tries to prune them.
const RefCaseCollisionPrefix = ReservedRefPrefix + "case-collision/"

// Case-collision repair actions.
const (
	RefCaseCollisionRemoved  = "removed"  // the variant was removed; a backup keeps its commit
	RefCaseCollisionRenamed  = "renamed"  // the variant now has the canonical name; a backup keeps it too
	RefCaseCollisionReported = "reported" // left to the owner
)

// RefCaseCollision is one set of refs with one RefKey (or a ref inside a
// variant of a reserved ref's name). Canonical is the reserved spelling when
// the name is reserved: mythical, the default bookmark, or a protected
// pattern that exactly one spelling matches.
type RefCaseCollision struct {
	Refs      []string `json:"refs"`
	Canonical string   `json:"canonical,omitempty"`
	Action    string   `json:"action"`
	// Variants are the refs the repair renames or removes.
	Variants []string `json:"variants,omitempty"`
	Backups  []string `json:"backups,omitempty"`
}

// RefCaseCollisionRequest carries the repository's protected-bookmark
// patterns, which only the API knows.
type RefCaseCollisionRequest struct {
	ProtectedPatterns []string `json:"protected_patterns"`
}

// RefCaseCollisionReport is a repository's repair result.
type RefCaseCollisionReport struct {
	Collisions []RefCaseCollision `json:"collisions"`
}

// PlanRefCaseCollisions groups refs whose names are one ref (RefKey) and
// decides each group. A reserved name keeps its canonical spelling: every
// other spelling is removed, or renamed to the canonical one when that is
// missing and the name is the default bookmark. A protected pattern selects
// only an existing canonical spelling. A
// missing mythical ref is never filled from a variant, whose content no stack
// service wrote. Every other group is reported.
func PlanRefCaseCollisions(refs []string, defaultBookmark string, protectedPatterns []string) []RefCaseCollision {
	reserved := map[string]string{
		RefKey(MythicalBookmarkRef): MythicalBookmarkRef,
		RefKey(MythicalNotesRef):    MythicalNotesRef,
	}
	renamable := map[string]bool{}
	if name := strings.TrimSpace(defaultBookmark); name != "" {
		ref := "refs/heads/" + name
		reserved[RefKey(ref)] = ref
		renamable[RefKey(ref)] = true
	}
	groups := map[string][]string{}
	present := map[string]bool{}
	for _, ref := range refs {
		present[ref] = true
		key := RefKey(ref)
		groups[key] = append(groups[key], ref)
	}
	// A protected pattern names the canonical spelling of a group only when
	// exactly one spelling matches it exactly.
	for key, spellings := range groups {
		if _, ok := reserved[key]; ok || len(spellings) < 2 {
			continue
		}
		var exact []string
		for _, ref := range spellings {
			bookmark, ok := strings.CutPrefix(ref, "refs/heads/")
			if !ok {
				continue
			}
			for _, pattern := range protectedPatterns {
				if matched, _ := path.Match(pattern, bookmark); matched {
					exact = append(exact, ref)
					break
				}
			}
		}
		if len(exact) == 1 {
			reserved[key] = exact[0]
			renamable[key] = true
		}
	}

	var out []RefCaseCollision
	for key, spellings := range groups {
		sort.Strings(spellings)
		canonical, isReserved := reserved[key]
		if !isReserved {
			// A ref inside a variant of a reserved name, like
			// refs/heads/Mythical/x, blocks the missing reserved ref. Remove
			// a group only when every spelling is a variant of the same
			// missing prefix; canonical directories and ambiguous groups
			// are left to the owner.
			prefix := reservedDirectoryVariant(spellings[0], reserved)
			for _, ref := range spellings[1:] {
				if reservedDirectoryVariant(ref, reserved) != prefix {
					prefix = ""
					break
				}
			}
			if prefix != "" {
				collision := RefCaseCollision{Refs: spellings, Canonical: prefix, Action: RefCaseCollisionRemoved, Variants: spellings}
				if present[prefix] {
					collision.Action, collision.Variants = RefCaseCollisionReported, nil
				}
				out = append(out, collision)
				continue
			}
			if len(spellings) > 1 {
				out = append(out, RefCaseCollision{Refs: spellings, Action: RefCaseCollisionReported})
			}
			continue
		}
		var variants []string
		for _, ref := range spellings {
			if ref != canonical {
				variants = append(variants, ref)
			}
		}
		if len(variants) == 0 {
			continue
		}
		collision := RefCaseCollision{Refs: spellings, Canonical: canonical, Action: RefCaseCollisionRemoved, Variants: variants}
		if !present[canonical] && renamable[key] {
			if len(variants) == 1 {
				collision.Action = RefCaseCollisionRenamed
			} else {
				// Several variants and no canonical ref: which one is the
				// bookmark is the owner's call.
				collision.Action, collision.Variants = RefCaseCollisionReported, nil
			}
		}
		out = append(out, collision)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Refs[0] < out[j].Refs[0] })
	return out
}

// reservedDirectoryVariant returns the reserved ref that a directory of ref
// is a case variant of, or "".
func reservedDirectoryVariant(ref string, reserved map[string]string) string {
	for i := 0; i < len(ref); i++ {
		if ref[i] != '/' {
			continue
		}
		if canonical, ok := reserved[RefKey(ref[:i])]; ok && ref[:i] != canonical {
			return canonical
		}
	}
	return ""
}

// RefCaseCollisionBackup names the backup of a run's n-th variant made at
// stamp. The number keeps two variants' backups apart on a case-insensitive
// filesystem, where refs/.../Mythical and refs/.../MYTHICAL are one file.
func RefCaseCollisionBackup(stamp string, n int, variant string) string {
	return RefCaseCollisionPrefix + stamp + "/" + strconv.Itoa(n) + "/" + strings.TrimPrefix(variant, "refs/")
}
