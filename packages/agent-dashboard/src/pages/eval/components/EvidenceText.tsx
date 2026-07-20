/**
 * EvidenceText — markdown (via the EXISTING chat Markdown atom, no new dep)
 * with `[evidence-N]` markers highlighted as `<mark class="evidence-marker">`
 * (stable class + `Evidence N` title).
 *
 * Approach: the Markdown atom renders through dangerouslySetInnerHTML, so the
 * highlight is a post-render DOM pass over the container's TEXT nodes — real
 * DOM ancestry (not regex-over-HTML) is what makes skipping code robust:
 * markers inside `<code>`/`<pre>` (inline + fenced code) are intentionally
 * left un-highlighted, and already-wrapped markers are skipped so the pass is
 * idempotent.
 *
 * Documented limitation: highlighting happens after render (an effect); a
 * marker inside an html attribute (e.g. an image alt) is never highlighted,
 * and any external mutation of the container's innerHTML drops the marks
 * until the next content change re-runs the pass.
 */

import { useEffect, useRef } from "react";
import { Markdown } from "../../../chat/atoms";

const MARKER_RE = /\[evidence-(\d+)\]/g;

function makeMark(text: string, n: string): HTMLElement {
  const mark = document.createElement("mark");
  mark.className = "evidence-marker";
  mark.title = `Evidence ${n}`;
  mark.textContent = text;
  // Inline-styled like the rest of the eval surface (accent-dim pill, matching
  // the Badge accent tone's rgba background over the CSS-var bridge).
  mark.style.background = "rgba(88, 166, 255, 0.15)";
  mark.style.color = "var(--accent)";
  mark.style.borderRadius = "3px";
  mark.style.padding = "0 2px";
  mark.style.fontFamily = "var(--font-mono)";
  mark.style.fontSize = "0.92em";
  return mark;
}

/** Wrap `[evidence-N]` markers in text nodes under `root`; returns the wrap count. */
export function highlightEvidenceMarkers(root: HTMLElement): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.nodeValue || !/\[evidence-\d+\]/.test(t.nodeValue)) continue;
    if (t.parentElement?.closest("code, pre, .evidence-marker")) continue;
    targets.push(t);
  }
  let count = 0;
  for (const t of targets) {
    const text = t.nodeValue ?? "";
    const frag = document.createDocumentFragment();
    let last = 0;
    MARKER_RE.lastIndex = 0;
    for (let m = MARKER_RE.exec(text); m; m = MARKER_RE.exec(text)) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(makeMark(m[0], m[1] ?? ""));
      last = m.index + m[0].length;
      count++;
    }
    if (last > 0) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      t.replaceWith(frag);
    }
  }
  return count;
}

export function EvidenceText({ content, className }: { content: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` IS the trigger — a content change makes React re-set the Markdown innerHTML (dropping the marks), so the highlight pass must re-run exactly then.
  useEffect(() => {
    if (ref.current) highlightEvidenceMarkers(ref.current);
  }, [content]);
  return (
    <div ref={ref}>
      <Markdown content={content} className={className} />
    </div>
  );
}
