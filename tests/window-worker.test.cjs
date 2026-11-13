const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const AlphaAssets=require('../asset-readiness.js');
const AlphaTrade=require('../trade-core.js'),AlphaWindow=require('../window-binding.js');
function fixture(){
 const local={},session={},tabs=[],events={},out=[],sent=[];let next=1,saveHook=async()=>{};
 const event=()=>{const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:(...args)=>{for(const f of listeners)f(...args)}}};
 const chrome={runtime:{id:'aaa',getURL:p=>'chrome-extension://aaa/'+p,onMessage:{addListener:f=>events.message=f},onInstalled:event(),onStartup:event(),sendMessage:()=>Promise.resolve()},
 storage:{local:{get:async()=>local,set:async x=>{await saveHook(x);Object.assign(local,x)},remove:async k=>delete local[k]},session:{get:async()=>session,set:async x=>Object.assign(session,x)}},
 tabs:{query:async q=>tabs.filter(t=>(q.windowId===undefined || t.windowId===q.windowId)&&(!q.url || t.url.startsWith('https://www.binance.com/'))),get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t},create:async data=>{const t={id:next++,status:'complete',...data};tabs.push(t);return t},update:async(id,x)=>Object.assign(tabs.find(t=>t.id===id),x),remove:async id=>{const i=tabs.findIndex(t=>t.id===id);if(i>=0)tabs.splice(i,1)},onUpdated:event(),onRemoved:event(),reload:async()=>{throw Error('reload should not be reached')},sendMessage:async(id,m)=>{sent.push({id,m});return m.action==='activatePage'?{protocol:3,authorized:true}:{healthy:true,canTrade:true,url:tabs.find(t=>t.id===id).url}}},
 webRequest:{onBeforeSendHeaders:event()},alarms:{create(){},onAlarm:event()},notifications:{create(){}}};
 class WebSocket{static OPEN=1;static CONNECTING=0;static CLOSED=3;static CLOSING=2;constructor(url){this.url=url;this.readyState=0;}close(){}}
 const ctx=vm.createContext({chrome,AlphaTrade,AlphaWindow,AlphaAssets,WebSocket,URL,crypto:require('node:crypto').webcrypto,console:{log(){},warn(){},error(){}},importScripts(){},WS_CONFIG:{load:async()=>local,buildUrl:n=>'wss://example.test/'+n},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},out});
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
const coin={chainName:'bsc',address:'0x5dbde81fce337ff4bcaaee4ca3466c00aecae274'};
async function boundFixture(){const f=fixture();await f.message({action:'bindWindow',windowId:1});f.tabs.push({id:90,windowId:1,url:'https://www.binance.com/en/alpha/'+coin.chainName+'/'+coin.address,status:'complete'});return f;}
test('refresh checks readiness without requestId and replies exactly isready',async()=>{const f=await boundFixture();await f.ctx.handleWebSocketMessage({type:'refresh',data:coin});assert.deepEqual(structuredClone(f.out),[{type:'isready'}]);});
test('refresh sends no positive reply when busy, malformed, or page unhealthy',async()=>{
 const f=await boundFixture();vm.runInContext('acceptingOrders=1;',f.ctx);await f.ctx.handleWebSocketMessage({type:'refresh',data:coin});vm.runInContext('acceptingOrders=0;',f.ctx);
 await f.ctx.handleWebSocketMessage({type:'refresh',data:{...coin,address:'../bad'}});
 f.ctx.chrome.tabs.sendMessage=async(_,m)=>m.action==='activatePage'?{protocol:3,authorized:true}:{healthy:false,canTrade:false,url:f.tabs.at(-1).url};
 await f.ctx.handleWebSocketMessage({type:'refresh',data:coin});assert.equal(f.out.length,0);
});
test('ready reloads only bound coin and sends no explicit WebSocket response',async()=>{
 const f=await boundFixture(),reloaded=[];
 f.ctx.chrome.tabs.reload=async id=>{reloaded.push(id);f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.deepEqual(reloaded,[90]);assert.equal(f.out.length,0);
});
test('ready never reloads during an order and never sends a special error response',async()=>{const f=await boundFixture();vm.runInContext('acceptingOrders=1;',f.ctx);await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.equal(f.out.length,0);assert.equal(f.sent.length,0);});
test('post-refresh asset event still uploads over HTTP without WebSocket acknowledgement',async()=>{
 const f=await boundFixture(),uploads=[];f.local.browserNumber='23';
 f.ctx.fetch=async(url,options)=>{uploads.push({url,body:JSON.parse(options.body)});return {ok:true,status:200,text:async()=>''}};
 f.ctx.chrome.tabs.reload=async id=>f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});
 await f.message({action:'alphaAssetsData',token:f.session.windowBinding.token,data:{url:'https://www.binance.com/bapi/defi/v1/private/wallet-direct/cloud-wallet/alpha',data:{code:'000000',data:{list:[],totalValuation:'0'}}}},{tab:{id:90},frameId:0,url:f.tabs.at(-1).url});
 assert.equal(uploads.length,1);assert.equal(uploads[0].body.name,'23');assert.equal(f.out.length,0);
});
test('check started on an old socket cannot send isready on a replacement connection',async()=>{
 const f=await boundFixture();let release;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{if(m.action==='checkReady')await new Promise(r=>release=r);return original(id,m)};
 const checking=f.ctx.handleWebSocketMessage({type:'refresh',data:coin});await new Promise(r=>setImmediate(r));
 vm.runInContext('ws={readyState:1,send:m=>out.push(JSON.parse(m))};',f.ctx);release();await checking;assert.equal(f.out.length,0);
});
const wallet=free=>({code:'000000',data:{list:[{chainId:'56',contractAddress:coin.address,free,freeze:'0',amount:free}]}});
async function observe(f,free){f.ctx.wallet=wallet(free);await vm.runInContext('assetReadiness.observe(wallet)',f.ctx);}
function successfulTrades(f,wait=async()=>{}){const original=f.ctx.chrome.tabs.sendMessage;f.ctx.chrome.tabs.sendMessage=async(id,m)=>{if(m.action==='executeTrade'){await wait();return {protocol:3,data:{unionId:m.data.unionId,bnResp:1,orderData:{code:'000000'}}}}return original(id,m)};}
const trade=id=>({...coin,unionId:id,amt:'1',price:'1',symbol:'AAA'});
test('successful order plus asset change automatically pushes one isready after orderResult',async()=>{
 const f=await boundFixture();successfulTrades(f);await observe(f,'1');await f.ctx.enqueueOrder(trade('a'));assert.equal(f.out.filter(m=>m.type==='isready').length,0);
 await observe(f,'2');assert.deepEqual(f.out.map(m=>m.type),['orderResult','isready']);await observe(f,'3');assert.equal(f.out.length,2);
});
test('asset update arriving before order response is announced only after queue drains',async()=>{
 const f=await boundFixture();let release;successfulTrades(f,()=>new Promise(r=>release=r));await observe(f,'1');
 const order=f.ctx.enqueueOrder(trade('a'));await new Promise(r=>setImmediate(r));await observe(f,'2');assert.equal(f.out.length,0);release();await order;await new Promise(r=>setImmediate(r));assert.deepEqual(f.out.map(m=>m.type),['orderResult','isready']);
});
test('failed order and replayed success do not create new ready notifications',async()=>{
 const f=await boundFixture();successfulTrades(f);await observe(f,'1');await f.ctx.enqueueOrder(trade('a'));await observe(f,'2');await f.ctx.enqueueOrder(trade('a'));await observe(f,'3');assert.equal(f.out.filter(m=>m.type==='isready').length,1);
 f.ctx.chrome.tabs.sendMessage=async(_,m)=>m.action==='activatePage'?{protocol:3,authorized:true}:{protocol:3,data:{unionId:m.data.unionId,bnResp:1,orderData:{code:'REJECTED'}}};await f.ctx.enqueueOrder(trade('b'));await observe(f,'4');assert.equal(f.out.filter(m=>m.type==='isready').length,1);
});
test('post-trade automatic readiness fails closed after socket or binding changes',async()=>{
 const f=await boundFixture();successfulTrades(f);await observe(f,'1');await f.ctx.enqueueOrder(trade('a'));vm.runInContext('ws={readyState:1,send:m=>out.push(JSON.parse(m))};',f.ctx);await observe(f,'2');assert.equal(f.out.filter(m=>m.type==='isready').length,0);
});
test('asset change during maintenance triggers automatic recheck when refresh releases its lock',async()=>{
 const f=await boundFixture();successfulTrades(f);await observe(f,'1');await f.ctx.enqueueOrder(trade('a'));
 f.ctx.chrome.tabs.reload=async id=>{await observe(f,'2');assert.equal(f.out.filter(m=>m.type==='isready').length,0);f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});await new Promise(r=>setImmediate(r));assert.equal(f.out.filter(m=>m.type==='isready').length,1);
});
