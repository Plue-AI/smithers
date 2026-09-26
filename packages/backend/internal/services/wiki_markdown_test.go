package services

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWikiMarkdown_RoundTripMetadataAndLiteralCode(t *testing.T) {
	body := "---\r\naliases: [Intro, Start]\r\ntags: [docs, '#guide']\r\ncustom: {nested: [one, two]}\r\n---\r\n# Heading\r\n[[folder/Page#Section|label]] ![[image.png|200]] [[#Heading]] #nested/tag #123\r\n`[[hidden]] #hidden`\r\n    [[indented]]\r\n~~~md\r\n[[fenced]]\r\n~~~\r\n"
	metadata := ParseWikiMarkdown(body)
	require.Equal(t, []string{"Intro", "Start"}, metadata.Aliases)
	require.Equal(t, []string{"docs", "guide", "nested/tag"}, metadata.Tags)
	require.Equal(t, []string{"Heading"}, metadata.Headings)
	require.Len(t, metadata.Links, 3)
	require.Equal(t, "folder/Page", metadata.Links[0].Target)
	require.Equal(t, "Section", metadata.Links[0].Heading)
	require.True(t, metadata.Links[1].Embed)
	encoded, err := json.Marshal(metadata)
	require.NoError(t, err)
	require.Contains(t, string(encoded), "nested")
	bad := ParseWikiMarkdown("---\ntags: [unclosed\n---\n[[Page]]")
	require.Equal(t, "invalid frontmatter", bad.Error)
	require.Len(t, bad.Links, 1)
}
func TestWikiMarkdown_ResolutionDoesNotGuessAmbiguousTargets(t *testing.T) {
	pages := []WikiIndexPage{
		{WikiPageResponse: WikiPageResponse{ID: 1, Path: "a/Home.md"}, Metadata: ParseWikiMarkdown("[[Page]] [[shared]] [[missing]] [[b/Page.md#H]]")},
		{WikiPageResponse: WikiPageResponse{ID: 2, Path: "a/Page.md"}, Metadata: ParseWikiMarkdown("---\naliases: [shared]\n---\n")},
		{WikiPageResponse: WikiPageResponse{ID: 3, Path: "b/Page.md"}, Metadata: ParseWikiMarkdown("---\naliases: [shared]\n---\n")},
	}
	resolveWikiLinks(pages)
	require.Equal(t, int64(2), *pages[0].Metadata.Links[0].PageID)
	require.Nil(t, pages[0].Metadata.Links[1].PageID)
	require.Nil(t, pages[0].Metadata.Links[2].PageID)
	require.Equal(t, int64(3), *pages[0].Metadata.Links[3].PageID)
}
