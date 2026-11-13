import {describe,it,expect,afterEach} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStore} from '../src/store/sqlite.js';
const dirs:string[]=[]; const stores:SqliteStore[]=[];
function open(){const dir=mkdtempSync(join(tmpdir(),'ernie-store-'));dirs.push(dir);const store=new SqliteStore(join(dir,'state.db'));stores.push(store);return {store,dir};}
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('durable store',()=>{
 it('persists goals, event cursors, messages and uncertain intents across restart',()=>{const {store,dir}=open();const g=store.createGoal({workspace:dir,prompt:'fix bug'});store.appendMessage(g.id,{role:'user',content:'fix bug'});const intent=store.beginTool(g.id,1,'write_file',{path:'a',content:'b'});const event=store.appendEvent(g.id,'test',{safe:true});store.close();const reopened=new SqliteStore(join(dir,'state.db'));stores.push(reopened);expect(reopened.getGoal(g.id)?.revision).toBe(1);expect(reopened.getMessages(g.id)).toHaveLength(1);expect(reopened.pendingTools(g.id)[0].id).toBe(intent.id);expect(reopened.events(event.seq-1)[0].seq).toBe(event.seq);});
 it('does not lose cumulative budget when changing status',()=>{const {store,dir}=open();const g=store.createGoal({workspace:dir,prompt:'x'});store.updateGoal(g.id,{usage:{calls:7,inputTokens:100,outputTokens:23,reasoningTokens:8,activeMs:15},status:'paused'});store.updateGoal(g.id,{status:'pending'});expect(store.getGoal(g.id)?.usage.calls).toBe(7);});
 it('finishes tool intents and rejects invalid budget',()=>{const {store,dir}=open();expect(()=>store.createGoal({workspace:dir,prompt:'x',budget:{maxCalls:-1}})).toThrow();const g=store.createGoal({workspace:dir,prompt:'x'});const t=store.beginTool(g.id,1,'read_file',{path:'a'});store.finishTool(t.id,{ok:true,output:'a'});expect(store.pendingTools(g.id)).toEqual([]);});
});
