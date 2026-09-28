/**
 * Allow only image sources that load without contacting a third party: a
 * `data:image/…` or `blob:` URL, or a same-origin relative path. An `<img>`
 * fetches on render with no click, so a remote URL from model or tool output
 * would leak the viewer's IP and whatever run data the URL encodes. Hosts
 * that want a remote image proxy it through their own origin.
 *
 * Control characters are refused for the reason `safeHref` gives: browsers
 * strip tab/newline from a URL, so "/\t/evil.test" would parse as
 * "//evil.test" after the checks below passed it.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function safeImageSrc(raw: string): string | undefined {
  const src = raw.trim();
  if (src === "" || CONTROL_CHARS.test(src)) return undefined;
  if (/^data:image\//i.test(src) || /^blob:/i.test(src)) return src;
  // Any other scheme, and a protocol-relative or backslash-led path, names another origin.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || /^[\\/][\\/]/.test(src)) return undefined;
  return src;
}
