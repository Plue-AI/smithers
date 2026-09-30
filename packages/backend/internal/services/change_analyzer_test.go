package services

import (
 "testing"
 "github.com/smithersai/smithers/packages/backend/internal/db"
 "github.com/smithersai/smithers/packages/backend/internal/repohost"
 "github.com/stretchr/testify/require"
)

func TestTrailingWhitespaceFindings(t *testing.T) {
 revision := db.ChangeRevision{RepositoryID:42, ChangeID:"change", Seq:3}
 findings, err := trailingWhitespaceFindings(revision, repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{
  {Path:"src/a.go", Patch:"--- a/src/a.go\n+++ b/src/a.go\n@@ -2,2 +2,3 @@\n unchanged \n-old \n+new \t\n+clean\n@@ -9 +10 @@\n-old\n+last \r\n"},
  {Path:"binary", IsBinary:true, Patch:"@@ -0,0 +1 @@\n+bad \n"},
 }})
 require.NoError(t,err)
 require.Len(t,findings,2)
 require.Equal(t,int64(3),findings[0].Line)
 require.Equal(t,"new",findings[0].Suggestion.String)
 require.Equal(t,int64(10),findings[1].Line)
 require.Equal(t,int64(42),findings[0].RepositoryID)
 require.Equal(t,int64(3),findings[0].RevisionSeq)
 require.Equal(t,"right",findings[0].Side)
 require.Equal(t,"analyzer",findings[0].Source)
 require.NotEmpty(t,findings[0].AnchorHash.String)
}
