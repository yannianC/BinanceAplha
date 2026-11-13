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
  sendMessage:async(id,msg)=>msg.action==='activatePage'?{protocol:8,authorized:true}:(sent.push({id,msg}),{protocol:8,data:{unionId:msg.data.unionId,bnResp:1,orderData:{code:'000000'}}})
 }};
 const windowBinding={require:async()=>({windowId:1,token:"t"}),authorize:async id=>{if((await chrome.tabs.get(id)).windowId!==1)throw Error("wrong window")}};
 const ctx=vm.createContext({chrome,windowBinding,AlphaTrade,console:silent,setTimeout,clearTimeout,Date,URL,crypto:require('node:crypto').webcrypto});
 vm.runInContext('function logEvent(){}let tradingTabId,activeDispatch=null;const ws=null;const historyReloadedTabs=new Set();'+source.slice(source.indexOf('async function executeTrade(tradeInfo)'),source.indexOf('/**\n * 监听来自content script')),ctx);
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
 const ctx=vm.createContext({window,document:{currentScript:{dataset:{alphaInstance:'a',alphaToken:'t'}}},location:{href:'https://www.binance.com/en/alpha/bsc/0xaaa'},XMLHttpRequest:xhr,console:silent});vm.runInContext(fs.readFileSync('injected.js','utf8'),ctx);
 const arm=id=>listeners.forEach(f=>f({source:window,data:{type:'ALPHA_ARM_ORDER',unionId:id,instanceId:'a',token:'t'}}));
 const url='/bapi/asset/v1/private/alpha-trade/order/place';
 arm('a');const a=window.fetch(url);arm('b');const b=window.fetch(url);
 pending[1]({clone:()=>({json:async()=>({code:'000000'})})});pending[0]({clone:()=>({json:async()=>({code:'000000'})})});await Promise.all([a,b]);await new Promise(r=>setImmediate(r));
 assert.deepEqual(messages.filter(m=>m.type==='FETCH_RESPONSE').map(m=>m.unionId),['b','a']);
 arm('c');const req=new xhr();req.open('POST',url);req.send();arm('d');req.responseText='{"code":"000000"}';req.handlers.load.call(req);
 assert.equal(messages.at(-1).unionId,'c');
});
test('asset events retain request-start page URL after SPA navigation',async()=>{
 const listeners=[],messages=[],pending=[];const location={href:'https://www.binance.com/en/alpha/bsc/0xaaa'};
 const window={addEventListener:(_,f)=>listeners.push(f),postMessage:m=>messages.push(m),fetch:()=>new Promise(resolve=>pending.push(resolve))};
 function xhr(){this.handlers={};}xhr.prototype.open=function(){};xhr.prototype.setRequestHeader=function(){};xhr.prototype.send=function(){};xhr.prototype.addEventListener=function(k,f){this.handlers[k]=f};
 const ctx=vm.createContext({window,document:{currentScript:{dataset:{alphaInstance:'a',alphaToken:'t'}}},location,XMLHttpRequest:xhr,console:silent});vm.runInContext(fs.readFileSync('injected.js','utf8'),ctx);
 const asset='/bapi/defi/v1/private/wallet-direct/cloud-wallet/alpha';const req=window.fetch(asset);location.href='https://www.binance.com/en/alpha/bsc/0xbbb';
 pending[0]({clone:()=>({json:async()=>({code:'000000',data:{list:[]}})})});await req;await new Promise(r=>setImmediate(r));
 assert.equal(messages.filter(m=>m.type==='ALPHA_ASSETS_DATA').at(-1).pageUrl,'https://www.binance.com/en/alpha/bsc/0xaaa');
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
 vm.runInContext('sleep=async()=>{};waitForPageReady=async()=>{};clickKnowItButton=async()=>{};clickTradeTab=async()=>{};ensureLimitOrderTab=async()=>{};setInputValue=async()=>{};waitForOrderForm=async()=>{};assertOrderForm=()=>{};captureOrderForm=()=>({});',ctx);
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
 vm.runInContext("activeTrade={id:'x',unionId:'x',url:location.href,token:'t',deadline:Date.now()+80000};",ctx);
 ctx.checkPageAuthority=()=>new Promise(r=>release=r);
 const click=ctx.authorizedClick({click:()=>clicks++});ctx.location.href='https://www.binance.com/en/alpha/bsc/0xbbb';release();
 await assert.rejects(click);assert.equal(clicks,0);
});
test('confirmation stops if receipt arrives during asynchronous authorization',async()=>{
 const {ctx,emit}=pageFixture();let release,clicks=0;
 vm.runInContext("activeTrade={id:'x',unionId:'x',url:location.href,token:'t',deadline:Date.now()+80000};",ctx);
 ctx.checkPageAuthority=()=>new Promise(r=>release=r);
 const click=ctx.authorizedClick({click:()=>clicks++});emit({type:'FETCH_RESPONSE',unionId:'x',data:{code:'000000'}});release();await click;assert.equal(clicks,0);
});
test('readiness requires a current-page asset snapshot and two stable seconds',async()=>{
 const {ctx,emit}=pageFixture();const price={offsetParent:{},disabled:false,readOnly:false},amount={...price};
 ctx.document={readyState:'complete',getElementById:id=>id==='limitPrice'?price:amount,querySelectorAll:()=>[{offsetParent:{},disabled:true,textContent:'买入 AAA'}]};
 let ready=await ctx.checkPageReady();assert.equal(ready.canTrade,false);assert.equal(ready.assetsLoaded,false);
 emit({type:'ALPHA_ASSETS_DATA',pageUrl:'https://www.binance.com/en/alpha/bsc/0xbbb',data:{code:'000000',data:{list:[]}}});
 ready=await ctx.checkPageReady();assert.equal(ready.assetsLoaded,false);
 emit({type:'ALPHA_ASSETS_DATA',pageUrl:ctx.location.href,data:{code:'000000',data:{list:[]}}});
 ready=await ctx.checkPageReady();assert.equal(ready.assetsLoaded,true);assert.equal(ready.canTrade,false);assert.match(ready.error,/稳定/);
 vm.runInContext('pageReadiness.stableSince=Date.now()-READY_SETTLE_MS;',ctx);
 ready=await ctx.checkPageReady();assert.equal(ready.canTrade,true);assert.equal(ready.assetsSettled,true);
 amount.disabled=true;ready=await ctx.checkPageReady();assert.equal(ready.canTrade,false);assert.equal(ready.assetsSettled,false);
 amount.disabled=false;ready=await ctx.checkPageReady();assert.equal(ready.canTrade,false);assert.match(ready.error,/稳定/);
 ctx.activeTrade={id:'running'};ready=await ctx.checkPageReady();assert.equal(ready.canTrade,false);assert.equal(ready.assetsLoaded,true);
 vm.runInContext('pageReadiness.stableSince=Date.now()-READY_SETTLE_MS;',ctx);
 ctx.activeTrade=null;ready=await ctx.checkPageReady();assert.equal(ready.canTrade,true);
});

