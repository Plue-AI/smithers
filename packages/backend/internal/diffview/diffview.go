package diffview

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/pmezard/go-difflib/difflib"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type ChangeDiffClient interface {
	GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
	GetChangeDiff(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error)
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

type RevisionDiffClient interface {
	GetRevisionDiff(ctx context.Context, owner, repo, changeID, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error)
}

type BuildOptions struct {
	IgnoreWhitespace bool
}

const (
	// maxFileDiffContentBytes caps the combined old+new content size of a
	// single file before a unified diff is computed. Files over the cap are
	// returned without patch or contents and marked TooLarge, like binary
	// files, instead of feeding difflib's O(n*m) matcher unbounded input.
	maxFileDiffContentBytes = 1 << 20 // 1 MiB
	// maxFileDiffLines caps the per-side line count fed to difflib. Line
	// count, not byte size, drives its quadratic longest-match cost.
	maxFileDiffLines = 10000
	// maxTotalDiffContentBytes caps the total file content fetched and
	// retained across one BuildChangeDiff call, so a change touching many
	// large files cannot amplify memory several-fold per request.
	maxTotalDiffContentBytes = 8 << 20 // 8 MiB
)

var diffviewGetUnifiedDiffString = difflib.GetUnifiedDiffString

func BuildChangeDiff(
	ctx context.Context,
	client ChangeDiffClient,
	owner string,
	repo string,
	changeID string,
	opts BuildOptions,
) (repohost.ChangeDiff, error) {
	diff, err := client.GetChangeDiff(ctx, owner, repo, changeID)
	if err != nil {
		return repohost.ChangeDiff{}, err
	}

	change, err := client.GetChange(ctx, owner, repo, changeID)
	if err != nil {
		return repohost.ChangeDiff{}, err
	}

	// A historical revision must diff against its immutable parent commit.
	// ParentChangeIDs are stable document IDs whose heads can move later.
	parentID := strings.TrimSpace(change.ParentCommitID)
	if parentID == "" && len(change.ParentChangeIDs) > 0 {
		parentID = strings.TrimSpace(change.ParentChangeIDs[0])
	}

	budget := maxTotalDiffContentBytes
	fileDiffs := make([]repohost.FileDiff, 0, len(diff.FileDiffs))
	for _, fileDiff := range diff.FileDiffs {
		enriched, include, err := buildFileDiff(ctx, client, owner, repo, parentID, changeID, fileDiff, opts, &budget)
		if err != nil {
			return repohost.ChangeDiff{}, err
		}
		if include {
			fileDiffs = append(fileDiffs, enriched)
		}
	}

	diff.FileDiffs = fileDiffs
	return diff, nil
}

// BuildRevisionDiff enriches repo-host's jj-native interdiff contents with the
// same bounded unified-patch representation as the legacy live change diff.
func BuildRevisionDiff(
	ctx context.Context,
	client RevisionDiffClient,
	owner string,
	repo string,
	changeID string,
	fromCommitID string,
	toCommitID string,
	path string,
	opts BuildOptions,
) (repohost.ChangeDiff, error) {
	diff, err := client.GetRevisionDiff(ctx, owner, repo, changeID, fromCommitID, toCommitID, path)
	if err != nil {
		return repohost.ChangeDiff{}, err
	}

	budget := maxTotalDiffContentBytes
	fileDiffs := make([]repohost.FileDiff, 0, len(diff.FileDiffs))
	for _, fileDiff := range diff.FileDiffs {
		fileDiff.Language = detectLanguage(fileDiff.Path, fileDiff.Language)
		budget -= len(fileDiff.OldContent) + len(fileDiff.NewContent)
		fileDiff.IsBinary = fileDiff.IsBinary || looksBinary(fileDiff.Path, fileDiff.OldContent, fileDiff.NewContent)
		if fileDiff.IsBinary {
			fileDiff.Patch = ""
			fileDiff.Additions = 0
			fileDiff.Deletions = 0
			fileDiff.OldContent = ""
			fileDiff.NewContent = ""
			fileDiffs = append(fileDiffs, fileDiff)
			continue
		}
		if fileDiff.TooLarge || budget < 0 ||
			len(fileDiff.OldContent)+len(fileDiff.NewContent) > maxFileDiffContentBytes ||
			lineCount(fileDiff.OldContent) > maxFileDiffLines || lineCount(fileDiff.NewContent) > maxFileDiffLines {
			fileDiffs = append(fileDiffs, degradeTooLarge(fileDiff))
			continue
		}
		var (
			patch                string
			additions, deletions int
		)
		if opts.IgnoreWhitespace {
			patch, additions, deletions = buildIgnoreWhitespacePatch(fileDiff, fileDiff.OldContent, fileDiff.NewContent)
			if patch == "" {
				continue
			}
		} else {
			var err error
			patch, additions, deletions, err = buildUnifiedPatch(fileDiff, fileDiff.OldContent, fileDiff.NewContent)
			if err != nil {
				return repohost.ChangeDiff{}, err
			}
		}
		fileDiff.Patch = patch
		fileDiff.Additions = additions
		fileDiff.Deletions = deletions
		fileDiffs = append(fileDiffs, fileDiff)
	}
	diff.FileDiffs = fileDiffs
	return diff, nil
}

