package routes

import (
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"testing"
)

func TestOffsetPaginationHeadersKeepOnlyRepresentableNeighbors(t *testing.T) {
	for _, row := range []struct {
		name string
		page int
		want string
	}{
		{"last aligned offset", 92233720368547759, `</items?limit=100>; rel="first", </items?cursor=9223372036854775700&limit=100>; rel="prev"`},
		{"first unrepresentable offset retains valid previous", 92233720368547760, `</items?limit=100>; rel="first", </items?cursor=9223372036854775800&limit=100>; rel="prev"`},
		{"neither adjacent offset representable", 4611686018427387906, `</items?limit=100>; rel="first"`},
	} {
		t.Run(row.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest("GET", "/items", nil)
			setOffsetCursorPaginationHeaders(recorder, request, row.page, 100, 100, 9223372036854775807)
			require.Equal(t, row.want, recorder.Header().Get("Link"))
			require.Equal(t, "9223372036854775807", recorder.Header().Get("X-Total-Count"))
			require.Equal(t, "100", recorder.Header().Get("X-Per-Page"))
		})
	}
}
