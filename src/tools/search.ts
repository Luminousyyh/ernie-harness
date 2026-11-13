import path from 'node:path';
import type { ToolContext, ToolResult } from '../contracts/index.js';
import { aborted, clip, MAX_OUTPUT_BYTES, readText, searchFiles } from './files.js';
import { ProcessRegistry } from './processes.js';

function matchesGlob(relative: string, glob?: string): boolean {
  if (!glob) return true;
  let expression = '';
  const input = glob.replaceAll('\\', '/');
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '*' && input[index + 1] === '*') {
      index++;
      if (input[index + 1] === '/') { index++; expression += '(?:.*/)?'; }
      else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const candidate = input.includes('/') ? relative : path.posix.basename(relative);
  return new RegExp(`^${expression}$`).test(candidate);
}

export async function search(root: string, pattern: string, input: string, glob: string | undefined, context: ToolContext, processes: ProcessRegistry): Promise<ToolResult> {
  const candidates: string[] = [];
  for await (const file of searchFiles(root, input, context.signal)) {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (matchesGlob(relative, glob)) candidates.push(relative);
  }
  let output = '';
  let truncated = false;
  let useRg = true;
  for (let start = 0; start < candidates.length;) {
    aborted(context.signal);
    const batch: string[] = [];
    let length = 0;
    while (start < candidates.length && batch.length < 64 && (length < 6000 || !batch.length)) {
      const candidate = candidates[start++];
      length += candidate.length + 3;
      batch.push(candidate);
    }
    if (useRg) {
      const result = await processes.run({ executable: 'rg', args: ['--no-config', '--fixed-strings', '--line-number', '--with-filename', '--no-heading', '--color', 'never', '--max-columns', '30000', '--max-columns-preview', '--', pattern, ...batch], timeoutMs: 10000, acceptedExitCodes: [0, 1] }, { ...context, workspace: root });
      if (!result.ok && /ENOENT/.test(result.output)) useRg = false;
      else {
        if (!result.ok) return result;
        output += result.output;
        const bounded = clip(output);
        output = bounded.output;
        truncated ||= !!result.truncated || bounded.truncated;
        if (truncated) break;
        continue;
      }
    }
    for (const file of batch) {
      aborted(context.signal);
      let content: string;
      try { content = await readText(root, file, context.signal); }
      catch (error) {
        aborted(context.signal);
        if (/8 MiB/.test(String(error))) continue;
        throw error;
      }
      if (content.includes('\0')) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].includes(pattern)) {
          const bounded = clip(output + `${file}:${index + 1}:${lines[index]}\n`);
          output = bounded.output;
          truncated ||= bounded.truncated;
          if (truncated) break;
        }
      }
      if (truncated) break;
    }
    if (truncated || Buffer.byteLength(output) >= MAX_OUTPUT_BYTES) break;
  }
  return { ok: true, output, truncated };
}
