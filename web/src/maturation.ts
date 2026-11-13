import {record} from './state.js';
export type DataRow = Record<string, unknown>;
export function listRows(value: unknown, ...keys: string[]): DataRow[] {
  if(Array.isArray(value))return value.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)).map(record);
  const data=record(value);for(const key of [...keys,'items'])if(Array.isArray(data[key]))return listRows(data[key]);return [];
}
export function jobFrom(value: unknown): DataRow {const data=record(value);return record(data.job??data.improvement??data);}
export function activeCandidateId(value: unknown): string | undefined {const data=record(value);const active=record(data.activation??data.active);return typeof active.candidateId==='string' ? active.candidateId : undefined;}
export function canApplyCandidate(value: unknown): boolean {const candidate=record(value);return candidate.status==='eligible'&&candidate.buildPassed===true&&record(candidate.isolation).verified===true&&!!candidate.score&&!!candidate.parentScore&&!!candidate.validation&&!!candidate.parentValidation;}
export function text(value: unknown, fallback=''): string {return typeof value==='string'?value:typeof value==='number'?String(value):fallback;}
export function statusTone(status: unknown): string {return ['active','applied','eligible','succeeded','completed','allow'].includes(String(status))?'success':['failed','rejected','deny','needs-reconciliation'].includes(String(status))?'danger':['cancelled','archived','retired','rolled-back'].includes(String(status))?'neutral':'pending';}
