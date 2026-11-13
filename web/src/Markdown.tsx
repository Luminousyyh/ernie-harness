import { createElement, type ReactNode } from 'react';
import { CopyButton } from './components.js';
import { safeHref } from './state.js';

// All model output becomes React text nodes. HTML is never interpreted; images are not fetched.
function inline(text: string, prefix = ''): ReactNode[] {
  const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*)/g;
  const result: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    const index = match.index ?? 0;
    if (index > start) result.push(text.slice(start, index));
    const value = match[0];
    const key = `${prefix}-${index}`;
    if (value.startsWith('`')) result.push(<code key={key}>{value.slice(1, -1)}</code>);
    else if (value.startsWith('**')) result.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    else if (value.startsWith('*')) result.push(<em key={key}>{value.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
      const href = link && safeHref(link[2]);
      result.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{link![1]}</a> : <span key={key}>{link?.[1] ?? value}</span>);
    }
    start = index + value.length;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}
export function Markdown({text}: {text: string}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `block-${i}`;
    if (!line.trim()) {i++; continue;}
    const fence = /^\s*```([^`]*)$/.exec(line);
    if (fence) {
      const code: string[] = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<div className="code-block" key={key}><div className="code-header"><span>{fence[1].trim() || '代码'}</span><CopyButton text={code.join('\n')} /></div><pre><code>{code.join('\n')}</code></pre></div>); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {blocks.push(createElement(`h${Math.min(heading[1].length + 1, 6)}`, {key}, inline(heading[2], key))); i++; continue;}
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {blocks.push(<hr key={key} />); i++; continue;}
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key}>{inline(quote.join('\n'), key)}</blockquote>); continue;
    }
    if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\. / : /^\s*[-*+] /).test(lines[i])) {
        const content = lines[i].replace(/^\s*(?:[-*+]|\d+\.) /, '');
        const checkbox = /^\[([ xX])\]\s(.*)$/.exec(content);
        items.push(<li key={`${key}-${i}`}>{checkbox ? <><input type="checkbox" checked={checkbox[1] !== ' '} readOnly aria-label={checkbox[2]} />{inline(checkbox[2])}</> : inline(content)}</li>); i++;
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[i + 1])) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const headers = cells(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(<div className="markdown-table" key={key}><table><thead><tr>{headers.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(\s*```|#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{inline(paragraph.join('\n'), key)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
