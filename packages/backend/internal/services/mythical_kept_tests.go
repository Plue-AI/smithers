package services

import (
	"regexp"
	"strings"
)

// mythicalRemovedTest is an existing test case a pull request's change takes
// away: How is deleted, emptied or skipped.
//
// The review lists them from the diff it reads (review), and its summary
// names each as a risk (mythicalReviewSummary). The coding flow's test guard
// (flows/coding/kept-tests.ts) reads the same rule over the lane's own
// history and has the correction loop restore them; a change to the rule
// changes both, with the same cases in each test.
type mythicalRemovedTest struct {
	Path, Name, How string
}

// The test-file conventions test runners discover, and the declarations of
// a test case in JavaScript or TypeScript (node:test, Jest, Vitest, Bun),
// Go and Python.
var (
	mythicalTestFile   = regexp.MustCompile(`\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.go$|^test_.*\.py$|_test\.py$`)
	mythicalTestSource = regexp.MustCompile(`\.(?:[cm]?[jt]sx?|py|go)$`)
	mythicalJSTest     = regexp.MustCompile(`^\s*(?:await\s+)?(?:t\.)?(x?(?:test|it))(?:\.(only|skip|todo|concurrent))?\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|` + "`" + `((?:\\.|[^` + "`" + `\\])*)` + "`" + `)`)
	mythicalGoTest     = regexp.MustCompile(`^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)`)
	mythicalPyTest     = regexp.MustCompile(`^\s*(?:async\s+)?def\s+(test\w*)\s*\(`)
	mythicalCodeString = regexp.MustCompile(`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|` + "`" + `(?:\\.|[^` + "`" + `\\])*` + "`")
	mythicalCodeBlock  = regexp.MustCompile(`/\*.*?\*/`)
	mythicalCodeLine   = regexp.MustCompile(`//.*$`)
	mythicalCodeBlank  = regexp.MustCompile(`^\s*(?:\*.*|/\*.*|\*/\s*)?$`)
	mythicalPyBlank    = regexp.MustCompile(`^(?:pass|\.\.\.|#.*)$`)
)

// mythicalIsTestPath reports a test file by those conventions: its name, or
// a source file under a test, tests, __tests__ or spec directory.
func mythicalIsTestPath(path string) bool {
	parts := strings.Split(path, "/")
	name := parts[len(parts)-1]
	if mythicalTestFile.MatchString(name) {
		return true
	}
	if !mythicalTestSource.MatchString(name) {
		return false
	}
	for _, part := range parts[:len(parts)-1] {
		switch part {
		case "test", "tests", "__tests__", "spec":
			return true
		}
	}
	return false
}

type mythicalTestDecl struct {
	Name   string
	Active bool // false for a skipped or todo declaration
	Indent bool // the body is indented (Python), not braced
}

// mythicalDeclaredTest is the test case a source line declares, if any.
func mythicalDeclaredTest(line string) (mythicalTestDecl, bool) {
	if m := mythicalJSTest.FindStringSubmatch(line); m != nil {
		return mythicalTestDecl{Name: m[3] + m[4] + m[5], Active: !strings.HasPrefix(m[1], "x") && m[2] != "skip" && m[2] != "todo"}, true
	}
	if m := mythicalGoTest.FindStringSubmatch(line); m != nil {
		return mythicalTestDecl{Name: m[1], Active: true}, true
	}
	if m := mythicalPyTest.FindStringSubmatch(line); m != nil {
		return mythicalTestDecl{Name: m[1], Active: true, Indent: true}, true
	}
	return mythicalTestDecl{}, false
}

// mythicalEmptyBody reports whether the test declared at lines[at] has an
// empty body; known is false when its body does not close inside lines.
func mythicalEmptyBody(lines []string, at int, indent bool) (empty, known bool) {
	if indent {
		width := func(line string) int { return len(line) - len(strings.TrimLeft(line, " \t")) }
		outer := width(lines[at])
		empty = true
		for _, line := range lines[at+1:] {
			if strings.TrimSpace(line) == "" {
				continue
			}
			if width(line) <= outer {
				return empty, true
			}
			empty = empty && mythicalPyBlank.MatchString(strings.TrimSpace(line))
		}
		return false, false
	}
	depth, opened := 0, false
	var body []string
	for index := at; index < len(lines); index++ {
		text := mythicalCodeLine.ReplaceAllString(mythicalCodeBlock.ReplaceAllString(mythicalCodeString.ReplaceAllString(lines[index], `""`), ""), "")
		start := 0
		for column := 0; column < len(text); column++ {
			switch {
			case text[column] == '{':
				if !opened {
					start = column + 1
				}
				opened = true
				depth++
			case text[column] == '}' && opened:
				if depth--; depth == 0 {
					if index != at {
						start = 0
					}
					body = append(body, text[start:column])
					for _, line := range body {
						if !mythicalCodeBlank.MatchString(line) {
							return false, true
						}
					}
					return true, true
				}
			}
		}
		if opened {
			if index == at {
				body = append(body, text[start:])
			} else {
				body = append(body, text)
			}
		}
	}
	return false, false
}