test('SPA coin changes reset page asset readiness',async()=>{
 const {ctx,emit}=pageFixture();const input={offsetParent:{},disabled:false,readOnly:false};
 ctx.document={readyState:'complete',getElementById:()=>input,querySelectorAll:()=>[{offsetParent:{},disabled:true,textContent:'买入 AAA'}]};
 emit({type:'ALPHA_ASSETS_DATA',pageUrl:ctx.location.href,data:{code:'000000',data:{list:[]}}});await ctx.checkPageReady();
 ctx.location.href='https://www.binance.com/en/alpha/bsc/0xbbb';const ready=await ctx.checkPageReady();
 assert.equal(ready.assetsLoaded,false);assert.equal(ready.canTrade,false);
});

test('blocked submit is re-entered once before any click',async()=>{
 const {ctx,emit}=pageFixture();const fills=[];let submits=0;
 ctx.setInputValue=async(id,value)=>fills.push([id,value]);
 let forms=0;ctx.waitForOrderForm=async()=>{if(++forms===1){const e=Error('提交按钮尚未就绪');e.code='FORM_NOT_READY';throw e;}};
 ctx.clickSubmitButton=async(_,__,before)=>{submits++;before();emit({type:'FETCH_RESPONSE',unionId:'attempt',data:{code:'000000'}});};
 ctx.clickDialogConfirmButton=async()=>{};
 const r=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'retry',attemptId:'attempt',price:'1',amount:'2',direction:'Buy',coin:'AAA',deadline:Date.now()+80000});
 assert.equal(r.orderData.code,'000000');assert.equal(submits,1);assert.deepEqual(fills,[['limitPrice','1'],['limitAmount','2'],['limitPrice','1'],['limitAmount','2']]);
});

