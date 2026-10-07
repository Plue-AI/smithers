//go:build !cgo

package livedocument

// A build without cgo (Smithers Cloud's static binaries) has no native
// library. Compose loads one only for a single-owner install, so every other
// composition builds and runs; Load refuses rather than pretending (#3753).
type Library struct{}
type Document struct{}

func Load(string) (*Library, error) { return nil, ErrUnavailable }

func (*Library) Close() error                          { return nil }
func (*Library) Open(Kind, []byte) (*Document, error)  { return nil, ErrUnavailable }
func (*Document) Apply(uint64, []byte) ([]byte, error) { return nil, ErrUnavailable }
func (*Document) Sync1() ([]byte, error)               { return nil, ErrUnavailable }
func (*Document) Sync2([]byte) ([]byte, error)         { return nil, ErrUnavailable }
func (*Document) Awareness([]byte) ([]byte, error)     { return nil, ErrUnavailable }
func (*Document) SetAuthor(uint64, string) ([]byte, error) {
	return nil, ErrUnavailable
}
func (*Document) State() ([]byte, error)      { return nil, ErrUnavailable }
func (*Document) Text(string) (string, error) { return "", ErrUnavailable }
func (*Document) Close() error                { return nil }
func (*Document) Peer([]byte) ([]byte, error) { return nil, ErrUnavailable }
