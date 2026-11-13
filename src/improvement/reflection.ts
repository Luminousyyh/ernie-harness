import type {ChatMessage} from '../contracts/index.js';
/** Both proposer diagnostics and actual candidate task requests consume this editable module. */
export function reflectTranscript(messages:readonly ChatMessage[]):string {
 const tools=messages.filter(m=>m.role==='tool');const failures=tools.filter(m=>/"ok"\s*:\s*false|error|failed/i.test(m.content??''));
 return failures.length?`Recent tool evidence includes ${failures.length} failures. Inspect the latest evidence and change the approach before repeating an operation.`:'';
}
export function developmentReflection(traces:readonly unknown[],outcomes:readonly {resolved:number;inputTokens:number;calls:number}[]):string {
 return JSON.stringify({traceCount:traces.length,developmentOutcomes:outcomes,instruction:'Form a concrete hypothesis from development failures, edit the smallest useful module combination, and preserve verification.'});
}