test('two blocked submit preparations stop after one refill and never click',async()=>{
 const {ctx}=pageFixture();let fills=0,submits=0;
 ctx.setInputValue=async()=>{fills++};ctx.waitForOrderForm=async()=>{const e=Error('提交按钮尚未就绪');e.code='FORM_NOT_READY';throw e};
 ctx.clickSubmitButton=async()=>{submits++};
 const r=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'blocked',deadline:Date.now()+80000});
 assert.equal(r.orderData.code,'EXECUTION_ERROR');assert.match(r.orderData.message,/提交按钮/);assert.equal(fills,4);assert.equal(submits,0);
});

test('failure after submission click is never retried',async()=>{
 const {ctx}=pageFixture();let fills=0;ctx.setInputValue=async()=>{fills++};
 ctx.clickSubmitButton=async(_,__,before)=>{before();throw Error('点击后连接中断')};
 const r=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'after-click',deadline:Date.now()+80000});
 assert.equal(r.orderData.code,'ORDER_STATUS_UNKNOWN');assert.equal(fills,2);
});

test('authority failure before form preparation is not retried',async()=>{
 const {ctx}=pageFixture();let fills=0;ctx.setInputValue=async()=>{fills++};
 ctx.checkPageAuthority=async()=>{throw Error('授权已失效')};
 const r=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'auth',deadline:Date.now()+80000});
 assert.equal(r.orderData.code,'EXECUTION_ERROR');assert.equal(fills,0);
});

test('input setter updates tracked form state, not only displayed DOM value',async()=>{
 class Input {get value(){return this.raw || ''}set value(v){this.raw=String(v)}focus(){}blur(){}dispatchEvent(){if(this.raw!==this.tracked){this.model=this.raw;this.tracked=this.raw}}}
 const input=new Input();input.value='1234';input.tracked='1234';input.model='1234';
 Object.defineProperty(input,'value',{get(){return this.raw},set(v){this.raw=String(v);this.tracked=String(v)}});
 const text=fs.readFileSync('content.js','utf8');const start=text.indexOf('async function setInputValue('),end=text.indexOf('async function clickSubmitButton(',start);
 const ctx=vm.createContext({HTMLInputElement:Input,Event:class{constructor(type){this.type=type}},console:silent,waitForElement:async()=>input,sleep:async()=>{}});vm.runInContext(text.slice(start,end),ctx);
 ctx.waitForFormUpdate=async()=>{};await ctx.setInputValue('limitAmount','945');assert.equal(input.value,'945');assert.equal(input.model,'945');
});

