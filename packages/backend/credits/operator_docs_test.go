package credits

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every shipped `credits grant` invocation must parse, so an operator who
// copies it funds the ledger.
func TestShippedCreditGrantCommandsParse(t *testing.T) {
	grant := regexp.MustCompile(`credits grant ([^\n|>&]*)`)
	found := 0
	for _, path := range []string{
		"README.md",
	} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := strings.ReplaceAll(string(data), "\\\n", " ")
		for _, match := range grant.FindAllStringSubmatch(text, -1) {
			found++
			args := append([]string{"grant"}, shellWords(match[1])...)
			if _, err := ParseOperatorCommand(args, io.Discard); err != nil {
				t.Errorf("%s: credits grant %s: %v", filepath.Base(path), strings.TrimSpace(match[1]), err)
			}
		}
	}
	if found < 1 {
		t.Fatalf("found %d credits grant commands, want at least 1", found)
	}
}

func shellWords(line string) []string {
	var words []string
	var word strings.Builder
	quote, inWord := rune(0), false
	for _, r := range strings.TrimSpace(line) {
		switch {
		case quote != 0 && r == quote:
			quote = 0
		case quote != 0:
			word.WriteRune(r)
		case r == '"' || r == '\'':
			quote, inWord = r, true
		case r == ' ' || r == '\t':
			if inWord {
				words = append(words, word.String())
				word.Reset()
				inWord = false
			}
		default:
			word.WriteRune(r)
			inWord = true
		}
	}
	if inWord {
		words = append(words, word.String())
	}
	return words
}
