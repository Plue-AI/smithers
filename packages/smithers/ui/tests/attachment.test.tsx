/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentPreview,
  AttachmentRemove,
  AttachmentTitle,
  AttachmentTrigger,
} from "../src/chat/Attachment";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  removeDarkThemeStyles();
});

describe("Attachment", () => {
  test("renders file metadata and extension fallback", () => {
    const sized = renderToStaticMarkup(<Attachment name="report.pdf" sizeBytes={2048} mediaType="application/pdf" />);
    expect(sized).toContain("PDF");
    expect(sized).toContain("2.0 KB · application/pdf");
    const extensionless = renderToStaticMarkup(<Attachment name="README" />);
    expect(extensionless).toContain("FILE");
  });

  test("numeric progress exposes aria-valuenow while indeterminate progress omits it", () => {
    const numeric = renderToStaticMarkup(<Attachment name="photo.png" state="uploading" progress={42} />);
    expect(numeric).toContain('role="progressbar"');
    expect(numeric).toContain('aria-valuenow="42"');
    expect(numeric).toContain('aria-label="Uploading photo.png"');

    const indeterminate = renderToStaticMarkup(<Attachment name="photo.png" state="processing" progress={null} />);
    expect(indeterminate).toContain('role="progressbar"');
    expect(indeterminate).not.toContain("aria-valuenow");
    expect(indeterminate).toContain("sui-attachment-progress-indeterminate");
  });

  test("defined progress always renders while undefined progress never does", () => {
    const ready = renderToStaticMarkup(<Attachment name="ready.txt" state="ready" progress={100} />);
    expect(ready).toContain('data-slot="attachment-progress"');
    expect(ready).toContain('aria-valuenow="100"');

    const failed = renderToStaticMarkup(<Attachment name="failed.txt" state="error" progress={null} />);
    expect(failed).toContain('data-slot="attachment-progress"');
    expect(failed).toContain("sui-attachment-progress-indeterminate");

    const uploading = renderToStaticMarkup(<Attachment name="uploading.txt" state="uploading" />);
    const processing = renderToStaticMarkup(<Attachment name="processing.txt" state="processing" />);
    expect(uploading).not.toContain('data-slot="attachment-progress"');
    expect(processing).not.toContain('data-slot="attachment-progress"');
  });

  test("renders frozen upload, processing, and error labels", () => {
    expect(renderToStaticMarkup(<Attachment name="a" state="uploading" />)).toContain("Uploading…");
    expect(renderToStaticMarkup(<Attachment name="a" state="processing" />)).toContain("Processing…");
    expect(renderToStaticMarkup(<Attachment name="a" state="error" />)).toContain("Failed");
  });

  test("renders thumbnail and accessible remove action", () => {
    const html = renderToStaticMarkup(<Attachment name="photo.png" thumbnailUrl="/photo.png" onRemove={() => {}} />);
    expect(html).toContain('<img src="/photo.png" alt=""');
    expect(html).toContain('aria-label="Remove photo.png"');
  });

  test("renders under the dark theme", () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Attachment name="dark.txt" />);
    document.body.appendChild(host);
    const attachment = host.querySelector<HTMLElement>('[data-slot="attachment"]')!;
    expect(getComputedStyle(attachment).backgroundColor).toBe("#131b1a");
    host.remove();
  });
});

