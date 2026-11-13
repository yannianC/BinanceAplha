const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const AlphaTrade=require('../trade-core.js');
const silent={log(){},warn(){},error(){}};
const source=fs.readFileSync('background.js','utf8').replace(/\r\n/g,'\n');
function routing(tabs) {
 tabs=tabs.map(t=>({windowId:1,...t}));
 const sent=[],created=[];const chrome={tabs:{
  query:async q=>tabs.filter(t=>t.windowId===q.windowId),create:async t=>{const tab={...t,id:tabs.length+1,status:'complete'};tabs.push(tab);created.push(tab);return tab},
  get:async id=>{const tab=tabs.find(t=>t.id===id);if(!tab)throw Error('closed');return tab},
  update:async(id,values)=>{const tab=tabs.find(t=>t.id===id);Object.assign(tab,values);return tab},
  sendMessage:async(id,msg)=>msg.action==='activatePage'?{protocol:3,authorized:true}:(sent.push({id,msg}),{protocol:3,data:{unionId:msg.data.unionId,bnResp:1,orderData:{code:'000000'}}})
 }};
 const windowBinding={require:async()=>({windowId:1,token:"t"}),authorize:async id=>{if((await chrome.tabs.get(id)).windowId!==1)throw Error("wrong window")}};
 const ctx=vm.createContext({chrome,windowBinding,AlphaTrade,console:silent,setTimeout,clearTimeout,Date,URL});
 vm.runInContext('let tradingTabId;'+source.slice(source.indexOf('async function executeTrade(tradeInfo)'),source.indexOf('/**\n * 监听来自content script')),ctx);
 return {ctx,sent,created};
}
test('A B A reuses pages across locales, creates missing B without closing A',async()=>{
 const {ctx,sent,created}=routing([{id:1,url:'https://www.binance.com/en/alpha/bsc/0xaaa?source=foo',status:'complete'}]);
 for(const [id,addr]of[['1','0xaaa'],['2','0xbbb'],['3','0xaaa']]) await ctx.executeTrade({bindingToken:'t',unionId:id,url:`https://www.binance.com/zh-CN/alpha/bsc/${addr}`});
 assert.deepEqual(sent.map(x=>x.id),[1,2,1]);assert.equal(created.length,1);
});
test('legacy content script refuses dispatch until page refresh',async()=>{
 const {ctx,sent}=routing([{id:1,url:'https://www.binance.com/en/alpha/bsc/0xaaa',status:'complete'}]);
 ctx.chrome.tabs.sendMessage=async()=>({ready:true});
 const result=await ctx.executeTrade({bindingToken:'t',unionId:'x',url:'https://www.binance.com/zh-CN/alpha/bsc/0xaaa'});
 assert.equal(result.orderData.code,'PAGE_NOT_READY');assert.equal(sent.length,0);
});
test('fetch and XHR results retain ID captured at request time, not response time',async()=>{
 const listeners=[],messages=[],pending=[];
 const window={addEventListener:(_,f)=>listeners.push(f),postMessage:m=>messages.push(m),fetch:()=>new Promise(resolve=>pending.push(resolve))};
 function xhr(){this.handlers={};}xhr.prototype.open=function(){};xhr.prototype.setRequestHeader=function(){};xhr.prototype.send=function(){};xhr.prototype.addEventListener=function(k,f){this.handlers[k]=f};
 const ctx=vm.createContext({window,document:{currentScript:{dataset:{alphaInstance:'a',alphaToken:'t'}}},XMLHttpRequest:xhr,console:silent});vm.runInContext(fs.readFileSync('injected.js','utf8'),ctx);
 const arm=id=>listeners.forEach(f=>f({source:window,data:{type:'ALPHA_ARM_ORDER',unionId:id,instanceId:'a',token:'t'}}));
 const url='/bapi/asset/v1/private/alpha-trade/order/place';
 arm('a');const a=window.fetch(url);arm('b');const b=window.fetch(url);
 pending[1]({clone:()=>({json:async()=>({code:'000000'})})});pending[0]({clone:()=>({json:async()=>({code:'000000'})})});await Promise.all([a,b]);await new Promise(r=>setImmediate(r));
 assert.deepEqual(messages.filter(m=>m.type==='FETCH_RESPONSE').map(m=>m.unionId),['b','a']);
 arm('c');const req=new xhr();req.open('POST',url);req.send();arm('d');req.responseText='{"code":"000000"}';req.handlers.load.call(req);
 assert.equal(messages.at(-1).unionId,'c');
});
test('simultaneous preload and order preparation creates only one tab',async()=>{
 const {ctx,created}=routing([]);const url='https://www.binance.com/en/alpha/bsc/0xaaa';
 const results=await Promise.all([ctx.getOrCreateTradingTab(url),ctx.getOrCreateTradingTab(url)]);
 assert.equal(created.length,1);assert.equal(results[0].id,results[1].id);
});
function pageFixture(){
 let listener;const events=[];const window={__INTERCEPTOR_INJECTED__:true,addEventListener:(_,f)=>listener=f,postMessage:m=>{events.push(m);if(m.type==='ALPHA_ARM_ORDER')listener({source:window,data:{type:'ALPHA_ORDER_ARMED',unionId:m.unionId,instanceId:'a',token:'t'}})}};
 const ctx=vm.createContext({window,AlphaTrade,location:{href:'https://www.binance.com/en/alpha/bsc/0xaaa'},chrome:{runtime:{id:'a',sendMessage:async()=>({authorized:true,token:'t'}),onMessage:{addListener(){}}}},console:silent,Date,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync('content.js','utf8'),ctx);
 vm.runInContext("pageBinding='t';injectionPromise=Promise.resolve();",ctx);
 vm.runInContext('sleep=async()=>{};waitForPageReady=async()=>{};clickKnowItButton=async()=>{};clickTradeTab=async()=>{};ensureLimitOrderTab=async()=>{};setInputValue=async()=>{};',ctx);
 return {ctx,emit:data=>listener({source:window,data:{instanceId:'a',token:'t',...data}})};
}
test('expired order cannot click submit',async()=>{
 const {ctx}=pageFixture();let clicks=0;ctx.clickSubmitButton=async(_,__,before)=>{before();clicks++};
 const result=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'expired',deadline:Date.now()-1});
 assert.equal(clicks,0);assert.equal(result.orderData.code,'EXECUTION_ERROR');
});
test('page waits for matching receipt and finishes DOM flow before returning',async()=>{
 const {ctx,emit}=pageFixture();let dialogFinished=false;
 ctx.clickSubmitButton=async(_,__,before)=>{before();emit({type:'FETCH_RESPONSE',unionId:'old',data:{code:'bad'}});emit({type:'FETCH_RESPONSE',unionId:'new',data:{code:'000000'}})};
 ctx.clickDialogConfirmButton=async()=>{dialogFinished=true};
 const result=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'new',deadline:Date.now()+80000});
 assert.equal(dialogFinished,true);assert.equal(result.unionId,'new');assert.equal(result.orderData.code,'000000');
});
test('routing never reuses another window even for identical coin',async()=>{
 const {ctx,sent,created}=routing([{id:9,windowId:2,url:'https://www.binance.com/en/alpha/bsc/0xaaa',status:'complete'}]);
 await ctx.executeTrade({bindingToken:'t',unionId:'own',url:'https://www.binance.com/en/alpha/bsc/0xaaa'});
 assert.equal(created.length,1);assert.equal(created[0].windowId,1);assert.notEqual(sent[0].id,9);
});
test('final click rejects SPA navigation during asynchronous authorization',async()=>{
 const {ctx}=pageFixture();let release,clicks=0;
 vm.runInContext("activeTrade={id:'x',url:location.href,token:'t',deadline:Date.now()+80000};",ctx);
 ctx.checkPageAuthority=()=>new Promise(r=>release=r);
 const click=ctx.authorizedClick({click:()=>clicks++});ctx.location.href='https://www.binance.com/en/alpha/bsc/0xbbb';release();
 await assert.rejects(click);assert.equal(clicks,0);
});
test('confirmation stops if receipt arrives during asynchronous authorization',async()=>{
 const {ctx,emit}=pageFixture();let release,clicks=0;
 vm.runInContext("activeTrade={id:'x',url:location.href,token:'t',deadline:Date.now()+80000};",ctx);
 ctx.checkPageAuthority=()=>new Promise(r=>release=r);
 const click=ctx.authorizedClick({click:()=>clicks++});emit({type:'FETCH_RESPONSE',unionId:'x',data:{code:'000000'}});release();await click;assert.equal(clicks,0);
});
