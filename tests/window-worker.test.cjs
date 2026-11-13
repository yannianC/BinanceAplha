const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const AlphaAssets=require('../asset-readiness.js');
const AlphaTrade=require('../trade-core.js'),AlphaWindow=require('../window-binding.js');
function fixture(){
 const local={},session={},tabs=[],events={},out=[],sent=[];let next=1,saveHook=async()=>{};
 const event=()=>{const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:(...args)=>{for(const f of listeners)f(...args)}}};
 const chrome={runtime:{id:'aaa',getURL:p=>'chrome-extension://aaa/'+p,onMessage:{addListener:f=>events.message=f},onInstalled:event(),onStartup:event(),sendMessage:()=>Promise.resolve()},
 storage:{local:{get:async()=>local,set:async x=>{await saveHook(x);Object.assign(local,x)},remove:async k=>delete local[k]},session:{get:async()=>session,set:async x=>Object.assign(session,x)}},
 tabs:{query:async q=>tabs.filter(t=>(q.windowId===undefined || t.windowId===q.windowId)&&(!q.url || t.url.startsWith('https://www.binance.com/'))),get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t},create:async data=>{const t={id:next++,status:'complete',...data};tabs.push(t);return t},update:async(id,x)=>Object.assign(tabs.find(t=>t.id===id),x),remove:async id=>{const i=tabs.findIndex(t=>t.id===id);if(i>=0)tabs.splice(i,1)},onUpdated:event(),onRemoved:event(),reload:async()=>{throw Error('reload should not be reached')},sendMessage:async(id,m)=>{sent.push({id,m});return m.action==='activatePage'?{protocol:8,authorized:true}:{healthy:true,canTrade:true,url:tabs.find(t=>t.id===id).url}}},
 webRequest:{onBeforeSendHeaders:event()},alarms:{create(){},onAlarm:event()},notifications:{create(){}}};
 class WebSocket{static OPEN=1;static CONNECTING=0;static CLOSED=3;static CLOSING=2;constructor(url){this.url=url;this.readyState=0;}close(){}}
 const ctx=vm.createContext({chrome,AlphaLocalLog:require('../local-log.js'),AlphaTrade,AlphaWindow,AlphaAssets,WebSocket,URL,crypto:require('node:crypto').webcrypto,console:{log(){},warn(){},error(){}},importScripts(){},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},out});
 vm.runInContext(fs.readFileSync('ws-config.js','utf8'),ctx);
 vm.runInContext(fs.readFileSync('background.js','utf8'),ctx);
 vm.runInContext('ws={readyState:1,send:m=>out.push(JSON.parse(m)),close(){}};',ctx);
 let now=Date.now();ctx.Date=class extends Date {static now(){return now}};ctx.sleep=async ms=>{now+=ms};
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
test('legacy refresh command refuses while order acceptance is awaiting binding',async()=>{
 const f=fixture();await f.message({action:'bindWindow',windowId:1});
 vm.runInContext('acceptingOrders=1;',f.ctx);
 const r=await f.ctx.handlePageCommand({type:'refreshTradePage',data:{requestId:'r',chainName:'bsc',address:'0xaaa'}});
 assert.match(r.error,/BUSY/);assert.equal(r.refreshed,undefined);
});
const coin={chainName:'bsc',address:'0x5dbde81fce337ff4bcaaee4ca3466c00aecae274'};
async function boundFixture(){const f=fixture();await f.message({action:'bindWindow',windowId:1});f.tabs.push({id:90,windowId:1,url:'https://www.binance.com/en/alpha/'+coin.chainName+'/'+coin.address,status:'complete'});return f;}
test('ready checks readiness without requestId and replies exactly isready',async()=>{const f=await boundFixture();await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.deepEqual(structuredClone(f.out),[{type:'isready'}]);});
test('ready sends no positive reply when busy, malformed, or page unhealthy',async()=>{
 const f=await boundFixture();vm.runInContext('acceptingOrders=1;',f.ctx);await f.ctx.handleWebSocketMessage({type:'ready',data:coin});vm.runInContext('acceptingOrders=0;',f.ctx);
 await f.ctx.handleWebSocketMessage({type:'ready',data:{...coin,address:'../bad'}});
 f.ctx.chrome.tabs.sendMessage=async(_,m)=>m.action==='activatePage'?{protocol:8,authorized:true}:{healthy:false,canTrade:false,url:f.tabs.at(-1).url};
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.equal(f.out.length,0);
});
test('refresh reloads only bound coin and replies exactly isready',async()=>{
 const f=await boundFixture(),reloaded=[];
 f.ctx.chrome.tabs.reload=async id=>{reloaded.push(id);f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
 await f.ctx.handleWebSocketMessage({type:'refresh',data:coin});assert.deepEqual(reloaded,[90]);assert.deepEqual(structuredClone(f.out),[{type:'isready'}]);
});
test('refresh never reloads during an order and never sends a special error response',async()=>{const f=await boundFixture();vm.runInContext('acceptingOrders=1;',f.ctx);await f.ctx.handleWebSocketMessage({type:'refresh',data:coin});assert.equal(f.out.length,0);assert.equal(f.sent.length,0);});
test('post-refresh asset event uploads over HTTP without an additional WebSocket acknowledgement',async()=>{
 const f=await boundFixture(),uploads=[];f.local.browserNumber='23';
 f.ctx.fetch=async(url,options)=>{uploads.push({url,body:JSON.parse(options.body)});return {ok:true,status:200,text:async()=>''}};
 f.ctx.chrome.tabs.reload=async id=>f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});
 await f.ctx.handleWebSocketMessage({type:'refresh',data:coin});
 await f.message({action:'alphaAssetsData',token:f.session.windowBinding.token,data:{url:'https://www.binance.com/bapi/defi/v1/private/wallet-direct/cloud-wallet/alpha',data:{code:'000000',data:{list:[],totalValuation:'0'}}}},{tab:{id:90},frameId:0,url:f.tabs.at(-1).url});
 assert.equal(uploads.length,1);assert.equal(uploads[0].body.name,'23');assert.deepEqual(structuredClone(f.out),[{type:'isready'}]);
});
test('check started on an old socket cannot send isready on a replacement connection',async()=>{
 const f=await boundFixture();let release;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{if(m.action==='checkReady')await new Promise(r=>release=r);return original(id,m)};
 const checking=f.ctx.handleWebSocketMessage({type:'ready',data:coin});await new Promise(r=>setImmediate(r));
 vm.runInContext('ws={readyState:1,send:m=>out.push(JSON.parse(m))};',f.ctx);release();await checking;assert.equal(f.out.length,0);
});
const trade=id=>({...coin,unionId:id,amt:'1',price:'1',symbol:'AAA'});
async function pendingOrder(f){
 let release,dispatch;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{if(m.action!=='executeTrade')return original(id,m);dispatch={id,m};await new Promise(r=>release=r);return {protocol:8,data:{unionId:m.data.unionId,bnResp:1,orderData:{code:'000000'}}}};
 const done=f.ctx.enqueueOrder(trade('a'));await new Promise(r=>setImmediate(r));
 return {done,release,notify:(changes={},senderChanges={})=>f.message({action:'orderConfirmClicked',token:dispatch.m.data.bindingToken,attemptId:dispatch.m.data.attemptId,...changes},{tab:{id:dispatch.id},frameId:0,url:dispatch.m.data.url,...senderChanges})};
}
test('final confirmation sends one isready before receipt or assets arrive',async()=>{
 const f=await boundFixture(),order=await pendingOrder(f);
 assert.equal((await order.notify()).sent,true);assert.deepEqual(f.out.map(m=>m.type),['isready']);
 await order.notify();assert.equal(f.out.length,1);order.release();await order.done;
 assert.deepEqual(f.out.map(m=>m.type),['isready','orderResult']);await order.notify();assert.equal(f.out.length,2);
});
test('confirmation rejects wrong attempt, token, tab, frame and changed socket',async()=>{
 const f=await boundFixture(),order=await pendingOrder(f);
 await order.notify({attemptId:'old'});await order.notify({token:'old'});await order.notify({}, {tab:{id:999}});await order.notify({}, {frameId:1});assert.equal(f.out.length,0);
 vm.runInContext('ws={readyState:1,send:m=>out.push(JSON.parse(m))};',f.ctx);await order.notify();assert.equal(f.out.length,0);order.release();await order.done;
});
test('asset updates and order completion alone do not announce readiness',async()=>{
 const f=await boundFixture(),order=await pendingOrder(f);order.release();await order.done;
 f.ctx.fetch=async()=>({ok:true,status:200,text:async()=>''});f.local.browserNumber='23';
 await f.message({action:'alphaAssetsData',token:f.session.windowBinding.token,data:{data:{code:'000000',data:{list:[]}}}},{tab:{id:90},frameId:0,url:f.tabs.at(-1).url});
 assert.deepEqual(f.out.map(m=>m.type),['orderResult']);
});