describe("Attachment compound", () => {
  test("children opt into the compound card with the same root data-state", () => {
    const html = renderToStaticMarkup(
      <Attachment name="design.png" state="uploading" sizeBytes={4096}>
        <AttachmentMedia />
        <AttachmentContent>
          <AttachmentTitle />
          <AttachmentDescription />
        </AttachmentContent>
      </Attachment>,
    );
    expect(html).toContain('data-slot="attachment"');
    expect(html).toContain('data-state="uploading"');
    expect(html).toContain('data-slot="attachment-media"');
    expect(html).toContain('data-slot="attachment-content"');
    expect(html).toContain('data-slot="attachment-title"');
    expect(html).toContain("design.png");
    expect(html).toContain("Uploading…");
    // compound mode does not render the chip's details column
    expect(html).not.toContain("sui-attachment-details");
  });

  test("compound without children keeps the chip DOM byte-identical", () => {
    const before = renderToStaticMarkup(
      <Attachment name="chip.txt" sizeBytes={100} mediaType="text/plain" onRemove={() => {}} />,
    );
    expect(before).toContain("sui-attachment-details");
    expect(before).toContain('data-slot="attachment-remove"');
  });

  test("title and description default from context but accept overrides", () => {
    const html = renderToStaticMarkup(
      <Attachment name="report.pdf" sizeBytes={2048} mediaType="application/pdf">
        <AttachmentContent>
          <AttachmentTitle>Custom title</AttachmentTitle>
          <AttachmentDescription>Custom description</AttachmentDescription>
        </AttachmentContent>
      </Attachment>,
    );
    expect(html).toContain("Custom title");
    expect(html).toContain("Custom description");
    expect(html).not.toContain("report.pdf</div>");
    const defaults = renderToStaticMarkup(
      <Attachment name="report.pdf" sizeBytes={2048} mediaType="application/pdf">
        <AttachmentContent>
          <AttachmentTitle />
          <AttachmentDescription />
        </AttachmentContent>
      </Attachment>,
    );
    expect(defaults).toContain("report.pdf");
    expect(defaults).toContain("2.0 KB · application/pdf");
  });

  test("media falls back to the extension tile without a thumbnail", () => {
    const withThumb = renderToStaticMarkup(
      <Attachment name="photo.png" thumbnailUrl="/p.png">
        <AttachmentMedia />
      </Attachment>,
    );
    expect(withThumb).toContain('<img src="/p.png" alt=""');
    const withoutThumb = renderToStaticMarkup(
      <Attachment name="photo.png">
        <AttachmentMedia />
      </Attachment>,
    );
    expect(withoutThumb).toContain("PNG");
    expect(withoutThumb).not.toContain("<img");
  });

  test("actions render a toolbar with labeled icon buttons", () => {
    const html = renderToStaticMarkup(
      <Attachment name="a.txt">
        <AttachmentActions>
          <AttachmentAction label="Download" tooltip="Save to disk" icon={<span>D</span>} />
        </AttachmentActions>
      </Attachment>,
    );
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Attachment actions"');
    expect(html).toContain('aria-label="Download"');
    expect(html).toContain('title="Save to disk"');
    expect(html).toContain("sui-sr-only");
  });

  test("trigger renders a full-card button wrapper", () => {
    const html = renderToStaticMarkup(
      <Attachment name="a.txt">
        <AttachmentTrigger aria-label="Open a.txt">
          <AttachmentTitle />
        </AttachmentTrigger>
      </Attachment>,
    );
    expect(html).toContain('data-slot="attachment-trigger"');
    expect(html).toContain('aria-label="Open a.txt"');
  });

  test("preview renders an image only when given an image src, else a tile", () => {
    const image = renderToStaticMarkup(
      <Attachment name="photo.png">
        <AttachmentPreview src="/p.png" mediaType="image/png" alt="preview" />
      </Attachment>,
    );
    expect(image).toContain('<img src="/p.png" alt="preview"');
    const noSrc = renderToStaticMarkup(
      <Attachment name="photo.png">
        <AttachmentPreview />
      </Attachment>,
    );
    expect(noSrc).toContain("sui-attachment-preview-tile");
    expect(noSrc).toContain("PNG");
    expect(noSrc).not.toContain("<img");
    const nonImage = renderToStaticMarkup(
      <Attachment name="doc.pdf">
        <AttachmentPreview src="/doc.pdf" mediaType="application/pdf" />
      </Attachment>,
    );
    expect(nonImage).toContain("sui-attachment-preview-tile");
    expect(nonImage).toContain("PDF");
  });

  test("remove reads its aria-label from the context name", () => {
    const html = renderToStaticMarkup(
      <Attachment name="remove-me.txt" onRemove={() => {}}>
        <AttachmentActions>
          <AttachmentRemove />
        </AttachmentActions>
      </Attachment>,
    );
    expect(html).toContain('aria-label="Remove remove-me.txt"');
    expect(html).toContain('data-slot="attachment-remove"');
  });

  test("group renders a list and turns child attachments into listitems", () => {
    const html = renderToStaticMarkup(
      <AttachmentGroup>
        <Attachment name="one.txt" />
        <Attachment name="two.txt">
          <AttachmentTitle />
        </Attachment>
      </AttachmentGroup>,
    );
    expect(html).toContain('data-slot="attachment-group"');
    expect(html).toContain('role="list"');
    expect(html.match(/role="listitem"/g)).toHaveLength(2);
    const ungrouped = renderToStaticMarkup(<Attachment name="solo.txt" />);
    expect(ungrouped).not.toContain("listitem");
  });

  test("compound parts throw outside an Attachment", () => {
    expect(() => renderToStaticMarkup(<AttachmentTitle />)).toThrow(/within an Attachment/);
  });

  test("renders compound cards under the dark theme", () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <AttachmentGroup>
        <Attachment name="dark-card.txt">
          <AttachmentMedia />
          <AttachmentContent>
            <AttachmentTitle />
          </AttachmentContent>
        </Attachment>
      </AttachmentGroup>,
    );
    document.body.appendChild(host);
    const attachment = host.querySelector<HTMLElement>('[data-slot="attachment"]')!;
    expect(getComputedStyle(attachment).backgroundColor).toBe("#131b1a");
    host.remove();
  });
});
