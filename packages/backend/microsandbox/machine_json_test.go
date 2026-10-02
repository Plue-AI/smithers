package microsandbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestReadMachineJSONValidPackages(t *testing.T) {
	// T-MCH-10 Changes (machine_json.go), spec §8.6.1/M-29:
	// packages[] is read only from .smithers/machine.json; names follow
	// ^[a-z0-9][a-z0-9+.-]{0,127}$, including the 128-character boundary.
	want := []string{"git", "libssl-dev", "g++", "libc6", "python3.13", "a" + strings.Repeat("b", 127)}
	body, err := json.Marshal(map[string]any{"packages": want})
	if err != nil {
		t.Fatal(err)
	}
	var reads []string
	config, err := ReadMachineJSON(func(file string) ([]byte, bool, error) {
		reads = append(reads, file)
		return body, true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config.Packages, want) {
		t.Fatalf("packages = %#v; want %#v", config.Packages, want)
	}
	if !reflect.DeepEqual(reads, []string{".smithers/machine.json"}) {
		t.Fatalf("machine config reads unrelated files: %#v", reads)
	}
}

func TestReadMachineJSONAbsentAndEmpty(t *testing.T) {
	// T-MCH-10 Tests (machine_json_test.go): an absent file adds no packages;
	// spec §8.6.1 makes packages[] optional image additions.
	for _, fixture := range []struct {
		name, body string
		exists     bool
	}{{"absent", "", false}, {"empty object", "{}", true}, {"empty packages", `{"packages":[]}`, true}} {
		t.Run(fixture.name, func(t *testing.T) {
			config, err := ReadMachineJSON(func(file string) ([]byte, bool, error) {
				if file != ".smithers/machine.json" {
					t.Fatalf("unexpected read %q", file)
				}
				return []byte(fixture.body), fixture.exists, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(config.Packages) != 0 {
				t.Fatalf("empty config adds packages: %#v", config.Packages)
			}
		})
	}
}

func TestReadMachineJSONPackageNameBoundaries(t *testing.T) {
	// T-MCH-10 Changes (machine_json.go): reject names outside
	// ^[a-z0-9][a-z0-9+.-]{0,127}$, including 129-character names.
	for _, name := range []string{"", "Apt", "-git", "+git", ".git", "git:arm64", " git", "git ", "git\n", "git;id", "git$(id)", "git/../../x", "gít", strings.Repeat("a", 129)} {
		t.Run(fmt.Sprintf("%q", name), func(t *testing.T) {
			body, err := json.Marshal(map[string]any{"packages": []string{name}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = ReadMachineJSON(detectedFixture(map[string]string{".smithers/machine.json": string(body)}))
			requireRecipeRefusal(t, err, ".smithers/machine.json")
		})
	}
}

func TestReadMachineJSONPackageCountBoundary(t *testing.T) {
	// T-MCH-10 Changes (machine_json.go): at most 64 package entries.
	for _, count := range []int{64, 65} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			packages := make([]string, count)
			for i := range packages {
				packages[i] = fmt.Sprintf("package%d", i)
			}
			body, err := json.Marshal(map[string]any{"packages": packages})
			if err != nil {
				t.Fatal(err)
			}
			config, err := ReadMachineJSON(detectedFixture(map[string]string{".smithers/machine.json": string(body)}))
			if count == 65 {
				requireRecipeRefusal(t, err, ".smithers/machine.json")
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(config.Packages, packages) {
				t.Fatalf("valid boundary loses packages: %#v", config.Packages)
			}
		})
	}
}

func TestReadMachineJSONRejectsInvalidSchema(t *testing.T) {
	// Spec §8.6.1/M-29 and T-MCH-10 Changes permit a packages[] declaration;
	// malformed, ambiguous, or command-bearing declarations must refuse.
	for _, body := range []string{
		"", "{", "null", "[]", `{"packages":null}`, `{"packages":"git"}`, `{"packages":[42]}`, `{"packages":[null]}`,
		`{"packages":[],"command":"sudo id"}`, `{"Packages":["git"]}`, `{"packages":[],"packages":["git"]}`,
		`{"packages":[]} {}`, `{"packages":[]} trailing`, `{"packages":["git",]}`,
	} {
		t.Run(body, func(t *testing.T) {
			_, err := ReadMachineJSON(detectedFixture(map[string]string{".smithers/machine.json": body}))
			requireRecipeRefusal(t, err, ".smithers/machine.json")
		})
	}
}

func TestReadMachineJSONPropagatesReadFailure(t *testing.T) {
	sentinel := errors.New("mirror read interrupted")
	_, err := ReadMachineJSON(func(string) ([]byte, bool, error) { return nil, false, sentinel })
	if !errors.Is(err, sentinel) {
		t.Fatalf("read failure = %v; want preserved cause", err)
	}
}
