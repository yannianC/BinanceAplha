const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assetKey,TradeQueue}=require('../trade-core.js');
const order=id=>({unionId:id,url:'https://www.binance.com/zh-CN/alpha/bsc/0xabc',price:'1',amount:'2',direction:'Buy',coin:'ABC'});
const ok=id=>({unionId:id,bnResp:1,orderData:{code:'000000'}});
function fixture(execute,initial={}){let state=structuredClone(initial);const reports=[];return {q:new TradeQueue({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s)},execute,report:r=>reports.push(r)}),reports,state:()=>state};}
test('identity ignores locale/query but preserves case-sensitive non-EVM addresses',()=>{
 assert.equal(assetKey('https://www.binance.com/en/alpha/bsc/0xAbC?x=1'),assetKey(order('a').url));
 assert.notEqual(assetKey('https://www.binance.com/en/alpha/solana/AbC'),assetKey('https://www.binance.com/en/alpha/solana/abc'));
 assert.throws(()=>assetKey('https://evil.test/en/alpha/bsc/0xabc'));
});
test('orders execute serially and duplicates replay result without submission',async()=>{
 let release;let calls=[];const f=fixture(async t=>{calls.push(t.unionId);if(t.unionId==='a')await new Promise(r=>release=r);return ok(t.unionId)});
 const a=f.q.submit(order('a'));await new Promise(r=>setImmediate(r));const b=f.q.submit(order('b'));const dup=f.q.submit(order('a'));
 await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['a']);release();await Promise.all([a,b,dup]);assert.deepEqual(calls,['a','b']);
 await f.q.submit(order('a'));assert.deepEqual(calls,['a','b']);assert.equal(f.reports.at(-1).unionId,'a');
});
test('unknown result blocks later orders and remains blocked after restart',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('lost response')});await f.q.submit(order('a'));await f.q.submit(order('b'));assert.equal(calls,1);assert.equal(f.reports[0].orderData.code,'ORDER_STATUS_UNKNOWN');
 const g=fixture(async()=>{calls++},f.state());await g.q.submit(order('c'));assert.equal(calls,1);
});
test('restart never automatically retries an interrupted order',async()=>{
 let calls=0;const f=fixture(async()=>calls++,{entries:{a:{status:'running',trade:order('a')}},blocked:false});await f.q.submit(order('a'));assert.equal(calls,0);assert.equal(f.reports[0].orderData.code,'ORDER_STATUS_UNKNOWN');
});
test('duplicate id with altered payload never executes',async()=>{let calls=0;const f=fixture(async t=>{calls++;return ok(t.unionId)});await f.q.submit(order('a'));await f.q.submit({...order('a'),price:'9'});assert.equal(calls,1);assert.equal(f.reports.at(-1).orderData.code,'DUPLICATE_ID_CONFLICT');});
test('storage failure prevents dispatch',async()=>{let calls=0;const q=new TradeQueue({load:async()=>({}),save:async()=>{throw Error('disk')},execute:async()=>calls++,report:()=>{}});await assert.rejects(q.submit(order('a')));assert.equal(calls,0);});
test('waiting orders expire after 30 seconds and are not retried',async()=>{
 let now=0,release;const calls=[],reports=[];const q=new TradeQueue({now:()=>now,load:async()=>({}),save:async()=>{},report:r=>reports.push(r),execute:async t=>{calls.push(t.unionId);if(t.unionId==='a')await new Promise(r=>release=r);return ok(t.unionId)}});
 const a=q.submit(order('a'));await new Promise(r=>setImmediate(r));const b=q.submit(order('b'));now=31000;release();await Promise.all([a,b]);await q.submit(order('b'));
 assert.deepEqual(calls,['a']);assert.equal(reports.at(-1).orderData.code,'ORDER_EXPIRED');
});
test('queue has bounded capacity',async()=>{
 let release;const reports=[];const q=new TradeQueue({load:async()=>({}),save:async()=>{},report:r=>reports.push(r),execute:async t=>{if(t.unionId==='0')await new Promise(r=>release=r);return ok(t.unionId)}});
 const jobs=[];for(let i=0;i<101;i++)jobs.push(q.submit(order(String(i))));await new Promise(r=>setImmediate(r));assert.equal(reports[0].orderData.code,'QUEUE_FULL');release();await Promise.all(jobs);
});
test('malformed API response pauses instead of releasing next order',async()=>{let calls=0;const f=fixture(async t=>{calls++;return {unionId:t.unionId,bnResp:1,orderData:{}}});await f.q.submit(order('a'));await f.q.submit(order('b'));assert.equal(calls,1);assert.equal(f.state().blocked,true);});
test('duplicate running order at capacity never receives a false not-executed rejection',async()=>{
 let release;const reports=[],calls=[];const q=new TradeQueue({load:async()=>({}),save:async()=>{},report:r=>reports.push(r),execute:async t=>{calls.push(t.unionId);if(t.unionId==='0')await new Promise(r=>release=r);return ok(t.unionId)}});
 const jobs=[];for(let i=0;i<100;i++)jobs.push(q.submit(order(String(i))));await new Promise(r=>setImmediate(r));const duplicate=q.submit(order('0'));await new Promise(r=>setImmediate(r));assert.equal(reports.length,0);release();await Promise.all([...jobs,duplicate]);assert.equal(calls.filter(id=>id==='0').length,1);assert.equal(reports.filter(r=>r.unionId==='0').length,2);assert(reports.filter(r=>r.unionId==='0').every(r=>r.bnResp===1));
});
