import {useState} from 'react';
// Drafts live in memory; changing pages or workspaces never discards unsent text.
export function useDraft<T>(key: string, initial: T): [T, (next: T) => void] {
  const [drafts, setDrafts] = useState<Record<string, T>>({});
  return [drafts[key] ?? initial, next => setDrafts(current => ({...current, [key]: next}))];
}