test('same unionId retry ignores previous attempt response and keeps server ID in result',async()=>{
 const {ctx,emit}=pageFixture();
 ctx.clickSubmitButton=async(_,__,before)=>{before();emit({type:'FETCH_RESPONSE',unionId:'attempt-old',data:{code:'OLD'}});emit({type:'FETCH_RESPONSE',unionId:'attempt-new',data:{code:'000000'}})};
 ctx.clickDialogConfirmButton=async()=>{};
 const r=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'same-server-id',attemptId:'attempt-new',deadline:Date.now()+80000});
 assert.equal(r.unionId,'same-server-id');assert.equal(r.orderData.code,'000000');
});
test('submit check rejects mismatched direction and values; error captures balance evidence',()=>{
 const s=fs.readFileSync('content.js','utf8');const ctx=vm.createContext({Date});vm.runInContext(s.slice(s.indexOf('function normalizedFormNumber'),s.indexOf('async function clickSubmitButton')),ctx);
 const inputs={limitPrice:{value:'0.051732230'},limitAmount:{value:'945.00'},limitTotal:{value:'48.89'},'bn-tab-LIMIT':{classList:{contains:()=>true}}};
 let direction='卖出';ctx.document={getElementById:id=>inputs[id],querySelectorAll:()=>[{textContent:'买入',classList:{contains:()=>direction==='买入'}},{textContent:'卖出',classList:{contains:()=>direction==='卖出'}}],body:{innerText:'可用\n1000 AGT\n余额不足'}};
 ctx.assertOrderForm('Sell','0.05173223','945');inputs.limitAmount.value='1234';assert.throws(()=>ctx.assertOrderForm('Sell','0.05173223','945'));inputs.limitAmount.value='945';direction='买入';assert.throws(()=>ctx.assertOrderForm('Sell','0.05173223','945'));
 const r=ctx.attachOrderDiagnostics({orderData:{code:'ORDER_STATUS_UNKNOWN'}},{});assert.equal(r.orderData.pageDiagnostics.after.values.limitAmount,'945');assert(r.orderData.pageDiagnostics.after.balanceHints.some(t=>t.includes('余额不足')));
});

test('form direction guard supports visible English Buy/Sell tabs',()=>{
 const s=fs.readFileSync('content.js','utf8');const ctx=vm.createContext({Date});vm.runInContext(s.slice(s.indexOf('function normalizedFormNumber'),s.indexOf('async function clickSubmitButton')),ctx);
 let active='Sell';const tabs=['Buy','Sell'].map(text=>({textContent:text,offsetParent:{},classList:{contains:()=>active===text}}));
 ctx.document={querySelectorAll:()=>[{textContent:'卖出',offsetParent:null,classList:{contains:()=>true}},...tabs],getElementById:id=>id==='bn-tab-LIMIT'?{classList:{contains:()=>true}}:{value:id==='limitPrice'?'1':'945'}};
 ctx.assertOrderForm('Sell','1','945');assert.throws(()=>ctx.assertOrderForm('Buy','1','945'));active='Buy';ctx.assertOrderForm('Buy','1','945');assert.throws(()=>ctx.assertOrderForm('Sell','1','945'));
});

test('stable form proceeds after render passes without fixed 150ms polling delays',async()=>{
 let now=0;const text=fs.readFileSync('content.js','utf8');
 const ctx=vm.createContext({Date:{now:()=>now},sleep:async ms=>{now+=ms}});
 vm.runInContext(text.slice(text.indexOf('function normalizedFormNumber'),text.indexOf('async function clickSubmitButton')),ctx);
 ctx.document={querySelectorAll:()=>[{offsetParent:{},disabled:false,textContent:'买入 AAA'}]};ctx.assertOrderForm=()=>{};ctx.waitForFormUpdate=async()=>{now+=16};
 await ctx.waitForOrderForm('Buy','1','2','AAA');assert(now<=100,`stable form took ${now}ms`);
});

