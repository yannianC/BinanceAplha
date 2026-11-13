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

test('each server dispatch executes serially including repeated IDs',async()=>{
 let release,calls=0;const f=fixture(async t=>{calls++;if(calls===1)await new Promise(r=>release=r);return ok(t.unionId)});
 const a=f.q.submit(order('a'));await new Promise(r=>setImmediate(r));const b=f.q.submit(order('a'));assert.equal(calls,1);release();await Promise.all([a,b]);await f.q.submit({...order('a'),price:'9'});assert.equal(calls,3);assert.equal(f.reports.length,3);
});
test('unknown, rejected and malformed results never block subsequent server retries',async()=>{
 let calls=0;const f=fixture(async t=>{calls++;if(calls===1)throw Error('lost');if(calls===2)return {unionId:t.unionId,bnResp:1,orderData:{code:'REJECTED'}};if(calls===3)return {};return ok(t.unionId)});
 for(let i=0;i<4;i++)await f.q.submit(order('a'));
 assert.equal(calls,4);assert.equal(f.reports[0].orderData.code,'ORDER_STATUS_UNKNOWN');assert.equal(f.reports.at(-1).orderData.code,'000000');assert.equal((await f.q.status()).blocked,false);
});
test('legacy blocked/running journal never auto-replays but accepts explicit server retry',async()=>{
 let calls=0;const f=fixture(async t=>{calls++;return ok(t.unionId)},{entries:{a:{status:'running',trade:order('a')}},blocked:true});await f.q.ready;assert.equal(calls,0);await f.q.submit(order('a'));assert.equal(calls,1);assert.equal(f.state().blocked,false);
});
test('journal storage failure cannot swallow order outcome or pause later orders',async()=>{
 let calls=0;const reports=[];const q=new TradeQueue({load:async()=>{throw Error('disk')},save:async()=>{throw Error('disk')},execute:async t=>{calls++;return ok(t.unionId)},report:r=>reports.push(r)});
 await q.submit(order('a'));await q.submit(order('b'));assert.equal(calls,2);assert.equal(reports.length,2);
});
test('journal retention rotates without refusing new commands',async()=>{
 const entries=Object.fromEntries(Array.from({length:5000},(_,i)=>[String(i),{trade:order(String(i)),status:'done',result:ok(String(i))}]));let calls=0;
 const f=fixture(async t=>{calls++;return ok(t.unionId)},{entries});await f.q.submit(order('new'));assert.equal(calls,1);assert(Object.keys(f.state().entries).length<=5000);
});
test('queue capacity rejection does not blacklist the rejected ID',async()=>{
 let release,calls=0;const f=fixture(async t=>{calls++;if(calls===1)await new Promise(r=>release=r);return ok(t.unionId)});
 const jobs=Array.from({length:101},(_,i)=>f.q.submit(order(String(i))));await new Promise(r=>setImmediate(r));assert.equal(f.reports[0].orderData.code,'QUEUE_FULL');release();await Promise.all(jobs);await f.q.submit(order('100'));assert.equal(calls,101);assert.equal(f.reports.at(-1).orderData.code,'000000');
});