for (const [instance,account] of [['23-1','23'],['23-2','23'],['23-3','23'],['22-1','22'],['22-2','22'],['23','23']]) {
 test(`instance ${instance} connects independently and uploads assets as ${account}`,async()=>{
  const f=await boundFixture(),uploads=[];
  assert.equal((await f.message({action:'connectWS',number:instance})).success,true);
  assert.equal(f.local.browserNumber,instance);
  assert.equal(vm.runInContext('ws.url',f.ctx),`wss://sg.bicoin.com.cn/98a/weborder/BINANCEALPHA-${instance}`);
  f.ctx.fetch=async(url,options)=>{uploads.push(JSON.parse(options.body));return {ok:true,status:200,text:async()=>''}};
  await f.message({action:'alphaAssetsData',token:f.session.windowBinding.token,data:{data:{code:'000000',data:{list:[],name:'wrong'}}}},{tab:{id:90},frameId:0,url:f.tabs.at(-1).url});
  assert.equal(uploads.length,1);assert.equal(uploads[0].name,account);
 });
}
test('invalid instance identifiers cannot change saved connection',async()=>{
 const f=await boundFixture();f.local.browserNumber='23-1';
 for(const number of ['', '23-', '-1','23-1-2','23-a','23/1','23-1?x','23-1\n','1234567890123','23-1234567890123']){
  assert((await f.message({action:'connectWS',number})).error,number);
  assert.equal(f.local.browserNumber,'23-1');
 }
});
test('legacy URL-only config derives account without truncating malformed identifiers',async()=>{
 const f=fixture();
 for(const [suffix,want] of [['23-1','23'],['22-2','22'],['23','23'],['23-bad',''],['23-1-2','']]){
  f.local.wsUrl='wss://sg.bicoin.com.cn/98a/weborder/BINANCEALPHA-'+suffix;
  assert.equal(await f.ctx.currentBrowserName(),want);
 }
});

