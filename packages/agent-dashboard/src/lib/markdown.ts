/**
 * Minimal, dependency-free markdown → HTML — ported verbatim from the legacy
 * cockpit's `md()`. Operates on text that is ALREADY HTML-escaped (so '>' has
 * become '&gt;'), then emits a controlled set of tags. Covers what LLM answers
 * actually use: headings, bold/italic, inline + fenced code, ordered/unordered
 * lists, blockquotes, links, tables, rules. Rendered via dangerouslySetInnerHTML.
 *
 * Ported into the dashboard's STRICT tsconfig (noUncheckedIndexedAccess) — every
 * array/match index is guarded with a `?? ''` (or a captured local) vs the
 * cockpit's looser config. Pure logic is unchanged.
 */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

export const fmtJson = (s: unknown): string => {
  try {
    return JSON.stringify(JSON.parse(String(s)), null, 2);
  } catch {
    return (s as string) ?? '';
  }
};

const BT = String.fromCharCode(96);

function mdEmphasis(s: string): string {
  // images first — `![alt](url)` contains the `[](url)` link shape, so it must
  // match before the link rule. Only http(s) + inline data-image URLs render.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
    /^(https?:\/\/|data:image\/)/i.test(url)
      ? '<img class="md-img" src="' + url.replace(/"/g, '%22') + '" alt="' + String(alt).replace(/"/g, '&quot;') + '" loading="lazy"/>'
      : m,
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, url) =>
    /^(https?:\/\/|mailto:|\/|#)/i.test(url)
      ? '<a href="' + url.replace(/"/g, '%22') + '" target="_blank" rel="noopener">' + t + '</a>'
      : m,
  );
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])__([^_]+?)__(?![\w])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w])_([^_\n]+?)_(?![\w])/g, '$1<em>$2</em>');
  return s;
}

function mdInline(s: string): string {
  const parts = s.split(BT);
  let out = '';
  for (let k = 0; k < parts.length; k++) {
    const seg = parts[k] ?? '';
    out += k % 2 === 1 ? '<code>' + seg + '</code>' : mdEmphasis(seg);
  }
  return out;
}

interface Marker {
  indent: number;
  ordered: boolean;
  num: number;
  prefix: number;
  content: string;
}
function listMarker(line: string): Marker | null {
  const m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
  if (!m) return null;
  const g1 = m[1] ?? '';
  const g2 = m[2] ?? '';
  const g3 = m[3] ?? '';
  const g4 = m[4] ?? '';
  return {
    indent: g1.length,
    ordered: /\d/.test(g2),
    num: parseInt(g2, 10) || 1,
    prefix: g1.length + g2.length + g3.length,
    content: g4,
  };
}

const stripN = (s: string, n: number): string => {
  let k = 0;
  while (k < n && s.charCodeAt(k) === 32) k++;
  return s.slice(k);
};

// Drop a lone <p> wrapper so simple list items stay tight; keep it when nested.
function unwrapP(h: string): string {
  const m = h.match(/^<p class="md-p">([\s\S]*)<\/p>$/);
  const inner = m?.[1];
  return inner != null && inner.indexOf('<p class="md-p">') < 0 ? inner : h;
}

function parseList(lines: string[], start: number): { html: string; next: number } {
  const head = listMarker(lines[start] ?? '') as Marker;
  const indent = head.indent;
  const ordered = head.ordered;
  const items: Array<{ num: number; prefix: number; lines: string[] }> = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? '').trim()) j++;
      if (j >= lines.length) {
        i = j;
        break;
      }
      const lj = lines[j] ?? '';
      const mj = listMarker(lj);
      if (mj && mj.indent === indent && mj.ordered === ordered) {
        if (items.length) items[items.length - 1]?.lines.push('');
        i = j;
        continue;
      }
      if (lj.search(/\S/) > indent) {
        if (items.length) items[items.length - 1]?.lines.push('');
        i++;
        continue;
      }
      break;
    }
    const m = listMarker(line);
    if (m && m.indent === indent && m.ordered === ordered) {
      items.push({ num: m.num, prefix: m.prefix, lines: [m.content] });
      i++;
    } else if (items.length && line.search(/\S/) > indent) {
      const it = items[items.length - 1];
      if (it) it.lines.push(stripN(line, it.prefix));
      i++;
    } else break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const cls = ordered ? 'md-ol' : 'md-ul';
  const first = items[0];
  const startAttr = ordered && first && first.num !== 1 ? ' start="' + first.num + '"' : '';
  let out = '<' + tag + ' class="' + cls + '"' + startAttr + '>';
  for (const it of items) out += '<li>' + unwrapP(mdBlocks(it.lines.join('\n')).trim()) + '</li>';
  return { html: out + '</' + tag + '>', next: i };
}