type mythicalDiffHunk struct {
	Before, After []string
	Removed       map[int]bool // the indexes of Before the change removed
}

type mythicalDiffFile struct {
	Path  string
	Hunks []mythicalDiffHunk
}

// mythicalDiffFiles splits a unified diff into its files and their hunks,
// each side's lines without their prefix.
func mythicalDiffFiles(diff string) []mythicalDiffFile {
	var files []mythicalDiffFile
	header, before := false, ""
	for _, line := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			header, before = true, ""
			continue
		case header && strings.HasPrefix(line, "--- "):
			before = line[4:]
			continue
		case header && strings.HasPrefix(line, "+++ "):
			header = false
			if before == "" {
				continue
			}
			path := strings.TrimPrefix(line[4:], "b/")
			if line[4:] == "/dev/null" {
				path = strings.TrimPrefix(before, "a/")
			}
			files = append(files, mythicalDiffFile{Path: strings.TrimSuffix(path, "\t")})
			continue
		case header || len(files) == 0:
			continue
		}
		file := &files[len(files)-1]
		if strings.HasPrefix(line, "@@") {
			file.Hunks = append(file.Hunks, mythicalDiffHunk{Removed: map[int]bool{}})
			continue
		}
		if len(file.Hunks) == 0 || strings.HasPrefix(line, `\`) {
			continue
		}
		hunk := &file.Hunks[len(file.Hunks)-1]
		kind, text := byte(' '), ""
		if line != "" {
			kind, text = line[0], line[1:]
		}
		switch kind {
		case '-':
			hunk.Removed[len(hunk.Before)] = true
			hunk.Before = append(hunk.Before, text)
		case '+':
			hunk.After = append(hunk.After, text)
		default:
			hunk.Before = append(hunk.Before, text)
			hunk.After = append(hunk.After, text)
		}
	}
	return files
}

// mythicalRemovedTests is the existing test cases a unified diff deletes,
// empties or skips, in test files only. A test whose declaration the diff
// removes and nothing in the file declares again is deleted, or skipped when
// it is declared again as skip, todo or x; a test still declared whose body
// the diff leaves empty is emptied.
func mythicalRemovedTests(diff string) []mythicalRemovedTest {
	var found []mythicalRemovedTest
	for _, file := range mythicalDiffFiles(diff) {
		if !mythicalIsTestPath(file.Path) {
			continue
		}
		var removed, emptied []string
		seen := map[string]bool{}
		kept, skipped := map[string]bool{}, map[string]bool{}
		for _, hunk := range file.Hunks {
			for index, line := range hunk.Before {
				if test, ok := mythicalDeclaredTest(line); ok && test.Active && hunk.Removed[index] && !seen["removed:"+test.Name] {
					seen["removed:"+test.Name] = true
					removed = append(removed, test.Name)
				}
			}
			for index, line := range hunk.After {
				test, ok := mythicalDeclaredTest(line)
				if !ok {
					continue
				}
				if !test.Active {
					skipped[test.Name] = true
					continue
				}
				kept[test.Name] = true
				if empty, known := mythicalEmptyBody(hunk.After, index, test.Indent); !empty || !known || seen["emptied:"+test.Name] {
					continue
				}
				for was, other := range hunk.Before {
					if before, ok := mythicalDeclaredTest(other); ok && before.Active && before.Name == test.Name {
						if empty, known := mythicalEmptyBody(hunk.Before, was, test.Indent); known && !empty {
							seen["emptied:"+test.Name] = true
							emptied = append(emptied, test.Name)
						}
						break
					}
				}
			}
		}
		for _, name := range removed {
			if kept[name] {
				continue
			}
			how := "deleted"
			if skipped[name] {
				how = "skipped"
			}
			found = append(found, mythicalRemovedTest{Path: file.Path, Name: name, How: how})
		}
		for _, name := range emptied {
			found = append(found, mythicalRemovedTest{Path: file.Path, Name: name, How: "emptied"})
		}
	}
	return found
}

// mythicalRemovedTestLine names one removed test for the review's input and
// its summary's risks: `"adds" in test/smoke.test.mjs (deleted)`.
func mythicalRemovedTestLine(test mythicalRemovedTest) string {
	return `"` + test.Name + `" in ` + test.Path + " (" + test.How + ")"
}
