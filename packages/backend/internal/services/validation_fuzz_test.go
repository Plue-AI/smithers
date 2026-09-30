package services

import (
	"strings"
	"testing"
)

// FuzzValidateRepoName fuzzes the repository name validator. This is security-critical
// because repo names are used in filesystem paths, URLs, and database lookups.
// Malformed names could cause path traversal or injection issues.
func FuzzValidateRepoName(f *testing.F) {
	// Valid names.
	f.Add("my-repo")
	f.Add("MyRepo123")
	f.Add("a")
	f.Add("repo.name")
	f.Add("repo_name")
	f.Add("repo-name")

	// Empty.
	f.Add("")

	// Reserved names.
	f.Add("settings")
	f.Add("issues")
	f.Add("pulls")
	f.Add("commits")
	f.Add("landings")
	f.Add("workflows")

	// .git suffix.
	f.Add("my-repo.git")
	f.Add("repo.GIT")
	f.Add(".git")

	// Names starting with invalid characters.
	f.Add("-repo")
	f.Add(".repo")
	f.Add("_repo")

	// Very long names.
	f.Add(strings.Repeat("a", 101))
	f.Add(strings.Repeat("a", 100))

	// Special characters.
	f.Add("repo/name")
	f.Add("repo\\name")
	f.Add("repo name")
	f.Add("repo\x00name")
	f.Add("repo\nname")
	f.Add("repo\tname")
	f.Add("../../../etc/passwd")
	f.Add("repo<script>")

	// Unicode.
	f.Add("\u200brepo")
	f.Add("repo\u0000")

	// Dots and dashes edge cases.
	f.Add("...")
	f.Add("..")
	f.Add(".")
	f.Add("---")
	f.Add("___")

	f.Fuzz(func(t *testing.T, name string) {
		// Must never panic.
		_ = validateRepoName(name)
	})
}

// FuzzIsReservedRepoName fuzzes the reserved repo name checker.
func FuzzIsReservedRepoName(f *testing.F) {
	f.Add("settings")
	f.Add("SETTINGS")
	f.Add("Settings")
	f.Add("")
	f.Add("my-repo")
	f.Add(strings.Repeat("a", 10000))

	f.Fuzz(func(t *testing.T, name string) {
		// Must never panic.
		_ = isReservedRepoName(name)
	})
}

// FuzzNormalizeTopics fuzzes the repository topic normalizer.
func FuzzNormalizeTopics(f *testing.F) {
	f.Add("golang")
	f.Add("")
	f.Add("UPPER-CASE")
	f.Add(strings.Repeat("a", 36))
	f.Add("-invalid")
	f.Add("0valid")
	f.Add("with spaces")
	f.Add("special!chars")
	f.Add("\x00null")

	f.Fuzz(func(t *testing.T, topic string) {
		// Must never panic, even with a single topic.
		_, _ = normalizeTopics([]string{topic})
	})
}

// FuzzNormalizeTopicsMultiple fuzzes the topic normalizer with multiple topics
// to test deduplication and multi-element handling.
func FuzzNormalizeTopicsMultiple(f *testing.F) {
	f.Add("go", "rust", "zig")
	f.Add("", "", "")
	f.Add("dup", "dup", "dup")
	f.Add("Go", "go", "GO")

	f.Fuzz(func(t *testing.T, a, b, c string) {
		// Must never panic.
		_, _ = normalizeTopics([]string{a, b, c})
	})
}

// FuzzValidateEmail fuzzes the email validator. Email validation is security-critical
// because invalid emails could cause issues in downstream systems.
func FuzzValidateEmail(f *testing.F) {
	// Valid emails.
	f.Add("user@example.com")
	f.Add("test+tag@gmail.com")
	f.Add("user@sub.domain.com")

	// Empty.
	f.Add("")

	// Too long.
	f.Add(strings.Repeat("a", 255) + "@example.com")
	f.Add(strings.Repeat("a", 250) + "@b.c")

	// Missing parts.
	f.Add("@")
	f.Add("user@")
	f.Add("@domain.com")

	// Special characters.
	f.Add("user @example.com")
	f.Add("user\n@example.com")
	f.Add("user\x00@example.com")
	f.Add("<script>@example.com")

	// Quoted local parts (RFC allows these).
	f.Add("\"user name\"@example.com")
	f.Add("\"user\\\"name\"@example.com")

	// Unicode domain.
	f.Add("user@\u00e9xample.com")

	// Very long local part.
	f.Add(strings.Repeat("a", 1000) + "@example.com")

	f.Fuzz(func(t *testing.T, email string) {
		// Must never panic.
		_ = validateEmail(email)
	})
}