test('form waits only for the exact target coin submit button',async()=>{
 let now=0;const text=fs.readFileSync('content.js','utf8');const ctx=vm.createContext({Date:{now:()=>now}});
 vm.runInContext(text.slice(text.indexOf('function findSubmitButton'),text.indexOf('async function clickSubmitButton')),ctx);
 ctx.assertOrderForm=()=>{};ctx.waitForFormUpdate=async()=>{now+=16};
 ctx.document={querySelectorAll:()=>[{offsetParent:{},textContent:'买入 OTHER',get disabled(){return false}},{offsetParent:{},textContent:'买入 AAA',get disabled(){return now<160}}]};
 await ctx.waitForOrderForm('Buy','1','2','AAA');assert(now>=192);assert(now<300);
});
test('render wait uses timer fallback in hidden pages and cancels unused callback',async()=>{
 const text=fs.readFileSync('content.js','utf8');
 for(const winner of ['frame','timer']){
  let frame,timer,cleared=false,cancelled=false;
  const ctx=vm.createContext({requestAnimationFrame:cb=>{frame=cb;return 1},cancelAnimationFrame:id=>{cancelled=id===1},setTimeout:cb=>{timer=cb;return 2},clearTimeout:id=>{cleared=id===2}});
  vm.runInContext(text.slice(text.indexOf('function waitForFormUpdate'),text.indexOf('function normalizedFormNumber')),ctx);
  const wait=ctx.waitForFormUpdate();(winner==='frame'?frame:timer)();await wait;assert(cleared);assert(cancelled);
 }
});

test('confirmation announces only after an actual successful click',async()=>{
 for(const mode of ['clicked','skipped','throw','disabled']) {
  const {ctx}=pageFixture();const sent=[];let clicks=0;
  const btn={offsetParent:{},offsetHeight:20,isConnected:true,disabled:false,className:'bn-button__primary',textContent:'确认',click(){clicks++;if(mode==='throw')throw Error('click failed')}};
  ctx.document={querySelectorAll:()=>[{offsetParent:{},offsetHeight:20,querySelectorAll:()=>[btn]}]};
  let now=0;ctx.Date={now:()=>now};ctx.sleep=async ms=>{now+=ms};ctx.chrome.runtime.sendMessage=async m=>{sent.push(m);return {sent:true}};
  ctx.authorizedClick=async(element,before)=>{if(mode==='skipped')return false;if(mode==='disabled')element.disabled=true;before();element.click();return true};
  await ctx.clickDialogConfirmButton({id:'attempt',token:'t'},()=>{});
  assert.equal(sent.filter(m=>m.action==='orderConfirmClicked').length,mode==='clicked'?1:0,mode);
  if(mode==='clicked')assert.equal(clicks,1);
 }
});

function timedForm({step=16,priceAt=()=> '0.05040560',lockedAt=()=>false,buttonAt=()=>true}={}) {
 let now=0;const s=fs.readFileSync('content.js','utf8');const ctx=vm.createContext({Date:{now:()=>now}});
 vm.runInContext(s.slice(s.indexOf('function normalizedFormNumber'),s.indexOf('async function clickSubmitButton')),ctx);
 ctx.document={getElementById:id=>id==='bn-tab-LIMIT'?{classList:{contains:()=>true}}:{get value(){return id==='limitPrice'?priceAt(now):'15,535'},get disabled(){return lockedAt(now)},readOnly:false,offsetParent:{}},querySelectorAll:selector=>selector==='.bn-tab__buySell'?[{textContent:'买入',offsetParent:{},classList:{contains:()=>true}}]:[{textContent:'买入 AAA',offsetParent:{},get disabled(){return !buttonAt(now)}}]};
 ctx.waitForFormUpdate=async()=>{now+=step};return {ctx,now:()=>now};
}
test('correct form survives 1 second background scheduling intervals',async()=>{
 const f=timedForm({step:1000});await f.ctx.waitForOrderForm('Buy','0.05040560','15535','AAA');assert.equal(f.now(),2000);
});
test('price synchronization may complete after one second with button available',async()=>{
 const f=timedForm({priceAt:t=>t<1200?'0.05':'0.05040560'});await f.ctx.waitForOrderForm('Buy','0.05040560','15535','AAA');assert(f.now()>=1200);assert(f.now()<1500);
});
test('button unavailable for one second returns a retryable failure',async()=>{
 const f=timedForm({buttonAt:()=>false});await assert.rejects(f.ctx.waitForOrderForm('Buy','0.05040560','15535','AAA'),e=>e.code==='FORM_NOT_READY');assert(f.now()>=1000 && f.now()<1100);
});
test('persistent price mismatch returns retryable snapshot with expected and actual values',async()=>{
 const f=timedForm({priceAt:()=> '0.05'});await assert.rejects(f.ctx.waitForOrderForm('Buy','0.05040560','15535','AAA'),e=>e.code==='FORM_NOT_READY' && e.formCheck.expected==='0.05040560' && e.formCheck.actual==='0.05');
});
test('same price in locked input reports locked state and can retry',async()=>{
 const f=timedForm({lockedAt:()=>true});await assert.rejects(f.ctx.waitForOrderForm('Buy','0.05040560','15535','AAA'),e=>e.code==='FORM_NOT_READY' && e.formCheck.disabled===true && e.formCheck.actual===e.formCheck.expected);
});