test('popup status follows actual socket lifecycle and ignores old socket events',{timeout:1000},async()=>{
 const f=await boundFixture(),updates=[];f.ctx.chrome.runtime.sendMessage=async m=>updates.push(m);
 await f.message({action:'connectWS',number:'23-1'});
 assert.equal((await f.message({action:'getConnectionStatus'})).readyState,0);
 const old=vm.runInContext('ws',f.ctx),oldOpen=old.onopen;
 old.readyState=1;old.onopen();
 assert.equal(updates.at(-1).connected,true);
 assert.equal((await f.message({action:'getConnectionStatus'})).connected,true);
 await f.message({action:'connectWS',number:'23-2'});const count=updates.length;oldOpen();assert.equal(updates.length,count);
 const current=vm.runInContext('ws',f.ctx);current.readyState=3;current.onclose({code:1000});
 assert.equal(updates.at(-1).connected,false);
 assert.equal((await f.message({action:'getConnectionStatus'})).readyState,3);
});

test('refresh failure or unhealthy page never announces readiness',async()=>{
 for(const failure of ['reload','unhealthy']){
  const f=await boundFixture();
  f.ctx.chrome.tabs.reload=async id=>{if(failure==='reload')throw Error('reload failed');f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
  f.ctx.chrome.tabs.sendMessage=async(_,m)=>m.action==='activatePage'?{protocol:8,authorized:true}:{healthy:false,canTrade:false,url:f.tabs.at(-1).url};
  await f.ctx.handleWebSocketMessage({type:'refresh',data:coin});assert.equal(f.out.length,0);
 }
});
test('refresh cannot acknowledge on a replacement socket',async()=>{
 const f=await boundFixture();
 f.ctx.chrome.tabs.reload=async id=>{vm.runInContext('ws={readyState:1,send:m=>out.push(JSON.parse(m))};',f.ctx);f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
 await f.ctx.handleWebSocketMessage({type:'refresh',data:coin});assert.equal(f.out.length,0);
});

test('ready opens missing coin in its own window then reuses it on the next request',async()=>{
 const f=await boundFixture();const target={chainName:'bsc',address:'0xbbb'};
 f.tabs.push({id:99,windowId:2,url:'https://www.binance.com/en/alpha/bsc/0xbbb',status:'complete'});
 await f.ctx.handleWebSocketMessage({type:'ready',data:target});
 const local=f.tabs.filter(t=>t.windowId===1 && t.url.includes('/0xbbb'));assert.equal(local.length,1);assert.equal(local[0].active,true);assert(f.sent.every(m=>m.id===local[0].id));assert.equal(f.out.at(-1).type,'isready');
 await f.ctx.handleWebSocketMessage({type:'ready',data:target});assert.equal(f.tabs.filter(t=>t.windowId===1 && t.url.includes('/0xbbb')).length,1);
});
test('ready waits for SPA form after document complete before reporting ready',async()=>{
 const f=await boundFixture();let checks=0;
 f.ctx.chrome.tabs.sendMessage=async(_,m)=>m.action==='activatePage'?{protocol:8,authorized:true}:{healthy:++checks>=3,canTrade:checks>=3,url:f.tabs.at(-1).url};
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.equal(checks,3);assert.equal(f.out.at(-1).type,'isready');
});
test('ready recovers a missing content receiver with one bound page reload',async()=>{
 const f=await boundFixture();let reloads=0;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{if(!reloads)throw Error('Could not establish connection. Receiving end does not exist.');return original(id,m)};
 f.ctx.chrome.tabs.reload=async id=>{reloads++;f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.equal(reloads,1);assert.equal(f.out.at(-1).type,'isready');
});
test('unready outcome and busy refusal leave an inspectable local reason',async()=>{
 const f=await boundFixture();vm.runInContext('acceptingOrders=1;',f.ctx);
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});await new Promise(r=>setImmediate(r));assert.equal(f.local.pageCommandDiag.isreadySent,false);assert.match(f.local.pageCommandDiag.reason,/BUSY/);
});

test('refresh opens a missing target without reloading a different coin',async()=>{
 const f=await boundFixture();await f.ctx.handleWebSocketMessage({type:'refresh',data:{chainName:'bsc',address:'0xccc'}});
 assert.equal(f.tabs.find(t=>t.id===90).url.includes(coin.address),true);assert.equal(f.out.at(-1).type,'isready');
 await new Promise(r=>setImmediate(r));assert.equal(f.local.pageCommandDiag.isreadySent,true);assert.equal(f.local.pageCommandDiag.address,'0xccc');
});
test('permanent missing script recovers at most once and records failure',async()=>{
 const f=await boundFixture();let reloads=0;
 f.ctx.chrome.tabs.sendMessage=async()=>{throw Error('Receiving end does not exist')};f.ctx.chrome.tabs.reload=async id=>{reloads++;f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});await new Promise(r=>setImmediate(r));
 assert.equal(reloads,1);assert.equal(f.out.length,0);assert.match(f.local.pageCommandDiag.reason,/Receiving end/);
});
test('closing window marker during readiness check prevents positive reply',async()=>{
 const f=await boundFixture(),original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{const result=await original(id,m);if(m.action==='checkReady')await f.ctx.chrome.tabs.remove(f.session.windowBinding.markerId);return result};
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.equal(f.out.length,0);
});

