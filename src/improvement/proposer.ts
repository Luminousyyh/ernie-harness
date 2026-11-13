import type {SourceSnapshot} from './archive.js';
export interface ProposerStrategy {schemaVersion:1;maxFiles:number;maxTraceChars:number;reflection:boolean;sourceOrder:'failures-first'|'path';instructions:string}
const DEFAULT:ProposerStrategy={schemaVersion:1,maxFiles:6,maxTraceChars:24000,reflection:true,sourceOrder:'failures-first',instructions:'Use development evidence to implement a small concrete improvement; preserve verification.'};
export function readProposerStrategy(snapshot:SourceSnapshot):ProposerStrategy {
 const text=snapshot.files['src/improvement/proposer-strategy.json'];if(!text)return{...DEFAULT};return validateProposerStrategy(JSON.parse(text.replace(/^\uFEFF/,'')));
}
export function validateProposerStrategy(raw:unknown):ProposerStrategy {
 const s=raw as ProposerStrategy;if(!s||s.schemaVersion!==1||!Number.isInteger(s.maxFiles)||s.maxFiles<1||s.maxFiles>6||!Number.isInteger(s.maxTraceChars)||s.maxTraceChars<0||s.maxTraceChars>48000||typeof s.reflection!=='boolean'||!['failures-first','path'].includes(s.sourceOrder)||typeof s.instructions!=='string'||s.instructions.length>12000)throw new Error('Invalid proposer strategy version or bounds');return s;
}