func buildFileDiff(
	ctx context.Context,
	client ChangeDiffClient,
	owner string,
	repo string,
	parentID string,
	changeID string,
	fileDiff repohost.FileDiff,
	opts BuildOptions,
	budget *int,
) (repohost.FileDiff, bool, error) {
	fileDiff.Language = detectLanguage(fileDiff.Path, fileDiff.Language)

	if *budget <= 0 {
		return degradeTooLarge(fileDiff), true, nil
	}

	oldContent := ""
	newContent := ""
	binary := false
	tooLarge := false

	if fileDiff.ChangeType != "added" && parentID != "" {
		oldPath := fileDiff.Path
		if strings.TrimSpace(fileDiff.OldPath) != "" {
			oldPath = fileDiff.OldPath
		}

		oldFile, err := client.GetFileAtChange(ctx, owner, repo, parentID, oldPath)
		if err != nil {
			return repohost.FileDiff{}, false, err
		}
		oldContent, binary, tooLarge = fileContentForDiff(oldFile)
	}

	if fileDiff.ChangeType != "deleted" {
		newFile, err := client.GetFileAtChange(ctx, owner, repo, changeID, fileDiff.Path)
		if err != nil {
			return repohost.FileDiff{}, false, err
		}
		content, isBinary, isTooLarge := fileContentForDiff(newFile)
		newContent = content
		binary = binary || isBinary
		tooLarge = tooLarge || isTooLarge
	}

	*budget -= len(oldContent) + len(newContent)

	fileDiff.OldContent = oldContent
	fileDiff.NewContent = newContent
	fileDiff.IsBinary = fileDiff.IsBinary || binary || looksBinary(fileDiff.Path, oldContent, newContent)

	if fileDiff.IsBinary {
		fileDiff.Patch = ""
		fileDiff.Additions = 0
		fileDiff.Deletions = 0
		fileDiff.OldContent = ""
		fileDiff.NewContent = ""
		return fileDiff, true, nil
	}

	if tooLarge || *budget < 0 ||
		len(oldContent)+len(newContent) > maxFileDiffContentBytes ||
		lineCount(oldContent) > maxFileDiffLines || lineCount(newContent) > maxFileDiffLines {
		return degradeTooLarge(fileDiff), true, nil
	}

	var (
		patch                string
		additions, deletions int
		err                  error
	)
	if opts.IgnoreWhitespace {
		patch, additions, deletions = buildIgnoreWhitespacePatch(fileDiff, oldContent, newContent)
		if patch == "" {
			return repohost.FileDiff{}, false, nil
		}
	} else {
		patch, additions, deletions, err = buildUnifiedPatch(fileDiff, oldContent, newContent)
		if err != nil {
			return repohost.FileDiff{}, false, err
		}
	}

	fileDiff.Patch = patch
	fileDiff.Additions = additions
	fileDiff.Deletions = deletions

	return fileDiff, true, nil
}

// degradeTooLarge returns the file entry without patch or contents, marked
// TooLarge, so oversized files stay listed in the diff without amplifying
// memory or CPU.
func degradeTooLarge(fileDiff repohost.FileDiff) repohost.FileDiff {
	fileDiff.TooLarge = true
	fileDiff.Patch = ""
	fileDiff.Additions = 0
	fileDiff.Deletions = 0
	fileDiff.OldContent = ""
	fileDiff.NewContent = ""
	return fileDiff
}

// fileContentForDiff unpacks the repo-host FileContent transport: a base64
// encoding marks a non-UTF-8 (binary) blob and TooLarge marks a blob over the
// repo-host read cap. Neither carries diffable text.
func fileContentForDiff(file repohost.FileContent) (content string, binary, tooLarge bool) {
	if file.TooLarge {
		return "", false, true
	}
	if file.Encoding == "base64" {
		return "", true, false
	}
	return file.Content, false, false
}

func lineCount(content string) int {
	if content == "" {
		return 0
	}
	return strings.Count(content, "\n") + 1
}

func patchLabels(fileDiff repohost.FileDiff) (oldLabel, newLabel string) {
	oldLabel = "a/" + fileDiff.Path
	newLabel = "b/" + fileDiff.Path
	if fileDiff.ChangeType == "added" {
		oldLabel = "/dev/null"
	}
	if fileDiff.ChangeType == "deleted" {
		newLabel = "/dev/null"
	}
	if fileDiff.ChangeType != "added" && strings.TrimSpace(fileDiff.OldPath) != "" {
		oldLabel = "a/" + fileDiff.OldPath
	}
	return oldLabel, newLabel
}