// FuzzNormalizePagination fuzzes the pagination normalizer to ensure it always
// returns valid page/perPage values without panics.
func FuzzNormalizePagination(f *testing.F) {
	f.Add(1, 30)
	f.Add(0, 0)
	f.Add(-1, -1)
	f.Add(1000000, 1000000)
	f.Add(1, 100)
	f.Add(1, 101)

	f.Fuzz(func(t *testing.T, page, perPage int) {
		// Must never panic.
		resultPage, resultPerPage := normalizePagination(page, perPage)
		if resultPage < 1 {
			t.Errorf("normalizePagination(%d, %d) returned page=%d, expected >= 1", page, perPage, resultPage)
		}
		if resultPerPage < 1 || resultPerPage > UserMaxPerPage {
			t.Errorf("normalizePagination(%d, %d) returned perPage=%d, expected 1-%d", page, perPage, resultPerPage, UserMaxPerPage)
		}
	})
}

// FuzzNormalizePage fuzzes the org-service pagination normalizer.
func FuzzNormalizePage(f *testing.F) {
	f.Add(1, 30)
	f.Add(0, 0)
	f.Add(-1, -1)
	f.Add(1000000, 1000000)

	f.Fuzz(func(t *testing.T, page, perPage int) {
		// Must never panic.
		pageSize, pageOffset, resolvedPage, resolvedPerPage := normalizePage(page, perPage)
		if resolvedPage < 1 {
			t.Errorf("normalizePage returned page=%d, expected >= 1", resolvedPage)
		}
		if resolvedPerPage < 1 || resolvedPerPage > maxPerPage {
			t.Errorf("normalizePage returned perPage=%d, expected 1-%d", resolvedPerPage, maxPerPage)
		}
		if pageSize != int32(resolvedPerPage) {
			t.Errorf("normalizePage returned inconsistent pageSize=%d vs resolvedPerPage=%d", pageSize, resolvedPerPage)
		}
		expectedOffset := int32((resolvedPage - 1) * resolvedPerPage)
		if pageOffset != expectedOffset {
			t.Errorf("normalizePage returned pageOffset=%d, expected %d", pageOffset, expectedOffset)
		}
	})
}

// FuzzIsValidAvatarURL fuzzes the avatar URL validator.
func FuzzIsValidAvatarURL(f *testing.F) {
	f.Add("https://example.com/avatar.png")
	f.Add("http://example.com/avatar.png")
	f.Add("")
	f.Add("ftp://example.com/avatar.png")
	f.Add("javascript:alert(1)")
	f.Add("data:image/png;base64,abc")
	f.Add(strings.Repeat("a", 10000))
	f.Add("https://")
	f.Add("://missing-scheme")
	f.Add("\x00\x01\x02")

	f.Fuzz(func(t *testing.T, rawURL string) {
		// Must never panic.
		_ = isValidAvatarURL(rawURL)
	})
}

// FuzzHighestRepoPermission fuzzes the permission comparison function.
func FuzzHighestRepoPermission(f *testing.F) {
	f.Add("read", "write")
	f.Add("admin", "read")
	f.Add("", "")
	f.Add("invalid", "also-invalid")
	f.Add(strings.Repeat("a", 10000), "read")

	f.Fuzz(func(t *testing.T, a, b string) {
		// Must never panic.
		_ = highestRepoPermission(a, b)
	})
}

// FuzzNormalizeRepoPermission fuzzes the repo permission normalizer.
func FuzzNormalizeRepoPermission(f *testing.F) {
	f.Add("read")
	f.Add("WRITE")
	f.Add("Admin")
	f.Add("")
	f.Add("   read   ")
	f.Add(strings.Repeat("x", 10000))

	f.Fuzz(func(t *testing.T, permission string) {
		// Must never panic.
		_ = normalizeRepoPermission(permission)
	})
}
