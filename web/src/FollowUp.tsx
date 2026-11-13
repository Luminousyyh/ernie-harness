import {ArrowUp} from 'lucide-react';
import type {Harness} from './useHarness.js';
import {continuationBlock} from './workspaces.js';
export function FollowUp({harness}: {harness: Harness}) {
  const goal = harness.goal;
  const content = harness.conversationDrafts[goal?.id ?? ''] ?? '';
  const setContent = (text: string) => {if (goal) harness.setConversationDrafts(current => ({...current, [goal.id]: text}));};
  if (!goal) return null;
  const reason = continuationBlock(goal.status);
  const blocked = !!reason || !!harness.busy || harness.connection !== 'ready' || !harness.state?.provider.configured;
  return <form className="follow-up" aria-label="继续会话" onSubmit={async event => {event.preventDefault(); if (!blocked && content.trim()) {
    const id = goal.id; const submitted = content;
    if (await harness.continueConversation(id, submitted.trim())) harness.setConversationDrafts(current => current[id] === submitted ? {...current, [id]: ''} : current);
  }}}><label htmlFor="follow-up-message">继续推进这个目标</label><textarea id="follow-up-message" rows={2} value={content} onChange={event => setContent(event.target.value)} placeholder="补充要求、提出问题，或描述下一步…" disabled={!!reason} aria-describedby="continuation-help" onKeyDown={event => {if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault(); event.currentTarget.form?.requestSubmit();}}}/><div><span id="continuation-help">{reason || '沿用会话历史与累计预算 · Ctrl / ⌘ + Enter'}</span><button type="submit" className="primary-button" disabled={blocked || !content.trim()}><ArrowUp size={14}/>{harness.busy === `${goal.id}:message` ? '发送中…' : '发送并继续'}</button></div></form>;
}
