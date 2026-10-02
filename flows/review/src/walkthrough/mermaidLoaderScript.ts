/**
 * Inline loader for the gzipped Mermaid runtime: decodes the base64 payload
 * from the #mermaid-runtime-gz data tag through DecompressionStream (works on
 * file:// in modern Chrome/Safari/Firefox), evaluates it, then renders every
 * diagram with a theme matched to the effective color scheme. Re-renders on
 * theme toggle. Browsers without DecompressionStream get a short note inside
 * each figure instead of a broken page.
 */
export const mermaidLoaderScript = `
(function () {
  "use strict";
  var data = document.getElementById("mermaid-runtime-gz");
  if (!data) return;
  var figures = document.querySelectorAll("figure.diagram");
  function noteAll(text) {
    figures.forEach(function (figure) {
      var note = document.createElement("p");
      note.className = "diagram-note";
      note.textContent = text;
      figure.prepend(note);
    });
  }
  if (typeof DecompressionStream === "undefined") {
    noteAll("Diagrams need a modern browser (DecompressionStream unavailable).");
    return;
  }
  var bytes = Uint8Array.from(atob(data.textContent.trim()), function (c) { return c.charCodeAt(0); });
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  new Response(stream).text().then(function (code) {
    (0, eval)(code);
    var darkQuery = matchMedia("(prefers-color-scheme: dark)");
    function effectiveDark() {
      var forced = document.documentElement.getAttribute("data-theme");
      if (forced) return forced === "dark";
      return darkQuery.matches;
    }
    function render() {
      document.querySelectorAll("pre.mermaid").forEach(function (pre) {
        if (!pre.getAttribute("data-src")) pre.setAttribute("data-src", pre.textContent);
        pre.removeAttribute("data-processed");
        pre.textContent = pre.getAttribute("data-src");
      });
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: effectiveDark() ? "dark" : "neutral" });
      mermaid.run({ querySelector: "pre.mermaid" }).catch(function () {});
    }
    render();
    window.addEventListener("walkthrough-theme", render);
    darkQuery.addEventListener("change", function () {
      if (!document.documentElement.getAttribute("data-theme")) render();
    });
  }).catch(function () {
    noteAll("Diagram rendering failed to initialize in this browser.");
  });
})();
`.trim();
