package operator

import (
	"io"
	"os"
	"regexp"
	"strings"
	"testing"
)

// Every documented `plans grant` invocation must parse, so an operator who
// copies one from the credits README records the grant it describes.
func TestShippedPlanGrantCommandsParse(t *testing.T) {
	data, err := os.ReadFile("../credits/README.md")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(data), "\\\n", " ")
	matches := regexp.MustCompile(`plans grant ([^\n|>&]*)`).FindAllStringSubmatch(text, -1)
	word := regexp.MustCompile(`"[^"]*"|\S+`)
	limited := 0
	for _, match := range matches {
		args := []string{"grant"}
		for _, w := range word.FindAllString(match[1], -1) {
			args = append(args, strings.Trim(w, `"`))
		}
		grant, _, err := parsePlanGrant(args, io.Discard)
		if err != nil {
			t.Errorf("plans grant %s: %v", strings.TrimSpace(match[1]), err)
		}
		if grant.ConcurrentSandboxes > 0 {
			limited++
		}
	}
	if len(matches) < 2 || limited != 1 {
		t.Fatalf("found %d plans grant commands (%d with -concurrent-sandboxes), want at least 2 and exactly 1", len(matches), limited)
	}
}
