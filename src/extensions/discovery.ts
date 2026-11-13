import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ContextContribution, DiscoveryResult, SkillDescriptor } from './types.js';
import { boundedPath, canonicalWorkspace, readBounded, scopedPath } from './security.js';

interface SkillFile extends SkillDescriptor { root: string; file: string }
const MAX_ENTRIES = 512;
const MAX_SKILLS = 128;
const MAX_DEPTH = 4;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_NAMES = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
function scalar(value: string): string {
  const text = value.trim();
  if (text.startsWith('"')) { const parsed: unknown = JSON.parse(text); if (typeof parsed !== 'string') throw new Error(); return parsed; }
  if (text.startsWith("'")) { if (!text.endsWith("'")) throw new Error(); return text.slice(1, -1).replaceAll("''", "'"); }
  if (!text || /^[&*!%\[\]{}]|^<<:|^(?:---|\.\.\.)$/.test(text) || /:\s/.test(text)) throw new Error('Unsupported or unsafe YAML scalar');
  return text.replace(/\s+#.*$/, '').trim();
}
/** Deliberately supports safe standard scalar frontmatter and flat metadata; no YAML object constructors or aliases. */
export function parseSkillDocument(content: string, directoryName: string): { name: string; description: string; body: string } {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') throw new Error('Missing skill frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0 || end > 160 || Buffer.byteLength(lines.slice(1, end).join('\n')) > 8192) throw new Error('Invalid or oversized frontmatter');
  const fields: Record<string, string> = Object.create(null);
  for (let index = 1; index < end; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([a-z][a-z-]*):(?:\s+(.*))?$/.exec(line);
    if (!match || !FIELD_NAMES.has(match[1]) || Object.hasOwn(fields, match[1])) throw new Error('Unsupported or duplicate frontmatter field');
    const key = match[1]; const value = match[2] ?? '';
    if (key === 'metadata') {
      if (value) throw new Error('Metadata must be a flat mapping');
      fields[key] = '';
      while (index + 1 < end && /^\s/.test(lines[index + 1])) {
        const item = /^  ([a-zA-Z][a-zA-Z0-9_-]*):\s+(.+)$/.exec(lines[++index]);
        if (!item || ['constructor', 'prototype', '__proto__'].includes(item[1])) throw new Error('Invalid metadata');
        scalar(item[2]);
      }
    } else if (/^[|>][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (index + 1 < end && (/^  /.test(lines[index + 1]) || lines[index + 1] === '')) parts.push(lines[++index].replace(/^  /, ''));
      if (!parts.length) throw new Error('Empty frontmatter block');
      fields[key] = parts.join(value[0] === '>' ? ' ' : '\n').trim();
    } else fields[key] = scalar(value);
  }
  if (!fields.name || fields.name.length > 64 || !NAME.test(fields.name) || fields.name !== directoryName) throw new Error('Skill name must match its directory');
  if (!fields.description || fields.description.length > 1024) throw new Error('Skill description is required and bounded');
  return { name: fields.name, description: fields.description, body: lines.slice(end + 1).join('\n').trim() };
}

export class InstructionDiscovery {
  private readonly known = new Map<string, Map<string, SkillFile>>();
  constructor(private readonly skillRoots: string[] = []) {}
  async discover(workspace: string, targetPath = '.'): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { agents: [], skills: [], diagnostics: [] };
    const diagnostic = (source: string, code: string) => {
      if (result.diagnostics.length < MAX_ENTRIES) result.diagnostics.push({ source, code, message: 'Document was not loaded: invalid content, boundary or discovery limit' });
    };
    let root: string;
    try { root = await canonicalWorkspace(workspace); } catch { diagnostic('workspace', 'invalid-workspace'); return result; }
    const skills = new Map<string, SkillFile>();
    this.known.set(root, skills);
    try {
      const candidate = scopedPath(root, targetPath);
      // Missing target paths use their closest existing ancestor, without following any escaping symlink.
      let existing = candidate;
      for (let depth = 0; ; depth++) {
        if (depth > 64) throw new Error();
        try { await stat(existing); break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (existing === root) throw error;
          existing = path.dirname(existing);
        }
      }
      await boundedPath(root, existing);
      const directory = (await stat(existing)).isDirectory() ? existing : path.dirname(existing);
      const relative = path.relative(root, directory).split(path.sep).filter(Boolean);
      if (relative.length > 32) throw new Error();
      let current = root;
      for (const part of ['', ...relative]) {
        current = part ? path.join(current, part) : current;
        const agentPath = path.join(current, 'AGENTS.md');
        try {
          const content = await readBounded(root, agentPath);
          result.agents.push({ content, trust: 'untrusted', source: { kind: 'agents', scope: 'workspace', label: `workspace:${path.relative(root, agentPath).replaceAll('\\', '/')}`, path: agentPath } });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic(`workspace:${path.relative(root, agentPath)}`, 'invalid-agents'); }
      }
    } catch { diagnostic('workspace:target', 'invalid-target'); }
    const roots = [{ scope: 'workspace' as const, label: 'workspace', requested: path.join(root, '.agents/skills'), workspaceRoot: root }, ...this.skillRoots.map((requested, index) => ({ scope: 'user' as const, label: `user-${index}`, requested: path.resolve(root, requested), workspaceRoot: undefined }))];
    let visited = 0;
    for (const configured of roots) {
      let sourceRoot: string;
      try {
        sourceRoot = configured.workspaceRoot ? await boundedPath(root, configured.requested) : await realpath(configured.requested);
        if (!(await stat(sourceRoot)).isDirectory()) throw new Error();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic(configured.label, 'invalid-skill-root'); continue; }
      const seen = new Set<string>();
      const scan = async (directory: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || visited >= MAX_ENTRIES || skills.size >= MAX_SKILLS) { diagnostic(configured.label, 'discovery-limit'); return; }
        const canonical = await boundedPath(sourceRoot, directory);
        if (seen.has(canonical)) return;
        seen.add(canonical);
        const entries = [];
        const handle = await opendir(canonical);
        for await (const entry of handle) {
          if (entries.length >= MAX_ENTRIES - visited) { diagnostic(configured.label, 'discovery-limit'); break; }
          entries.push(entry);
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (++visited > MAX_ENTRIES || skills.size >= MAX_SKILLS) { diagnostic(configured.label, 'discovery-limit'); break; }
          const file = path.join(directory, entry.name);
          if (entry.name === 'SKILL.md' && depth > 0) {
            const label = `${configured.label}:${path.relative(sourceRoot, file).replaceAll('\\', '/')}`;
            try {
              const document = parseSkillDocument(await readBounded(sourceRoot, file), path.basename(directory));
              const id = `${configured.label}:${document.name}`;
              if (skills.has(id)) throw new Error('Duplicate skill ID');
              const skill: SkillFile = { id, name: document.name, description: document.description, root: sourceRoot, file, source: { kind: 'skill', scope: configured.scope, label, path: file } };
              skills.set(id, skill);
              const { root: _root, file: _file, ...descriptor } = skill;
              result.skills.push(descriptor);
            } catch { diagnostic(label, 'invalid-skill'); }
          } else if (entry.isDirectory() || entry.isSymbolicLink()) {
            try { if ((await stat(await boundedPath(sourceRoot, file))).isDirectory()) await scan(file, depth + 1); }
            catch { diagnostic(configured.label, 'invalid-skill-path'); }
          }
        }
      };
      try { await scan(sourceRoot, 0); } catch { diagnostic(configured.label, 'invalid-skill-root'); }
    }
    return result;
  }
  async invoke(workspace: string, id: string): Promise<ContextContribution> {
    const canonical = await canonicalWorkspace(workspace);
    const skill = this.known.get(canonical)?.get(id);
    if (!skill) throw new Error('Unknown skill; discover the workspace first');
    if (skill.source.scope === 'workspace') await boundedPath(canonical, skill.file);
    const parsed = parseSkillDocument(await readBounded(skill.root, skill.file), path.basename(path.dirname(skill.file)));
    if (parsed.name !== skill.name) throw new Error('Skill changed since discovery');
    return { content: parsed.body, source: skill.source, trust: 'untrusted' };
  }
  clear(): void { this.known.clear(); }
}
