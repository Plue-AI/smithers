package microsandbox

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

//go:embed toolchains.json
var toolchainManifestJSON []byte

type toolchainManifest struct {
	Schema   string                         `json:"schema"`
	Defaults map[string]string              `json:"defaults"`
	Tools    map[string]map[string]download `json:"tools"`
}

var shippedToolchains, shippedToolchainsError = decodeToolchainManifest()

func decodeToolchainManifest() (toolchainManifest, error) {
	var manifest toolchainManifest
	if err := json.Unmarshal(toolchainManifestJSON, &manifest); err != nil {
		return manifest, err
	}
	if manifest.Schema != "smithers.toolchains/v1" {
		return manifest, fmt.Errorf("invalid toolchain manifest schema")
	}
	for tool, versions := range manifest.Tools {
		for version, pin := range versions {
			if pin.Version != version || !sha256Pattern.MatchString(pin.SHA256) {
				return manifest, fmt.Errorf("invalid %s %s artifact pin", tool, version)
			}
			if _, _, ok := numericVersion(version); !ok {
				return manifest, fmt.Errorf("invalid %s version %s", tool, version)
			}
			if _, err := httpsHost(pin.URL); err != nil {
				return manifest, fmt.Errorf("invalid %s artifact URL: %w", tool, err)
			}
		}
	}
	return manifest, nil
}

func defaultToolVersion(tool string) string { return shippedToolchains.Defaults[tool] }

var numericVersionPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){0,2}$`)
var versionRangePattern = regexp.MustCompile(`^(?:[<>]=?|==?|[~^])?[0-9]+(?:\.(?:[0-9]+|x|\*)){0,2}$`)
var spacedOperator = regexp.MustCompile(`([<>=~^])\s+([0-9])`)

func numericVersion(raw string) ([3]int, int, bool) {
	var out [3]int
	raw = strings.TrimPrefix(strings.TrimPrefix(raw, "v"), "go")
	if !numericVersionPattern.MatchString(raw) {
		return out, 0, false
	}
	parts := strings.Split(raw, ".")
	for i, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil {
			return out, 0, false
		}
		out[i] = value
	}
	return out, len(parts), true
}

func rangeParts(raw string) [][]string {
	var alternatives [][]string
	for _, alternative := range strings.Split(raw, "||") {
		alternative = spacedOperator.ReplaceAllString(strings.TrimSpace(alternative), "${1}${2}")
		alternatives = append(alternatives, strings.Fields(strings.ReplaceAll(alternative, ",", " ")))
	}
	return alternatives
}

func validRequestedVersion(raw string) bool {
	if raw == "stable" {
		return true
	}
	if _, _, ok := numericVersion(raw); ok {
		return true
	}
	for _, parts := range rangeParts(raw) {
		if len(parts) == 0 {
			return false
		}
		for _, part := range parts {
			if !versionRangePattern.MatchString(part) {
				return false
			}
			number := strings.TrimLeft(part, "<>=~^")
			if wildcard := strings.IndexAny(number, "x*"); wildcard >= 0 {
				number = strings.TrimSuffix(number[:wildcard], ".")
			}
			if _, _, ok := numericVersion(number); !ok {
				return false
			}
		}
	}
	return true
}

func compareVersion(a, b [3]int) int {
	for i := range a {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	return 0
}

func matchesRange(version [3]int, raw string) bool {
	for _, parts := range rangeParts(raw) {
		matched := true
		for _, part := range parts {
			op := strings.TrimRight(part, "0123456789.x*")
			number := strings.TrimPrefix(part, op)
			wild := strings.IndexAny(number, "x*")
			if wild >= 0 {
				number = strings.TrimSuffix(number[:wild], ".")
			}
			bound, count, ok := numericVersion(number)
			if !ok {
				matched = false
				break
			}
			cmp := compareVersion(version, bound)
			accept := false
			switch op {
			case ">=":
				accept = cmp >= 0
			case ">":
				accept = cmp > 0
			case "<=":
				accept = cmp <= 0
			case "<":
				accept = cmp < 0
			case "^":
				upper := bound
				if upper[0] > 0 {
					upper = [3]int{upper[0] + 1, 0, 0}
				} else if upper[1] > 0 {
					upper = [3]int{0, upper[1] + 1, 0}
				} else {
					upper[2]++
				}
				accept = cmp >= 0 && compareVersion(version, upper) < 0
			case "~":
				upper := bound
				if count == 1 {
					upper = [3]int{upper[0] + 1, 0, 0}
				} else {
					upper = [3]int{upper[0], upper[1] + 1, 0}
				}
				accept = cmp >= 0 && compareVersion(version, upper) < 0
			default:
				accept = true
				for i := 0; i < count; i++ {
					if version[i] != bound[i] {
						accept = false
					}
				}
			}
			if !accept {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// resolveDetectedTool never consults a live version registry. Exact versions
// absent from the release manifest may use only the nearest pinned patch in
// their minor; ranges/major declarations, including Cargo minimum versions,
// select the newest satisfying pin.
func resolveDetectedTool(tool string, request DetectedTool) (download, error) {
	if shippedToolchainsError != nil {
		return download{}, fmt.Errorf("shipped toolchain manifest: %w", shippedToolchainsError)
	}
	version := strings.TrimSpace(request.Version)
	if version == "stable" && tool == "rust" {
		version = defaultToolVersion(tool)
	}
	pins := shippedToolchains.Tools[tool]
	if pin, ok := pins[version]; ok {
		return pin, nil
	}
	requested, count, exact := numericVersion(version)
	keys := make([]string, 0, len(pins))
	for key := range pins {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, _, _ := numericVersion(keys[i])
		b, _, _ := numericVersion(keys[j])
		return compareVersion(a, b) > 0
	})
	best := ""
	distance := int(^uint(0) >> 1)
	for _, key := range keys {
		candidate, _, _ := numericVersion(key)
		if exact && count == 3 {
			if candidate[0] != requested[0] || candidate[1] != requested[1] {
				continue
			}
			delta := candidate[2] - requested[2]
			if delta < 0 {
				delta = -delta
			}
			if delta < distance {
				best, distance = key, delta
			}
		} else if (exact && count < 3 && candidate[0] == requested[0] && (count == 1 || candidate[1] == requested[1])) || (!exact && validRequestedVersion(version) && matchesRange(candidate, version)) {
			best = key
			break
		}
	}
	if best != "" {
		return pins[best], nil
	}
	reason := "for this minor"
	if !exact {
		reason = "satisfying this declaration"
	}
	return download{}, recipeRefusal(request.File, fmt.Sprintf("%s %s has no pinned artifact %s; choose a version in toolchains.json", tool, request.Version, reason))
}
