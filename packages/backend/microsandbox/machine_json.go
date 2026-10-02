package microsandbox

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
)

const machineJSONPath = ".smithers/machine.json"

type MachineJSON struct {
	Packages []string `json:"packages"`
}

var debianPackageName = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{0,127}$`)

// ReadMachineJSON accepts only reviewed Debian package names. Its caller
// supplies a reader fixed to main, even when preparing another revision.
func ReadMachineJSON(read func(string) ([]byte, bool, error)) (MachineJSON, error) {
	var config MachineJSON
	data, exists, err := read(machineJSONPath)
	if err != nil {
		return config, fmt.Errorf("read %s: %w", machineJSONPath, err)
	}
	if !exists {
		return config, nil
	}
	invalid := func(message string) (MachineJSON, error) {
		return MachineJSON{}, recipeRefusal(machineJSONPath, message)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return invalid("expected an object containing packages[]")
	}
	seen := false
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil || key != "packages" || seen {
			return invalid("only one packages[] field is allowed")
		}
		seen = true
		var values []json.RawMessage
		if err := decoder.Decode(&values); err != nil || values == nil {
			return invalid("packages must be an array of names")
		}
		if len(values) > 64 {
			return invalid("packages may contain at most 64 entries")
		}
		for _, value := range values {
			var name string
			if err := json.Unmarshal(value, &name); err != nil || !debianPackageName.MatchString(name) {
				return invalid("invalid Debian package name " + string(value))
			}
			config.Packages = append(config.Packages, name)
		}
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return invalid("invalid JSON object")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return invalid("unexpected content after object")
	}
	return config, nil
}