for(const mode of ['missing','old'])test(`order recovers ${mode} content before dispatch exactly once`,async()=>{
 const f=await boundFixture();let reloads=0,orders=0,checks=0;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.reload=async id=>{reloads++;assert.equal(id,90);f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'})};
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.action==='activatePage' && !reloads){if(mode==='missing')throw Error('Could not establish connection. Receiving end does not exist.');return {protocol:6,authorized:true};}
  if(m.action==='checkReady'){checks++;return {healthy:true,canTrade:checks>=3,url:f.tabs.find(t=>t.id===id).url}}
  if(m.action==='executeTrade'){orders++;assert.equal(checks,3);return {protocol:8,data:{unionId:m.data.unionId,bnResp:1,orderData:{code:'000000'}}}}
  return original(id,m);
 };
 await f.ctx.enqueueOrder(trade('recovery'));assert.equal(reloads,1);assert.equal(orders,1);assert.equal(f.out.at(-1).data.orderData.code,'000000');assert.equal(f.out.some(m=>m.type==='isready'),false);
});
test('unrecoverable receiver refreshes once and never dispatches',async()=>{
 const f=await boundFixture();let reloads=0;
 f.ctx.chrome.tabs.reload=async id=>{reloads++;f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'})};
 f.ctx.chrome.tabs.sendMessage=async()=>{throw Error('Could not establish connection. Receiving end does not exist.')};
 await f.ctx.enqueueOrder(trade('missing'));assert.equal(reloads,1);assert.equal(f.out.at(-1).data.orderData.code,'PAGE_NOT_READY');
});
test('lost connection after dispatch never refreshes or replays order',async()=>{
 const f=await boundFixture();let orders=0,reloads=0;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.reload=async()=>{reloads++};
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{if(m.action==='executeTrade'){orders++;throw Error('Could not establish connection. Receiving end does not exist.')}return original(id,m)};
 await f.ctx.enqueueOrder(trade('dispatched'));assert.equal(orders,1);assert.equal(reloads,0);assert.equal(f.out.at(-1).data.orderData.code,'ORDER_STATUS_UNKNOWN');
});

for(const change of ['socket','coin','window'])test(`receiver recovery rejects changed ${change}`,async()=>{
 const f=await boundFixture();let reloads=0;f.ctx.chrome.tabs.reload=async()=>{reloads++};
 f.ctx.chrome.tabs.sendMessage=async()=>{
  if(change==='socket')vm.runInContext('ws={readyState:1,send:m=>out.push(JSON.parse(m))}',f.ctx);
  if(change==='coin')f.tabs.find(t=>t.id===90).url='https://www.binance.com/en/alpha/bsc/0xbbb';
  if(change==='window')f.tabs.find(t=>t.id===90).windowId=99;
  throw Error('Could not establish connection. Receiving end does not exist.');
 };
 await f.ctx.enqueueOrder(trade('changed'));assert.equal(reloads,0);assert.equal(f.out.at(-1).data.orderData.code,'PAGE_NOT_READY');
});
test('authorization denial does not trigger recovery refresh',async()=>{
 const f=await boundFixture();let reloads=0;f.ctx.chrome.tabs.reload=async()=>{reloads++};f.ctx.chrome.tabs.sendMessage=async()=>({protocol:8,authorized:false,error:'Denied'});
 await f.ctx.enqueueOrder(trade('denied'));assert.equal(reloads,0);assert.match(f.out.at(-1).data.orderData.message,/Denied/);
});

test('local log export is popup-only and persists correlated order events',async()=>{
 const f=await boundFixture(),order=await pendingOrder(f);await order.notify();order.release();await order.done;
 const denied=await f.message({action:'exportLocalLogs'},{url:'https://www.binance.com/en/alpha/bsc/0xaaa'});assert(denied.error);
 const logs=await f.message({action:'exportLocalLogs'});assert(logs.persisted);assert(f.local.alphaLocalLogs.length>0);
 for(const event of ['order_received','order_start','order_dispatch','isready_sent','order_result'])assert(logs.entries.some(e=>e.event===event && e.data.unionId==='a'),event);
 assert(logs.entries.every(e=>typeof e.at==='number' && e.timestamp && e.beijingTime.endsWith('+08:00')));
});

test('ready refreshes an unready form once then checks again',async()=>{
 const f=await boundFixture();let reloads=0,checks=0;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.reload=async id=>{reloads++;f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'})};
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>m.action==='checkReady'?{healthy:reloads===1,canTrade:reloads===1,url:f.tabs.find(t=>t.id===id).url,error:++checks && '等待页面资产数据加载'}:original(id,m);
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.equal(reloads,1);assert.equal(f.out.at(-1).type,'isready');assert(checks>1);
});
test('ready refreshes at most once when assets stay unavailable',async()=>{
 const f=await boundFixture();let reloads=0;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.reload=async id=>{reloads++;f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'})};
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>m.action==='checkReady'?{healthy:false,canTrade:false,url:f.tabs.find(t=>t.id===id).url,error:'等待页面资产数据加载'}:original(id,m);
 await f.ctx.handleWebSocketMessage({type:'ready',data:coin});assert.equal(reloads,1);assert.equal(f.out.length,0);
});


test('confirmation timeout reloads once, reads history and does not replay the order',async()=>{
 const f=await boundFixture();let submits=0,reloads=0,reads=0;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.reload=async id=>{reloads++;f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.action==='executeTrade'){
   submits++;
   await f.message({action:'orderConfirmClicked',token:m.data.bindingToken,attemptId:m.data.attemptId},{tab:{id},frameId:0,url:m.data.url});
   return {protocol:8,data:{unionId:m.data.unionId,bnResp:0,orderData:{code:'ORDER_STATUS_UNKNOWN'},recoverHistory:true,confirmedAt:f.ctx.Date.now(),request:{symbol:'ALPHA_772USDT',side:'SELL',price:'1',quantity:'1'}}};
  }
  if(m.action==='readOrderHistory'){reads++;return {protocol:8,history:{code:'000000',data:[{orderId:'other-thread',symbol:'ALPHA_772USDT',side:'SELL',price:'1',origQty:'1',time:f.ctx.Date.now(),status:'FILLED'}]}};}
  return original(id,m);
 };
 await f.ctx.enqueueOrder(trade('history'));
 assert.equal(submits,1);assert.equal(reloads,1);assert.equal(reads,1);
 const r=f.out.find(m=>m.type==='orderResult').data;
 assert.equal(r.bnResp,0);assert.equal(r.orderData.code,'ORDER_STATUS_UNKNOWN');
 assert.equal(r.orderData.historyCheck.candidates[0].orderId,'other-thread');
 assert.equal(r.recoverHistory,undefined);
});

test('history recovery stops when the tab changes coin and never reloads another coin',async()=>{
 const f=await boundFixture();let reloads=0;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.chrome.tabs.reload=async()=>{reloads++};
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.action!=='executeTrade')return original(id,m);
  await f.message({action:'orderConfirmClicked',token:m.data.bindingToken,attemptId:m.data.attemptId},{tab:{id},frameId:0,url:m.data.url});
  f.tabs.find(t=>t.id===id).url='https://www.binance.com/en/alpha/bsc/0xbbb';
  return {protocol:8,data:{unionId:m.data.unionId,bnResp:0,orderData:{code:'ORDER_STATUS_UNKNOWN'},recoverHistory:true}};
 };
 await f.ctx.enqueueOrder(trade('changed'));
 assert.equal(reloads,0);assert.equal(f.out.find(m=>m.type==='orderResult').data.bnResp,0);
});

