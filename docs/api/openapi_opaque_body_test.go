package api_test

import (
	"os"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// opaqueBodyExtension marks an operation whose request body is opaque or
// user-authored by design. Edge filters that match attack signatures in
// bodies (a deployment's WAF) must skip these operations.
const opaqueBodyExtension = "x-smithers-opaque-body"

// opaqueBodyMethods are the write methods the extension may mark. This is
// annotation policy, not HTTP: a DELETE may carry a body (user_devices.go
// decodes one), but no DELETE body is opaque by design today; add delete here
// when one is. The rule keys on the method rather than a declared requestBody
// because several body-carrying operations are still skeletons without one,
// and declaring a body changes the generated clients' signatures.
var opaqueBodyMethods = []string{"post", "put", "patch"}

var operationMethods = []string{"get", "put", "post", "delete", "options", "head", "patch", "trace"}

// opaqueBodyViolations walks the whole document and returns the operations
// that carry the extension and every misuse of it.
func opaqueBodyViolations(document *yaml.Node) (tagged []string, violations []string) {
	var walk func(node *yaml.Node, trail []string)
	walk = func(node *yaml.Node, trail []string) {
		switch node.Kind {
		case yaml.DocumentNode, yaml.SequenceNode:
			for _, child := range node.Content {
				walk(child, trail)
			}
		case yaml.MappingNode:
			for i := 0; i+1 < len(node.Content); i += 2 {
				key, value := node.Content[i].Value, node.Content[i+1]
				here := append(slices.Clone(trail), key)
				if key != opaqueBodyExtension {
					walk(value, here)
					continue
				}
				location := strings.Join(here, " ")
				if len(trail) != 3 || trail[0] != "paths" || !slices.Contains(operationMethods, trail[2]) {
					violations = append(violations, location+": must sit on an operation under paths")
					continue
				}
				operation := trail[2] + " " + trail[1]
				if !slices.Contains(opaqueBodyMethods, trail[2]) {
					violations = append(violations, operation+": the extension marks only POST, PUT, and PATCH operations")
					continue
				}
				if value.Kind != yaml.ScalarNode || value.Tag != "!!bool" || value.Value != "true" {
					violations = append(violations, operation+": must be the boolean true; omit it instead of false")
					continue
				}
				tagged = append(tagged, operation)
			}
		}
	}
	walk(document, nil)
	return tagged, violations
}

func TestOpenAPIOpaqueBodyMarksBodyOperations(t *testing.T) {
	data, err := os.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	tagged, violations := opaqueBodyViolations(&document)
	for _, violation := range violations {
		t.Error(violation)
	}
	// Deployments check their edge exemptions against these tags; an
	// untagged document would pass those checks vacuously.
	if len(tagged) == 0 {
		t.Errorf("no operation carries %s", opaqueBodyExtension)
	}
}

func TestOpaqueBodyViolations(t *testing.T) {
	for _, test := range []struct {
		name       string
		document   string
		tagged     []string
		violations []string
	}{
		{
			name:     "body methods with boolean true",
			document: "paths:\n  /a:\n    post:\n      x-smithers-opaque-body: true\n    put:\n      x-smithers-opaque-body: true\n    patch:\n      x-smithers-opaque-body: true\n",
			tagged:   []string{"post /a", "put /a", "patch /a"},
		},
		{
			name:       "get is not annotated",
			document:   "paths:\n  /a:\n    get:\n      x-smithers-opaque-body: true\n",
			violations: []string{"get /a: the extension marks only POST, PUT, and PATCH operations"},
		},
		{
			name:       "delete is not annotated even though a DELETE may carry a body",
			document:   "paths:\n  /a/{id}:\n    delete:\n      x-smithers-opaque-body: true\n",
			violations: []string{"delete /a/{id}: the extension marks only POST, PUT, and PATCH operations"},
		},
		{
			name:       "quoted string is not a boolean",
			document:   "paths:\n  /a:\n    post:\n      x-smithers-opaque-body: 'true'\n",
			violations: []string{"post /a: must be the boolean true; omit it instead of false"},
		},
		{
			name:       "false is refused",
			document:   "paths:\n  /a:\n    post:\n      x-smithers-opaque-body: false\n",
			violations: []string{"post /a: must be the boolean true; omit it instead of false"},
		},
		{
			name:       "mapping is not a boolean",
			document:   "paths:\n  /a:\n    post:\n      x-smithers-opaque-body:\n        value: true\n",
			violations: []string{"post /a: must be the boolean true; omit it instead of false"},
		},
		{
			name:       "path item level",
			document:   "paths:\n  /a:\n    x-smithers-opaque-body: true\n    post: {}\n",
			violations: []string{"paths /a x-smithers-opaque-body: must sit on an operation under paths"},
		},
		{
			name:       "inside an operation's request body",
			document:   "paths:\n  /a:\n    post:\n      requestBody:\n        x-smithers-opaque-body: true\n",
			violations: []string{"paths /a post requestBody x-smithers-opaque-body: must sit on an operation under paths"},
		},
		{
			name:       "outside paths",
			document:   "x-smithers-opaque-body: true\ncomponents:\n  schemas:\n    A:\n      x-smithers-opaque-body: true\n",
			violations: []string{"x-smithers-opaque-body: must sit on an operation under paths", "components schemas A x-smithers-opaque-body: must sit on an operation under paths"},
		},
		{
			name:       "path item parameters",
			document:   "paths:\n  /a/{id}:\n    parameters:\n      - name: id\n        x-smithers-opaque-body: true\n",
			violations: []string{"paths /a/{id} parameters x-smithers-opaque-body: must sit on an operation under paths"},
		},
		{
			name:     "untagged document",
			document: "paths:\n  /a:\n    post: {}\n",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var document yaml.Node
			if err := yaml.Unmarshal([]byte(test.document), &document); err != nil {
				t.Fatal(err)
			}
			tagged, violations := opaqueBodyViolations(&document)
			if !slices.Equal(tagged, test.tagged) {
				t.Errorf("tagged = %q, want %q", tagged, test.tagged)
			}
			if !slices.Equal(violations, test.violations) {
				t.Errorf("violations = %q, want %q", violations, test.violations)
			}
		})
	}
}
