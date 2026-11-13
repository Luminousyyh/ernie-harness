import {afterEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TraceJournal} from '../src/broker/trace.js';
import {redactText, redactTrace} from '../src/trace/redact.js';

// Synthetic credentials only; these tests never contact a provider.
const providerSecret = 'synthetic-provider-key-for-trace-test';
const trialSecret = 'synthetic-trial-auth-without-prefix';
const patternedSecret = 'sk-or-v1-' + 'a7'.repeat(24);
const secrets = [providerSecret, trialSecret];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'ernie-trace-'));
  roots.push(root);
  return {root, directory: join(root, 'private', 'traces')};
}

async function readRecord(directory: string, attemptId: string, kind: string) {
  return JSON.parse(await readFile(join(directory, `${attemptId}.${kind}.json`), 'utf8'));
}

function assertSafeError(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  const text = String(error) + (error instanceof Error ? error.stack : '');
  for (const secret of [...secrets, patternedSecret]) expect(text).not.toContain(secret);
  expect(error).not.toHaveProperty('cause');
}

async function rejection(operation: Promise<unknown>) {
  const result = await operation.then(() => undefined, error => error);
  assertSafeError(result);
}

async function trySymlink(target: string, path: string, directory = false) {
  try {
    await symlink(target, path, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

describe('shared trace redaction', () => {
  it('redacts exact credential fields recursively without treating token usage as a credential', () => {
    const input = {
      authorization: 'anything', Authorization: 'anything', apiKey: 'anything', api_key: 'anything',
      access_token: 'anything', password: 'anything', secret: 'anything', token: 'anything',
      nested: [{TOKEN: 'anything', password: {nested: 'anything'}}],
      usage: {prompt_tokens: 11, completion_tokens: 19, completion_tokens_details: {reasoning_tokens: 7}},
      token_count: 8, tokenizer: 'unchanged', secretNote: 'unchanged',
    };
    const before = structuredClone(input);
    const output = redactTrace(input) as typeof input;
    for (const key of ['authorization', 'Authorization', 'apiKey', 'api_key', 'access_token', 'password', 'secret', 'token']) {
      expect((output as Record<string, unknown>)[key]).toBe('[REDACTED]');
    }
    expect(output.nested).toEqual([{TOKEN: '[REDACTED]', password: '[REDACTED]'}]);
    expect(output.usage).toEqual(input.usage);
    expect(output.token_count).toBe(8);
    expect(output.tokenizer).toBe('unchanged');
    expect(output.secretNote).toBe('unchanged');
    expect(input).toEqual(before);
  });

  it('redacts known non-prefixed secrets anywhere, patterned credentials and Bearer strings', () => {
    const input = {text: `before/${providerSecret}/middle/${trialSecret}/${patternedSecret}/after`,
      nested: [`Bearer ${trialSecret}`, 'bEaReR synthetic-unknown.auth_token=='],
      [`prefix-${trialSecret}-suffix`]: `embedded:${providerSecret}`};
    const before = structuredClone(input);
    const output = redactTrace(input, secrets) as Record<string, unknown>;
    const serialized = JSON.stringify(output);
    for (const secret of [...secrets, patternedSecret, 'synthetic-unknown.auth_token==']) expect(serialized).not.toContain(secret);
    expect(output.text).toBe('before/[REDACTED]/middle/[REDACTED]/[REDACTED]/after');
    expect(output).toHaveProperty('prefix-[REDACTED]-suffix', 'embedded:[REDACTED]');
    expect(input).toEqual(before);
  });

  it('preserves the Bearer prefix and redacts whole known credentials containing punctuation', () => {
    const punctuationSecret = 'synthetic.part$with:punctuation';
    const text = `data: {"text":"Bearer ${punctuationSecret}"}\r\n\r\n`;
    expect(redactText(text, [punctuationSecret])).toBe('data: {"text":"Bearer [REDACTED]"}\r\n\r\n');
    expect(redactText('prefix Bearer synthetic.unknown== suffix')).toBe('prefix Bearer [REDACTED] suffix');
  });

  it('preserves complete SSE framing and all nonsecret bytes in completed CLI capture', () => {
    const chunks = [': keepalive\r\nevent: message\r\ndata: {"text":"prefix ',
      providerSecret.slice(0, 13), providerSecret.slice(13), ' suffix"}\r\n\r\n',
      'data: {"reasoning_details":[{"type":"reasoning.encrypted","data":"opaque+/=="}]}\n\n',
      'data: [DONE]\r\n\r\n'];
    const capture = chunks.join('');
    expect(redactText(capture, secrets)).toBe(capture.replace(providerSecret, '[REDACTED]'));
    expect(redactTrace({frames: [capture]}, secrets)).toEqual({frames: [capture.replace(providerSecret, '[REDACTED]')]});
    expect(capture).toContain(providerSecret);
  });

  it('preserves JSON shape, opaque reasoning, message details and aliased objects in separate copies', () => {
    const opaque = {type: 'reasoning.encrypted', data: 'opaque+/==\nunchanged', signature: 'opaque-signature', index: 0};
    const input = Object.freeze({choices: Object.freeze([Object.freeze({index: 0, message: Object.freeze({
      role: 'assistant', content: null, reasoning_details: Object.freeze([Object.freeze(opaque)]),
      tool_calls: Object.freeze([]),
    }), finish_reason: 'stop'})]), second: opaque, usage: {completion_tokens: 23}});
    const output = redactTrace(input) as typeof input;
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.choices).not.toBe(input.choices);
    expect(output.choices[0].message.reasoning_details[0]).not.toBe(opaque);
    expect(output.second).not.toBe(opaque);
  });

  it('handles literal overlapping secrets, empty entries and prototype-like JSON keys safely', () => {
    expect(redactText('a.b+c a.b ordinary', ['a.b', '', 'a.b+c'])).toBe('[REDACTED] [REDACTED] ordinary');
    const input = JSON.parse('{"__proto__":{"password":"private"},"constructor":"plain","toJSON":"plain"}');
    const output = redactTrace(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(JSON.stringify(output)).toBe('{"__proto__":{"password":"[REDACTED]"},"constructor":"plain","toJSON":"plain"}');
    expect(Object.prototype).not.toHaveProperty('password');
  });

  it('fails closed on unsafe data without invoking getters or toJSON', () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, 'value', {enumerable: true, get() {invoked = true; throw new Error(providerSecret);}});
    const custom = {toJSON() {invoked = true; throw new Error(trialSecret);}};
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const proxy = new Proxy({}, {ownKeys() {throw new Error(patternedSecret);}});
    const symbolKey = {[Symbol(providerSecret)]: trialSecret};
    const sparse = new Array(2);
    const extraArray = Object.assign(['safe'], {credential: providerSecret});
    for (const value of [undefined, 1n, NaN, Infinity, Symbol(providerSecret), () => providerSecret,
      new Date(), new Map(), circular, accessor, custom, proxy, symbolKey, sparse, extraArray]) {
      let caught: unknown;
      try { redactTrace(value, secrets); } catch (error) { caught = error; }
      assertSafeError(caught);
    }
    expect(invoked).toBe(false);
  });

  it('rejects ambiguous sanitized keys and malformed secret lists safely', () => {
    expect(() => redactTrace({[providerSecret]: 1, [trialSecret]: 2}, secrets)).toThrow();
    for (const badSecrets of [providerSecret, [1], new Array(1), null]) {
      let caught: unknown;
      try { redactText('safe', badSecrets as unknown as string[]); } catch (error) { caught = error; }
      assertSafeError(caught);
    }
  });
});

describe('durable provider trace journal', () => {
  it('writes a versioned sanitized record and retains it across new journal instances', async () => {
    const {directory} = await workspace();
    const attemptId = randomUUID();
    const trialId = '../../allowed/in/metadata';
    const journal = new TraceJournal({directory, secrets: [providerSecret]});
    const input = {messages: [{role: 'user', content: `prefix:${providerSecret}:${trialSecret}:${patternedSecret}:suffix`}], stream: true};
    const before = structuredClone(input);
    const started = Date.now();
    await journal.record(attemptId, 'request', input, {trialId, secrets: [trialSecret]});
    const record = await readRecord(directory, attemptId, 'request');
    expect(Object.keys(record).sort()).toEqual(['attemptId', 'data', 'kind', 'recordedAt', 'schemaVersion', 'trialId']);
    expect(record).toMatchObject({schemaVersion: 1, kind: 'request', attemptId, trialId,
      data: {messages: [{role: 'user', content: 'prefix:[REDACTED]:[REDACTED]:[REDACTED]:suffix'}], stream: true}});
    expect(typeof record.recordedAt).toBe('string');
    expect(Date.parse(record.recordedAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(record.recordedAt)).toBeLessThanOrEqual(Date.now());
    expect(input).toEqual(before);
    const restarted = new TraceJournal({directory, secrets: [providerSecret]});
    const nextId = randomUUID();
    await restarted.record(nextId, 'failure', {error: `failed ${providerSecret}`}, {trialId});
    expect(await readRecord(directory, attemptId, 'request')).toEqual(record);
    expect(await readRecord(directory, nextId, 'failure')).toMatchObject({data: {error: 'failed [REDACTED]'}});
    expect(await readdir(directory)).toHaveLength(2);
  });

  it('preserves response reasoning and SSE frames, and writes all three kinds independently', async () => {
    const {directory} = await workspace();
    const attemptId = randomUUID();
    const journal = new TraceJournal({directory, secrets});
    const sse = `: heartbeat\r\ndata: {"text":"${trialSecret}"}\r\n\r\ndata: [DONE]\n\n`;
    const response = {choices: [{message: {role: 'assistant', content: null, reasoning_details: [
      {type: 'reasoning.encrypted', data: 'opaque+/==', format: 'unknown.future', index: 2},
      {type: 'reasoning.text', text: `thought ${providerSecret}`, signature: 'unchanged'},
    ]}}], rawSse: sse, usage: {completion_tokens: 37, completion_tokens_details: {reasoning_tokens: 31}}};
    const before = structuredClone(response);
    await journal.record(attemptId, 'request', {messages: []}, {trialId: 'trial'});
    await journal.record(attemptId, 'response', response, {trialId: 'trial'});
    await journal.record(attemptId, 'failure', {message: patternedSecret}, {trialId: 'trial'});
    expect((await readRecord(directory, attemptId, 'response')).data).toEqual({
      ...response, choices: [{message: {...response.choices[0].message, reasoning_details: [response.choices[0].message.reasoning_details[0],
        {...response.choices[0].message.reasoning_details[1], text: 'thought [REDACTED]'}]}}],
      rawSse: sse.replace(trialSecret, '[REDACTED]'),
    });
    expect(response).toEqual(before);
    expect((await readdir(directory)).sort()).toEqual(['failure', 'request', 'response'].map(kind => `${attemptId}.${kind}.json`));
  });

  it('never overwrites completed records, including after restart', async () => {
    const {directory} = await workspace();
    const attemptId = randomUUID();
    const first = new TraceJournal({directory});
    await first.record(attemptId, 'request', {value: 'original'}, {trialId: 'first'});
    const path = join(directory, `${attemptId}.request.json`);
    const original = await readFile(path, 'utf8');
    for (const journal of [first, new TraceJournal({directory})]) {
      await rejection(journal.record(attemptId, 'request', {value: 'replacement'}, {trialId: 'second'}));
      expect(await readFile(path, 'utf8')).toBe(original);
    }
    expect(await readdir(directory)).toEqual([`${attemptId}.request.json`]);
  });

  it('publishes exactly one complete record under a concurrent duplicate race', async () => {
    const {directory} = await workspace();
    const attemptId = randomUUID();
    const attempts = await Promise.allSettled([0, 1].map(value => new TraceJournal({directory}).record(
      attemptId, 'response', {value, text: 'x'.repeat(128 * 1024)}, {trialId: 'race'},
    )));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const record = await readRecord(directory, attemptId, 'response');
    expect([0, 1]).toContain(record.data.value);
    expect(record.data.text).toBe('x'.repeat(128 * 1024));
    expect(await readdir(directory)).toEqual([`${attemptId}.response.json`]);
  });

  it.each(['../escape', '../../escape', '..\\escape', '/absolute', 'C:\\escape', 'not-a-uuid',
    `${randomUUID()}/child`, `${randomUUID()}.request.json`, '00000000-0000-0000-0000-000000000000', providerSecret])(
    'rejects invalid attempt identifiers before writing: %s', async attemptId => {
      const {root, directory} = await workspace();
      await rejection(new TraceJournal({directory}).record(attemptId, 'request', {}, {trialId: 'trial'}));
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('rejects invalid kinds, metadata and secrets without including their values in errors', async () => {
    const {root, directory} = await workspace();
    const journal = new TraceJournal({directory, secrets});
    const attemptId = randomUUID();
    await rejection(journal.record(attemptId, providerSecret as 'request', {}, {trialId: 'trial'}));
    await rejection(journal.record(attemptId, 'request', {}, {trialId: {value: trialSecret} as unknown as string}));
    await rejection(journal.record(attemptId, 'request', {}, {trialId: 'trial', secrets: [1] as unknown as string[]}));
    expect(await readdir(root)).toEqual([]);
  });

  it('sanitizes trial metadata and snapshots constructor secrets without modifying either list', async () => {
    const {directory} = await workspace();
    const configured = [providerSecret];
    const contextSecrets = [trialSecret];
    const journal = new TraceJournal({directory, secrets: configured});
    configured.splice(0);
    const attemptId = randomUUID();
    await journal.record(attemptId, 'failure', {message: providerSecret}, {
      trialId: `../../${trialSecret}`, secrets: contextSecrets,
    });
    expect(await readRecord(directory, attemptId, 'failure')).toMatchObject({trialId: '../../[REDACTED]', data: {message: '[REDACTED]'}});
    expect(contextSecrets).toEqual([trialSecret]);
  });

  it('fails closed for malformed data without leaving a partial record', async () => {
    const {root, directory} = await workspace();
    const circular: Record<string, unknown> = {message: providerSecret};
    circular.self = circular;
    for (const value of [circular, 1n, undefined, {text: NaN}, new Error(trialSecret)]) {
      await rejection(new TraceJournal({directory, secrets}).record(randomUUID(), 'failure', value, {trialId: 'trial'}));
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects a symlink trace directory and leaves its target untouched', async ({skip}) => {
    const {root} = await workspace();
    const target = join(root, 'target');
    await mkdir(target);
    const directory = join(root, 'traces');
    if (!await trySymlink(target, directory, true)) { skip(); return; }
    await rejection(new TraceJournal({directory}).record(randomUUID(), 'request', {}, {trialId: 'trial'}));
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects symlinks in ancestors of the trace path', async ({skip}) => {
    const {root} = await workspace();
    const target = join(root, 'target');
    await mkdir(target);
    const parent = join(root, 'linked-parent');
    if (!await trySymlink(target, parent, true)) { skip(); return; }
    await rejection(new TraceJournal({directory: join(parent, 'traces')}).record(randomUUID(), 'request', {}, {trialId: 'trial'}));
    expect(await readdir(target)).toEqual([]);
  });

  for (const dangling of [false, true]) it(`rejects ${dangling ? 'dangling' : 'existing'} symlink record files`, async ({skip}) => {
    const {root, directory} = await workspace();
    await mkdir(directory, {recursive: true});
    const target = join(root, 'outside.json');
    if (!dangling) await writeFile(target, 'sentinel');
    const attemptId = randomUUID();
    const path = join(directory, `${attemptId}.request.json`);
    if (!await trySymlink(target, path)) { skip(); return; }
    await rejection(new TraceJournal({directory}).record(attemptId, 'request', {}, {trialId: 'trial'}));
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    if (dangling) await expect(lstat(target)).rejects.toMatchObject({code: 'ENOENT'});
    else expect(await readFile(target, 'utf8')).toBe('sentinel');
  });

  it('returns safe filesystem failures and does not damage existing files', async () => {
    const {root} = await workspace();
    const parent = join(root, providerSecret);
    await writeFile(parent, 'sentinel');
    await rejection(new TraceJournal({directory: join(parent, 'traces')}).record(randomUUID(), 'request', {}, {trialId: 'trial'}));
    expect(await readFile(parent, 'utf8')).toBe('sentinel');
  });

  it.skipIf(process.platform === 'win32')('creates private parents and records and tightens an existing trace directory', async () => {
    const {root, directory} = await workspace();
    const attemptId = randomUUID();
    const journal = new TraceJournal({directory});
    await journal.record(attemptId, 'request', {}, {trialId: 'trial'});
    expect((await lstat(join(root, 'private'))).mode & 0o777).toBe(0o700);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, `${attemptId}.request.json`))).mode & 0o777).toBe(0o600);
    await chmod(directory, 0o755);
    await journal.record(randomUUID(), 'request', {}, {trialId: 'trial'});
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  });
});