func buildUnifiedPatch(fileDiff repohost.FileDiff, oldContent, newContent string) (string, int, int, error) {
	oldLabel, newLabel := patchLabels(fileDiff)

	patch, err := diffviewGetUnifiedDiffString(difflib.UnifiedDiff{
		A:        difflib.SplitLines(oldContent),
		B:        difflib.SplitLines(newContent),
		FromFile: oldLabel,
		ToFile:   newLabel,
		Context:  3,
	})
	if err != nil {
		return "", 0, 0, err
	}

	additions := 0
	deletions := 0
	// Count only inside hunks (after the first "@@"). The "--- old"/"+++ new" file
	// headers precede any hunk, so skipping the pre-hunk lines excludes them
	// without a prefix test that would also drop added/removed content lines whose
	// own text starts with "++" or "--" (which render as "+++.."/"---..").
	inHunk := false
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "@@") {
			inHunk = true
			continue
		}
		if !inHunk {
			continue
		}
		switch {
		case strings.HasPrefix(line, "+"):
			additions++
		case strings.HasPrefix(line, "-"):
			deletions++
		}
	}

	return patch, additions, deletions, nil
}

// buildIgnoreWhitespacePatch diffs lines compared with all whitespace removed,
// like git diff -w, and renders the original lines. Lines that differ only in
// whitespace show as new-side context, not as changes. It returns an empty
// patch when every difference is whitespace.
func buildIgnoreWhitespacePatch(fileDiff repohost.FileDiff, oldContent, newContent string) (string, int, int) {
	oldLines := difflib.SplitLines(oldContent)
	newLines := difflib.SplitLines(newContent)
	matcher := difflib.NewMatcher(collapseEach(oldLines), collapseEach(newLines))
	groups := matcher.GetGroupedOpCodes(3)
	if len(groups) == 0 {
		return "", 0, 0
	}

	oldLabel, newLabel := patchLabels(fileDiff)
	var b strings.Builder
	b.WriteString("--- " + oldLabel + "\n+++ " + newLabel + "\n")
	additions, deletions := 0, 0
	for _, group := range groups {
		first, last := group[0], group[len(group)-1]
		fmt.Fprintf(&b, "@@ -%s +%s @@\n", unifiedRange(first.I1, last.I2), unifiedRange(first.J1, last.J2))
		for _, op := range group {
			if op.Tag == 'e' {
				for _, line := range newLines[op.J1:op.J2] {
					b.WriteString(" " + line)
				}
				continue
			}
			if op.Tag == 'r' || op.Tag == 'd' {
				for _, line := range oldLines[op.I1:op.I2] {
					b.WriteString("-" + line)
					deletions++
				}
			}
			if op.Tag == 'r' || op.Tag == 'i' {
				for _, line := range newLines[op.J1:op.J2] {
					b.WriteString("+" + line)
					additions++
				}
			}
		}
	}
	return b.String(), additions, deletions
}

// unifiedRange formats a hunk range the way difflib's unified diff does.
func unifiedRange(start, stop int) string {
	beginning, length := start+1, stop-start
	if length == 1 {
		return fmt.Sprintf("%d", beginning)
	}
	if length == 0 {
		beginning--
	}
	return fmt.Sprintf("%d,%d", beginning, length)
}

func collapseEach(lines []string) []string {
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i] = collapseWhitespace(line)
	}
	return out
}

func collapseWhitespace(content string) string {
	var builder strings.Builder
	builder.Grow(len(content))
	for _, r := range content {
		switch r {
		case ' ', '\t', '\n', '\r', '\f', '\v':
			continue
		default:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func looksBinary(path string, contents ...string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".tgz", ".jar", ".wasm", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".mov":
		return true
	}

	for _, content := range contents {
		if strings.ContainsRune(content, '\x00') {
			return true
		}
	}

	return false
}

func detectLanguage(path string, current string) string {
	if trimmed := strings.TrimSpace(current); trimmed != "" {
		return trimmed
	}

	base := strings.ToLower(filepath.Base(path))
	switch base {
	case "dockerfile":
		return "dockerfile"
	case "makefile":
		return "makefile"
	}

	switch strings.ToLower(filepath.Ext(path)) {
	case ".c":
		return "c"
	case ".cc", ".cpp", ".cxx":
		return "cpp"
	case ".css":
		return "css"
	case ".go":
		return "go"
	case ".html", ".htm":
		return "html"
	case ".java":
		return "java"
	case ".js", ".mjs", ".cjs":
		return "javascript"
	case ".json":
		return "json"
	case ".jsx":
		return "jsx"
	case ".kt":
		return "kotlin"
	case ".md":
		return "markdown"
	case ".py":
		return "python"
	case ".rb":
		return "ruby"
	case ".rs":
		return "rust"
	case ".scss":
		return "scss"
	case ".sh", ".bash", ".zsh":
		return "bash"
	case ".sql":
		return "sql"
	case ".svg":
		return "xml"
	case ".swift":
		return "swift"
	case ".toml":
		return "toml"
	case ".ts":
		return "typescript"
	case ".tsx":
		return "tsx"
	case ".txt":
		return "plaintext"
	case ".xml":
		return "xml"
	case ".yaml", ".yml":
		return "yaml"
	default:
		return ""
	}
}