test('background watchdog recovers even if the confirmed page stops replying',async()=>{
 const f=await boundFixture();const timers=[];let reloads=0;const original=f.ctx.chrome.tabs.sendMessage;
 f.ctx.setTimeout=(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer};f.ctx.clearTimeout=t=>{if(t)t.cancelled=true};
 f.ctx.chrome.tabs.reload=async id=>{reloads++;f.ctx.chrome.tabs.onUpdated.emit(id,{status:'complete'});};
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.action==='executeTrade') {
   await f.message({action:'orderConfirmClicked',token:m.data.bindingToken,attemptId:m.data.attemptId},{tab:{id},frameId:0,url:m.data.url});
   await f.message({action:'orderRequestObserved',token:m.data.bindingToken,attemptId:m.data.attemptId,data:{symbol:'ALPHA_772USDT',side:'SELL',secret:'never keep'}},{tab:{id},frameId:0,url:m.data.url});
   return new Promise(()=>{});
  }
  if(m.action==='readOrderHistory')return {protocol:8,history:{code:'000000',data:[]}};
  return original(id,m);
 };
 const pending=f.ctx.enqueueOrder(trade('frozen'));await new Promise(r=>setImmediate(r));
 const watchdog=timers.find(t=>t.ms===10000);assert(watchdog,'background needs a ten-second timer');
 await f.ctx.sleep(10000);watchdog.fn();await pending;
 assert.equal(reloads,1);assert.equal(f.out.filter(m=>m.type==='orderResult').length,1);
 assert.equal(f.out.at(-1).data.orderData.historyCheck.queried,true);assert(watchdog.cancelled);
});

test('next order after history refresh waits for assets instead of filling an unready page',async()=>{
 const f=await boundFixture();let submits=0;const original=f.ctx.chrome.tabs.sendMessage;
 vm.runInContext('historyReloadedTabs.add(90)',f.ctx);
 f.ctx.chrome.tabs.sendMessage=async(id,m)=>{
  if(m.action==='checkReady')return {healthy:false,canTrade:false,url:f.tabs.at(-1).url,error:'等待页面资产数据加载'};
  if(m.action==='executeTrade')submits++;
  return original(id,m);
 };
 await f.ctx.enqueueOrder(trade('after-recovery'));
 assert.equal(submits,0);assert.equal(f.out.at(-1).data.orderData.code,'PAGE_NOT_READY');
 assert(vm.runInContext('historyReloadedTabs.has(90)',f.ctx));
});
