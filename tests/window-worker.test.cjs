const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const AlphaTrade=require('../trade-core.js'),AlphaWindow=require('../window-binding.js');
function fixture(){
 const local={},session={},tabs=[],events={},out=[],sent=[];let next=1,saveHook=async()=>{};
 const event=()=>({addListener:f=>{},removeListener:f=>{}});
 const chrome={runtime:{id:'aaa',getURL:p=>'chrome-extension://aaa/'+p,onMessage:{addListener:f=>events.message=f},onInstalled:event(),onStartup:event(),sendMessage:()=>Promise.resolve()},
 storage:{local:{get:async()=>local,set:async x=>{await saveHook(x);Object.assign(local,x)},remove:async k=>delete local[k]},session:{get:async()=>session,set:async x=>Object.assign(session,x)}},
 tabs:{query:async q=>tabs.filter(t=>(q.windowId===undefined || t.windowId===q.windowId)&&(!q.url || t.url.startsWith('https://www.binance.com/'))),get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t},create:async data=>{const t={id:next++,status:'complete',...data};tabs.push(t);return t},update:async(id,x)=>Object.assign(tabs.find(t=>t.id===id),x),remove:async id=>{const i=tabs.findIndex(t=>t.id===id);if(i>=0)tabs.splice(i,1)},onUpdated:event(),onRemoved:event(),reload:async()=>{throw Error('reload should not be reached')},sendMessage:async(id,m)=>{sent.push({id,m});return m.action==='activatePage'?{protocol:3,authorized:true}:{healthy:true,canTrade:true,url:tabs.find(t=>t.id===id).url}}},
 webRequest:{onBeforeSendHeaders:event()},alarms:{create(){},onAlarm:event()},notifications:{create(){}}};
 class WebSocket{static OPEN=1;static CONNECTING=0;static CLOSED=3;static CLOSING=2;constructor(url){this.url=url;this.readyState=0;}close(){}}
 const ctx=vm.createContext({chrome,AlphaTrade,AlphaWindow,WebSocket,URL,crypto:require('node:crypto').webcrypto,console:{log(){},warn(){},error(){}},importScripts(){},WS_CONFIG:{load:async()=>local,buildUrl:n=>'wss://example.test/'+n},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},out});
 vm.runInContext(fs.readFileSync('background.js','utf8'),ctx);
 vm.runInContext('ws={readyState:1,send:m=>out.push(JSON.parse(m)),close(){}};',ctx);
 const message=(request,sender={url:'chrome-extension://aaa/popup.html'})=>new Promise(resolve=>events.message(request,sender,resolve));
 return {ctx,tabs,local,session,out,sent,message,hook:f=>saveHook=f};
}
test('server check targets bound window and never discovers same coin in foreign window',async()=>{
 const f=fixture();await f.message({action:'bindWindow',windowId:1});
 f.tabs.push({id:90,windowId:2,url:'https://www.binance.com/en/alpha/bsc/0xaaa',status:'complete'});
 const result=await f.ctx.handlePageCommand({type:'checkTradeReady',data:{requestId:'r',chainName:'bsc',address:'0xaaa'}});
 assert.equal(result.canTrade,false);assert.equal(f.sent.length,0);
 f.tabs.push({id:91,windowId:1,url:'https://www.binance.com/en/alpha/bsc/0xaaa',status:'complete'});
 const ready=await f.ctx.handlePageCommand({type:'checkTradeReady',data:{requestId:'s',chainName:'bsc',address:'0xaaa'}});
 assert.equal(ready.healthy,true);assert(f.sent.every(x=>x.id===91));
});
test('foreign-window page cannot obtain authority or upload assets',async()=>{
 const f=fixture();await f.message({action:'bindWindow',windowId:1});f.tabs.push({id:90,windowId:2,url:'https://www.binance.com/en/alpha/bsc/0xaaa'});
 const sender={tab:{id:90},frameId:0,url:f.tabs.at(-1).url};
 assert.equal((await f.message({action:'authorizePage'},sender)).authorized,false);
 assert((await f.message({action:'alphaHeadersCaptured',data:{headers:{test:'x'}}},sender)).error);assert.equal(f.local.alphaHeaders,undefined);
});
test('changing connection reserves maintenance before storage await; incoming order cannot dispatch',async()=>{
 const f=fixture();await f.message({action:'bindWindow',windowId:1});let release;
 f.hook(async x=>{if(x.browserNumber)await new Promise(r=>release=r)});
 const change=f.message({action:'connectWS',number:'232'});await new Promise(r=>setImmediate(r));
 await f.ctx.enqueueOrder({chainName:'bsc',address:'0xaaa',unionId:'o',amt:'1',price:'1',symbol:'AAA'});
 assert.equal(f.sent.length,0);assert.equal(f.out.at(-1).data.orderData.code,'INVALID_ORDER');
 release();assert.equal((await change).success,true);
});
test('refresh command refuses while order acceptance is awaiting binding',async()=>{
 const f=fixture();await f.message({action:'bindWindow',windowId:1});
 vm.runInContext('acceptingOrders=1;',f.ctx);
 const r=await f.ctx.handlePageCommand({type:'refreshTradePage',data:{requestId:'r',chainName:'bsc',address:'0xaaa'}});
 assert.match(r.error,/BUSY/);assert.equal(r.refreshed,undefined);
});
