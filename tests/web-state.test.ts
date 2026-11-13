import { describe, expect, it } from 'vitest';
import type { ChatMessage, HarnessEvent } from '../src/contracts/index.js';
import { emptyThread, applyEvent, hydrateThread, parseAcceptance, safeHref, parseAuthFragment } from '../web/src/state.ts';

const event = (seq: number, goalId: string, type: string, data: unknown): HarnessEvent => ({seq, goalId, type, data, createdAt: '2026-11-12T00:00:00.000Z'});

describe('web conversation event reconciliation', () => {
  it('isolates goals and ignores replayed event ids', () => {
    let thread = emptyThread('a');
    thread = applyEvent(thread, event(1, 'b', 'model.delta', {type: 'text', text: 'other'}));
    expect(thread.draft).toBe('');
    const delta = event(2, 'a', 'model.delta', {type: 'text', text: 'hello'});
    thread = applyEvent(applyEvent(thread, delta), delta);
    expect(thread.draft).toBe('hello');
    expect(thread.events).toHaveLength(1);
  });
  it('replaces chunks with the persisted assistant message', () => {
    let thread = applyEvent(emptyThread('a'), event(1, 'a', 'model.delta', {type: 'text', text: 'hello'}));
    thread = applyEvent(thread, event(2, 'a', 'message', {role: 'assistant', content: 'hello'}));
    expect(thread.draft).toBe('');
    expect(thread.messages).toEqual([{role: 'assistant', content: 'hello'}]);
    expect(applyEvent(thread, event(2, 'a', 'message', {role: 'assistant', content: 'hello'})).messages).toHaveLength(1);
  });
  it('does not treat reasoning or tool argument deltas as assistant text', () => {
    let thread = applyEvent(emptyThread('a'), event(1, 'a', 'model.delta', {type: 'reasoning', text: 'thinking'}));
    thread = applyEvent(thread, event(2, 'a', 'model.delta', {type: 'tool', text: '{"path":'}));
    expect(thread.draft).toBe('');
    expect(thread.reasoning).toBe('thinking');
  });
  it('merges events received while the initial snapshot request was in flight', () => {
    let live = applyEvent(emptyThread('a'), event(8, 'a', 'model.delta', {type: 'text', text: 'B'}));
    const snapshot = {messages: [{role: 'user', content: 'task'}] as ChatMessage[], events: [event(7, 'a', 'model.delta', {type: 'text', text: 'A'})]};
    live = hydrateThread('a', snapshot, live);
    expect(live.draft).toBe('AB');
    expect(live.messages).toHaveLength(1);
    expect(live.lastSeq).toBe(8);
  });
  it('does not replay persisted messages from a historical snapshot', () => {
    const final = {role: 'assistant', content: 'done'} as ChatMessage;
    const events = [event(1, 'a', 'model.delta', {type: 'text', text: 'done'}), event(2, 'a', 'message', final)];
    const thread = hydrateThread('a', {messages: [final], events}, emptyThread('a'));
    expect(thread.messages).toEqual([final]);
    expect(thread.draft).toBe('');
  });
  it('uses the detail cursor above a 5000-event tail before replaying buffered SSE', () => {
    const assistant = {role: 'assistant', content: 'completed turn at 6000'} as ChatMessage;
    const followup = {role: 'user', content: 'persisted through cursor 6001'} as ChatMessage;
    const next = {role: 'assistant', content: 'new reply after the snapshot'} as ChatMessage;
    const tail = Array.from({length: 5000}, (_, index) => event(index + 1001, 'a', 'heartbeat', {}));
    tail[4997] = event(5998, 'a', 'plan.updated', {steps: [{id: 'latest', title: 'latest plan'}]});
    tail[4998] = event(5999, 'a', 'tool.completed', {name: 'read_file', result: 'latest tool'});
    tail[4999] = event(6000, 'a', 'message', assistant);
    let live = applyEvent(emptyThread('a'), event(6000, 'a', 'message', assistant));
    live = applyEvent(live, event(6001, 'a', 'message', followup));
    live = applyEvent(live, event(6002, 'a', 'message', next));
    const thread = hydrateThread('a', {messages: [assistant, followup], events: tail, eventCursor: 6001}, live);
    expect(thread.messages).toEqual([assistant, followup, next]);
    expect(thread.lastSeq).toBe(6002);
    expect(thread.events.filter(item => item.seq === 6001)).toHaveLength(0);
    expect(thread.events.find(item => item.seq === 5998)?.type).toBe('plan.updated');
    expect(thread.events.find(item => item.seq === 5999)?.type).toBe('tool.completed');
    expect(thread.events.at(-1)?.seq).toBe(6002);
  });
  it('does not duplicate full message history even if a bounded event window ends before that history', () => {
    const assistant = {role: 'assistant', content: 'already persisted at 6000'} as ChatMessage;
    const snapshot = {messages: [assistant], events: [event(5000, 'a', 'heartbeat', {})], eventCursor: 6001};
    const live = applyEvent(emptyThread('a'), event(6000, 'a', 'message', assistant));
    const thread = hydrateThread('a', snapshot, live);
    expect(thread.messages).toEqual([assistant]);
    expect(thread.lastSeq).toBe(6001);
    expect(applyEvent(thread, event(6001, 'a', 'message', assistant))).toBe(thread);
    expect(applyEvent(thread, event(6002, 'a', 'message', {role: 'assistant', content: 'new'})).messages).toHaveLength(2);
  });
  it('keeps the parsed event watermark when an optional cursor is older', () => {
    const thread = hydrateThread('a', {messages: [], events: [event(10, 'a', 'heartbeat', {})], eventCursor: 8});
    expect(thread.lastSeq).toBe(10);
  });
  it('preserves identical messages from genuinely distinct turns', () => {
    const final = {role: 'assistant', content: 'okay'};
    let thread = applyEvent(emptyThread('a'), event(1, 'a', 'message', final));
    thread = applyEvent(thread, event(2, 'a', 'message', final));
    expect(thread.messages).toHaveLength(2);
  });
});

describe('web input boundaries', () => {
  it('normalizes acceptance lines without altering command contents', () => {
    expect(parseAcceptance(' pnpm test \r\n\n echo "a;b"\n')).toEqual(['pnpm test', 'echo "a;b"']);
  });
  it('allows explicit safe web links and rejects active content', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    for (const href of ['javascript:alert(1)', 'data:text/html,test', '//evil.test', '/api/goals', 'jav\nascript:alert(1)']) expect(safeHref(href)).toBeUndefined();
  });
  it('reads only the launcher service token from the fragment', () => {
    expect(parseAuthFragment('#token=a%2Bb')).toBe('a+b');
    expect(parseAuthFragment('#section')).toBeUndefined();
    expect(parseAuthFragment('#token=')).toBeUndefined();
  });
});
