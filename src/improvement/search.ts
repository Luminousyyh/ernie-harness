import {MODULES, type ImprovementModule, type Selection} from './types.js';
export interface BanditState {version:1;a:number[][];b:number[];observations:number}
export const featureVector=(selected:readonly ImprovementModule[]):number[]=>{const bits=MODULES.map(m=>selected.includes(m)?1:0),x=[1,...bits];for(let i=0;i<bits.length;i++)for(let j=i+1;j<bits.length;j++)x.push(bits[i]*bits[j]);return x;};
function solve(a:number[][],b:number[]):number[]{const n=b.length,m=a.map((r,i)=>[...r,b[i]]);for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(m[r][c])>Math.abs(m[p][c]))p=r;[m[c],m[p]]=[m[p],m[c]];if(Math.abs(m[c][c])<1e-12)throw new Error('Singular covariance');const d=m[c][c];for(let j=c;j<=n;j++)m[c][j]/=d;for(let i=0;i<n;i++)if(i!==c){const f=m[i][c];for(let j=c;j<=n;j++)m[i][j]-=f*m[c][j];}}return m.map(r=>r[n]);}
export class FullCovarianceLinUCB {
 private s:BanditState;
 constructor(readonly dimensions=16,state?:BanditState,readonly alpha=1){
  if(!Number.isInteger(dimensions)||dimensions<1||dimensions>64||!Number.isFinite(alpha)||alpha<0)throw new Error('Invalid LinUCB parameters');
  this.s=state?structuredClone(state):{version:1,a:Array.from({length:dimensions},(_,i)=>Array.from({length:dimensions},(_,j)=>Number(i===j))),b:Array(dimensions).fill(0),observations:0};
  if(this.s.version!==1||this.s.a.length!==dimensions||this.s.b.length!==dimensions||this.s.a.some((r,i)=>r.length!==dimensions||r.some((v,j)=>!Number.isFinite(v)||Math.abs(v-this.s.a[j]?.[i])>1e-9))||this.s.b.some(v=>!Number.isFinite(v)))throw new Error('Invalid bandit state');
  if(!Number.isSafeInteger(this.s.observations)||this.s.observations<0)throw new Error('Invalid bandit observations');
  const cholesky=Array.from({length:dimensions},()=>Array(dimensions).fill(0));
  for(let i=0;i<dimensions;i++)for(let j=0;j<=i;j++){
   let v=this.s.a[i][j];for(let k=0;k<j;k++)v-=cholesky[i][k]*cholesky[j][k];
   if(i===j){if(v<=0)throw new Error('Covariance must be positive definite');cholesky[i][j]=Math.sqrt(v);}else cholesky[i][j]=v/cholesky[j][j];
  }
  solve(this.s.a,this.s.b);
 }
 private check(x:number[]){if(x.length!==this.dimensions||x.some(v=>!Number.isFinite(v)))throw new Error('Invalid bandit features');}
 ucb(x:number[]):number{this.check(x);const theta=solve(this.s.a,this.s.b),inverseX=solve(this.s.a,x);return x.reduce((s,v,i)=>s+v*theta[i],0)+this.alpha*Math.sqrt(Math.max(0,x.reduce((s,v,i)=>s+v*inverseX[i],0)));}
 update(x:number[],reward:number):void{this.check(x);if(!Number.isFinite(reward)||Math.abs(reward)>10)throw new Error('Invalid bandit reward');for(let i=0;i<x.length;i++){this.s.b[i]+=reward*x[i];for(let j=0;j<x.length;j++)this.s.a[i][j]+=x[i]*x[j];}this.s.observations++;}
 state():BanditState{return structuredClone(this.s);}
}
const canonical=(m:readonly ImprovementModule[]):ImprovementModule[]=>MODULES.filter(x=>m.includes(x));
export function selectModules(selection:Selection,bandit:FullCovarianceLinUCB,previous:readonly ImprovementModule[][]):ImprovementModule[]{
 const used=new Set(previous.map(x=>canonical(x).join(',')));
 if(selection.mode==='fixed'){if(!selection.modules.length||new Set(selection.modules).size!==selection.modules.length||selection.modules.some(m=>!MODULES.includes(m)))throw new Error('Invalid fixed module selection');return canonical(selection.modules);}
 if(selection.mode!=='search'||selection.start?.some(m=>!MODULES.includes(m)))throw new Error('Invalid module search');
 // Coordinate ascent from each singleton and the incumbent. Full covariance includes pair interactions.
 const optima:ImprovementModule[][]=[];
 for(const seed of [canonical(selection.start??[]),...MODULES.map(m=>[m])]){
  let current=seed.length?seed:[MODULES[0]];for(let step=0;step<32;step++){
   const neighbors=MODULES.map(m=>canonical(current.includes(m)?current.filter(x=>x!==m):[...current,m])).filter(x=>x.length);
   const best=neighbors.sort((a,b)=>bandit.ucb(featureVector(b))-bandit.ucb(featureVector(a))||a.join(',').localeCompare(b.join(',')))[0];
   if(!best||bandit.ucb(featureVector(best))<=bandit.ucb(featureVector(current))+1e-10)break;current=best;
  }optima.push(current);
 }
 // A used local optimum falls back to its coordinate neighbors, then remaining combinations.
 let available=optima.filter(x=>!used.has(x.join(',')));
 if(!available.length)available=optima.flatMap(current=>MODULES.map(m=>canonical(current.includes(m)?current.filter(x=>x!==m):[...current,m]))).filter(x=>x.length&&!used.has(x.join(',')));
 if(!available.length)for(let mask=1;mask<1<<MODULES.length;mask++){const combination=MODULES.filter((_,i)=>mask&(1<<i));if(!used.has(combination.join(',')))available.push(combination);}
 available.sort((a,b)=>bandit.ucb(featureVector(b))-bandit.ucb(featureVector(a))||a.join(',').localeCompare(b.join(',')));
 if(!available.length)throw new Error('Module search exhausted');return available[0];
}