function isTableSep(line: string): boolean {
  return line.indexOf('|') >= 0 && line.indexOf('-') >= 0 && /^[\s|:-]+$/.test(line);
}
function tableSplit(row: string): string[] {
  let s = row.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s.charAt(k);
    if (ch === '\\' && s.charAt(k + 1) === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}
function mdTable(lines: string[], start: number): { html: string; next: number } {
  const header = tableSplit(lines[start] ?? '');
  const aligns = tableSplit(lines[start + 1] ?? '').map((c) => {
    const L = c.charAt(0) === ':';
    const R = c.charAt(c.length - 1) === ':';
    return L && R ? 'center' : R ? 'right' : L ? 'left' : '';
  });
  let i = start + 2;
  const rows: string[][] = [];
  while (i < lines.length && (lines[i] ?? '').trim() && (lines[i] ?? '').indexOf('|') >= 0) {
    rows.push(tableSplit(lines[i] ?? ''));
    i++;
  }
  const al = (ci: number) => {
    const a = aligns[ci];
    return a ? ' style="text-align:' + a + '"' : '';
  };
  let t = '<table class="md-table"><thead><tr>';
  for (let c = 0; c < header.length; c++) t += '<th' + al(c) + '>' + mdInline(header[c] ?? '') + '</th>';
  t += '</tr></thead><tbody>';
  for (const r of rows) {
    t += '<tr>';
    for (let c = 0; c < header.length; c++) t += '<td' + al(c) + '>' + mdInline(r[c] || '') + '</td>';
    t += '</tr>';
  }
  return { html: t + '</tbody></table>', next: i };
}

function mdBlocks(text: string): string {
  const lines = text.split('\n');
  const fence = BT + BT + BT;
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trimStart().startsWith(fence)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(fence)) {
        buf.push(lines[i] ?? '');
        i++;
      }
      i++; // closing fence
      html += '<pre class="md-pre"><code>' + buf.join('\n') + '</code></pre>';
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min((h[1]?.length ?? 1) + 1, 6);
      html += '<h' + lvl + ' class="md-h">' + mdInline(h[2] ?? '') + '</h' + lvl + '>';
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html += '<hr class="md-hr"/>';
      i++;
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^\s*&gt;\s?/, ''));
        i++;
      }
      html += '<blockquote class="md-bq">' + mdBlocks(buf.join('\n')) + '</blockquote>';
      continue;
    }
    if (listMarker(line)) {
      const r = parseList(lines, i);
      html += r.html;
      i = r.next;
      continue;
    }
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1] ?? '')) {
      const rt = mdTable(lines, i);
      html += rt.html;
      i = rt.next;
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|&gt;\s?)/.test(lines[i] ?? '') &&
      !((lines[i] ?? '').indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1] ?? '')) &&
      !(lines[i] ?? '').trimStart().startsWith(fence)
    ) {
      buf.push(lines[i] ?? '');
      i++;
    }
    html += '<p class="md-p">' + mdInline(buf.join('\n')).replace(/\n/g, '<br/>') + '</p>';
  }
  return html;
}

export const md = (src: string): string => mdBlocks(esc(src || '').replace(/\r\n?/g, '\n'));
