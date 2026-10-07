package hostbackup

import (
	"regexp"
	"strconv"
	"strings"
)

// CompareRelease orders canonical release versions, including alpha and RC
// releases, so a launch candidate can be backed up and restored forward.
func CompareRelease(a, b string) (int, error) {
	coreA, preA, err := releaseParts(a)
	if err != nil {
		return 0, err
	}
	coreB, preB, err := releaseParts(b)
	if err != nil {
		return 0, err
	}
	for i := range coreA {
		if coreA[i] != coreB[i] {
			return cmpUint(coreA[i], coreB[i]), nil
		}
	}
	// A release follows its own prereleases.
	if len(preA) == 0 || len(preB) == 0 {
		return cmpUint(uint64(len(preB)), uint64(len(preA))), nil
	}
	for i := 0; i < len(preA) && i < len(preB); i++ {
		numericA := decimalIdentifier.MatchString(preA[i])
		numericB := decimalIdentifier.MatchString(preB[i])
		switch {
		case numericA && numericB:
			// Numeric prerelease identifiers are unbounded. Compare their
			// canonical decimal lengths first rather than overflowing uint64.
			if len(preA[i]) != len(preB[i]) {
				return cmpUint(uint64(len(preA[i])), uint64(len(preB[i]))), nil
			}
			if preA[i] != preB[i] {
				return strings.Compare(preA[i], preB[i]), nil
			}
		case numericA != numericB:
			if numericA {
				return -1, nil
			}
			return 1, nil
		case preA[i] != preB[i]:
			return strings.Compare(preA[i], preB[i]), nil
		}
	}
	return cmpUint(uint64(len(preA)), uint64(len(preB))), nil
}

func cmpUint(a, b uint64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

var decimalIdentifier = regexp.MustCompile(`^[0-9]+$`)

var prereleaseIdentifier = regexp.MustCompile(`^[0-9A-Za-z-]+$`)

func releaseParts(version string) ([3]uint64, []string, error) {
	var numbers [3]uint64
	invalid := func(cause error) ([3]uint64, []string, error) {
		return numbers, nil, &Error{Code: WrongVersion, Path: version}
	}
	core, prerelease, hasPrerelease := strings.Cut(version, "-")
	parts := strings.Split(core, ".")
	if len(parts) != len(numbers) {
		return invalid(nil)
	}
	for i, part := range parts {
		n, err := strconv.ParseUint(part, 10, 64)
		if err != nil || part == "" || (len(part) > 1 && part[0] == '0') || !decimalIdentifier.MatchString(part) {
			return invalid(err)
		}
		numbers[i] = n
	}
	if !hasPrerelease {
		return numbers, nil, nil
	}
	identifiers := strings.Split(prerelease, ".")
	for _, identifier := range identifiers {
		if !prereleaseIdentifier.MatchString(identifier) || (decimalIdentifier.MatchString(identifier) && len(identifier) > 1 && identifier[0] == '0') {
			return invalid(nil)
		}
	}
	return numbers, identifiers, nil
}
