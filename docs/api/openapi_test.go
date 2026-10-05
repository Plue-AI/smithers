package api_test

import (
	"os"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestOpenAPIOperationIDsAreUnique(t *testing.T) {
	data, err := os.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		// A path item also holds extensions such as x-composition and shared
		// parameters, so only method keys are decoded as operations.
		Paths map[string]map[string]yaml.Node `yaml:"paths"`
	}
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Paths) == 0 {
		t.Fatal("OpenAPI document has no paths")
	}
	seen := map[string]string{}
	for path, item := range document.Paths {
		for _, method := range []string{"get", "post", "put", "patch", "delete", "head", "options", "trace"} {
			node, ok := item[method]
			if !ok {
				continue
			}
			location := method + " " + path
			var op struct {
				OperationID string `yaml:"operationId"`
			}
			if err := node.Decode(&op); err != nil {
				t.Errorf("%s: %v", location, err)
				continue
			}
			if op.OperationID == "" {
				t.Errorf("%s has no operationId", location)
				continue
			}
			if previous, exists := seen[op.OperationID]; exists {
				t.Errorf("operationId %q shared by %s and %s", op.OperationID, previous, location)
			}
			seen[op.OperationID] = location
		}
	}
}