for(const recovers of [true,false])test(`real price mismatch ${recovers?'recovers on one refill':'reports both failed checks'}`,async()=>{
 const {ctx,emit}=pageFixture();let fills=0,clicks=0;
 const f=timedForm({priceAt:()=>recovers && fills>=4?'0.05040560':'0.05'});
 ctx.setInputValue=async()=>{fills++};ctx.waitForOrderForm=(...args)=>f.ctx.waitForOrderForm(...args);
 ctx.clickSubmitButton=async(_,__,before)=>{before();clicks++;emit({type:'FETCH_RESPONSE',unionId:'sync',data:{code:'000000'}})};
 ctx.clickDialogConfirmButton=async()=>{};
 const result=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'sync',price:'0.05040560',amount:'15535',direction:'Buy',coin:'AAA',deadline:Date.now()+80000});
 assert.equal(fills,4);assert.equal(clicks,recovers?1:0);assert.equal(result.orderData.code,recovers?'000000':'EXECUTION_ERROR');
 if(!recovers){const d=result.orderData.pageDiagnostics;assert.equal(d.expected.price,'0.05040560');assert.equal(d.preparationErrors.length,2);assert.equal(d.preparationErrors[0].formCheck.actual,'0.05');}
});


test('confirmed order waits exactly ten seconds then requests history recovery without resubmitting',async()=>{
 const {ctx}=pageFixture();let now=10000,submits=0;
 ctx.Date=class extends Date{static now(){return now}};ctx.sleep=async ms=>{now+=ms};
 ctx.clickSubmitButton=async(_,__,before)=>{before();submits++};
 ctx.clickDialogConfirmButton=async t=>{t.confirmedAt=now};
 const r=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'timeout',deadline:90000});
 assert.equal(r.recoverHistory,true);assert.equal(r.confirmedAt,10100);assert.equal(now,20100);
 assert.equal(r.bnResp,0);assert.equal(submits,1);
});

test('receipt within ten seconds returns normally and never requests history recovery',async()=>{
 const {ctx,emit}=pageFixture();let now=10000;
 ctx.Date=class extends Date{static now(){return now}};
 ctx.sleep=async ms=>{now+=ms;if(now>=15000)emit({type:'FETCH_RESPONSE',unionId:'receipt',data:{code:'000000'}})};
 ctx.clickSubmitButton=async(_,__,before)=>before();ctx.clickDialogConfirmButton=async t=>{t.confirmedAt=now};
 const r=await ctx.executeTradeOnPage({bindingToken:'t',url:ctx.location.href,unionId:'receipt',deadline:90000});
 assert.equal(r.orderData.code,'000000');assert.equal(r.recoverHistory,undefined);assert.equal(now,15000);
});

