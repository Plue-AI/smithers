package routes

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// secretVariableNamePattern validates names used for repository secrets and variables.
// Names must start with a letter or underscore and contain only ASCII letters, digits,
// and underscores. This matches the POSIX environment variable naming convention and
// is consistent with GitHub/Gitea secret name validation.
var secretVariableNamePattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

const (
	// maxSecretVariableNameLen is the maximum allowed length for a secret or variable name.
	// Matches the VARCHAR(255) column constraint in db/product/migrations/0001_product_baseline.sql.
	maxSecretVariableNameLen = 255

	// maxSecretVariableValueSize is the maximum allowed size for a secret or variable value (64 KiB).
	maxSecretVariableValueSize = 64 * 1024

	// maxRefLen bounds the length of a git/jj ref (branch name, change id, commit
	// sha). Legitimate refs are short; this generous cap only rejects absurd input.
	maxRefLen = 512
)

// containsControlChars reports whether s contains any ASCII control character
// (including the NUL byte). Such bytes are never valid in a ref or file path and,
// if passed through to the git/jj resolution layer, make it error with an opaque
// 500 instead of a clean 4xx.
func containsControlChars(s string) bool {
	for i := 0; i < len(s); i++ {
		if b := s[i]; b < 0x20 || b == 0x7f {
			return true
		}
	}
	return false
}

// validateRef validates a git/jj ref supplied as a query parameter. An empty ref
// is allowed (the caller falls back to the repository's default bookmark).
// Non-empty refs must be within length bounds and free of ASCII control
// characters. Branch names, change ids, commit shas, and "main" all pass.
func validateRef(ref string) *errors.APIError {
	if ref == "" {
		return nil
	}
	if len(ref) > maxRefLen {
		return errors.BadRequest("ref is too long")
	}
	if containsControlChars(ref) || !utf8.ValidString(ref) {
		return errors.BadRequest("ref contains invalid characters")
	}
	return nil
}

// validateSecretVariableName validates a secret or variable name.
// It returns nil on success or an APIError with HTTP 422 on failure.
// The resource parameter is used for error messages (e.g. "Secret" or "Variable").
func validateSecretVariableName(name, resource string) *errors.APIError {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return errors.ValidationFailed(errors.FieldError{
			Resource: resource,
			Field:    "name",
			Code:     "missing_field",
		})
	}
	if len(name) > maxSecretVariableNameLen {
		return errors.ValidationFailed(errors.FieldError{
			Resource: resource,
			Field:    "name",
			Code:     "invalid",
		})
	}
	// Match against the raw name (not trimmed) to reject names with leading/trailing
	// whitespace or embedded control characters.
	if !secretVariableNamePattern.MatchString(name) {
		return errors.ValidationFailed(errors.FieldError{
			Resource: resource,
			Field:    "name",
			Code:     "invalid",
		})
	}
	return nil
}

// validateSecretVariableValue validates a secret or variable value.
// It returns nil on success or an APIError with HTTP 422 on failure.
func validateSecretVariableValue(value, resource string) *errors.APIError {
	if value == "" {
		return errors.ValidationFailed(errors.FieldError{
			Resource: resource,
			Field:    "value",
			Code:     "missing_field",
		})
	}
	if len(value) > maxSecretVariableValueSize {
		return errors.ValidationFailed(errors.FieldError{
			Resource: resource,
			Field:    "value",
			Code:     "invalid",
		})
	}
	return nil
}