test('history read clicks only history navigation, captures response and restores open orders',async()=>{
 const {ctx,emit}=pageFixture();let now=10000;const clicks=[];
 ctx.Date=class extends Date{static now(){return now}};ctx.sleep=async ms=>{now+=ms};
 const open={textContent:'当前委托',offsetParent:{},isConnected:true,click(){clicks.push('open')}};
 const history={textContent:'历史委托',offsetParent:{},getAttribute:()=>null,click(){clicks.push('history');emit({type:'ALPHA_ORDER_HISTORY',pageUrl:ctx.location.href,data:{code:'000000',data:[{orderId:'sample',status:'FILLED'}]}})}};
 ctx.document={querySelectorAll:()=>[open,history]};
 const r=await ctx.readOrderHistory({bindingToken:'t',url:ctx.location.href});
 assert.equal(r.data[0].orderId,'sample');assert.deepEqual(clicks,['history','open']);
});
test('history read accepts a current-page response already emitted during reload without extra clicks',async()=>{
 const {ctx,emit}=pageFixture();ctx.document={querySelectorAll(){throw Error('should not click')}};
 emit({type:'ALPHA_ORDER_HISTORY',pageUrl:ctx.location.href,data:{code:'000000',data:[]}});
 const r=await ctx.readOrderHistory({bindingToken:'t',url:ctx.location.href});assert.equal(r.data.length,0);
});
test('history read ignores a different coin response and reports a bounded timeout',async()=>{
 const {ctx,emit}=pageFixture();let now=0;ctx.Date=class extends Date{static now(){return now}};ctx.sleep=async ms=>{now+=ms};ctx.document={querySelectorAll:()=>[]};
 emit({type:'ALPHA_ORDER_HISTORY',pageUrl:'https://www.binance.com/en/alpha/bsc/0xbbb',data:{code:'000000',data:[]}});
 await assert.rejects(ctx.readOrderHistory({bindingToken:'t',url:ctx.location.href}),/未找到/);assert.equal(now,12000);
});
test('fetch history hook preserves source page; order metadata excludes credentials',async()=>{
 const listeners=[],messages=[];const window={addEventListener:(_,f)=>listeners.push(f),postMessage:m=>messages.push(m),fetch:async()=>({clone:()=>({json:async()=>({code:'000000',data:[]})})})};
 function xhr(){}xhr.prototype.open=function(){};xhr.prototype.setRequestHeader=function(){};xhr.prototype.send=function(){};
 const location={href:'https://www.binance.com/en/alpha/bsc/0xaaa'};
 const ctx=vm.createContext({window,location,document:{currentScript:{dataset:{alphaInstance:'a',alphaToken:'t'}}},XMLHttpRequest:xhr,console:silent});vm.runInContext(fs.readFileSync('injected.js','utf8'),ctx);
 listeners.forEach(f=>f({source:window,data:{type:'ALPHA_ARM_ORDER',unionId:'attempt',instanceId:'a',token:'t'}}));
 await window.fetch('/bapi/asset/v1/private/alpha-trade/order/place',{body:JSON.stringify({symbol:'ALPHA_772USDT',side:'BUY',price:'1',quantity:'2',csrftoken:'secret',headers:{cookie:'secret'}})});
 const p=window.fetch('/bapi/defi/v1/private/alpha-trade/order/get-order-history-merge?page=1');location.href='https://www.binance.com/en/alpha/bsc/0xbbb';await p;await new Promise(r=>setImmediate(r));
 assert.deepEqual(structuredClone(messages.find(m=>m.type==='ALPHA_ORDER_REQUEST').data),{symbol:'ALPHA_772USDT',side:'BUY',price:'1',quantity:'2'});
 assert.equal(messages.find(m=>m.type==='ALPHA_ORDER_HISTORY').pageUrl,'https://www.binance.com/en/alpha/bsc/0xaaa');
});
