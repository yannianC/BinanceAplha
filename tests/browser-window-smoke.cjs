const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');const fs=require('node:fs');
const path=require('node:path'),os=require('node:os');
const runRoot=fs.mkdtempSync(path.join(os.tmpdir(),'alpha-window-smoke-'));
for(const label of ['A','B'])require('node:child_process').execFileSync(process.execPath,[path.join(__dirname,'../scripts/make-instance.cjs'),path.join(runRoot,label),label]);
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(runRoot,'profile'),{headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || chromium.executablePath(),args:['--host-resolver-rules=MAP www.binance.com 127.0.0.1',`--disable-extensions-except=${runRoot}/A,${runRoot}/B`,`--load-extension=${runRoot}/A,${runRoot}/B`]});
 try {
 const actualOrders=[];let rejectNext=false;
 await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('chrome-extension:')){await route.continue();return;}
  if(url.includes('/cloud-wallet/alpha')){await route.fulfill({json:{code:'000000',data:{list:[{chainId:'56',contractAddress:'0xaaa',free:String(100-actualOrders.length),freeze:'0'}]}}});return;}
  if(url.includes('/alpha-trade/order/place')){actualOrders.push({at:Date.now(),url,body:route.request().postData()});const code=rejectNext?'INSUFFICIENT_BALANCE':'000000';rejectNext=false;await route.fulfill({json:{code,data:{orderId:'mock'}}});return;}
  if(/^https:\/\/www\.binance\.com\/(?:en|zh-CN)\/alpha\//.test(url)){await route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><body><button class="bn-tab__buySell active" onclick="document.querySelectorAll('.bn-tab__buySell').forEach(t=>t.classList.remove('active'));this.classList.add('active')">买入</button><button class="bn-tab__buySell" onclick="document.querySelectorAll('.bn-tab__buySell').forEach(t=>t.classList.remove('active'));this.classList.add('active')">卖出</button><button id="bn-tab-LIMIT" class="active">限价</button><input id="limitPrice"><input id="limitAmount"><button class="bn-button__buy" onclick="fetch('/bapi/asset/v1/private/alpha-trade/order/place',{method:'POST',body:JSON.stringify({price:window.formValues.limitPrice,amount:window.formValues.limitAmount})}).then(()=>fetch('/bapi/defi/v1/private/wallet-direct/cloud-wallet/alpha'))">买入 AAA</button><script>window.formValues={};for(const id of ['limitPrice','limitAmount']){const e=document.getElementById(id),d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');let tracked=e.value;window.formValues[id]=tracked;Object.defineProperty(e,'value',{get(){return d.get.call(this)},set(v){tracked=String(v);d.set.call(this,v)}});e.addEventListener('input',()=>{if(e.value!==tracked){tracked=e.value;window.formValues[id]=e.value}})}</script></body></html>`});return;}
  await route.abort();
 });
 for(let i=0;i<100&&context.serviceWorkers().length<2;i++)await new Promise(r=>setTimeout(r,100));
 const workers=context.serviceWorkers();assert.equal(workers.length,2);
 for(const worker of workers)await worker.evaluate(()=>{globalThis.protocolReplies=[];ws={readyState:1,send:text=>protocolReplies.push(JSON.parse(text))};});
 const windows=[];
 for(const w of workers){const pageEvent=context.waitForEvent('page');windows.push(await w.evaluate(()=>chrome.windows.create({url:'about:blank',type:'normal'})));const p=await pageEvent;await p.goto('https://www.binance.com/en/alpha/bsc/0xaaa');}
 const popups=[];
 for(let i=0;i<2;i++){
  const id=new URL(workers[i].url()).host,p=await context.newPage();await p.goto('chrome-extension://'+id+'/popup.html');popups.push(p);
  if(i===1){const conflict=await p.evaluate(windowId=>chrome.runtime.sendMessage({action:'bindWindow',windowId}),windows[0].id);assert.match(conflict.error,/其他插件/);}
  const result=await p.evaluate(windowId=>chrome.runtime.sendMessage({action:'bindWindow',windowId}),windows[i].id);if(!result.success)console.log('TABS',await workers[i].evaluate(()=>chrome.tabs.query({})));assert.equal(result.success,true,JSON.stringify(result));
 }
 const conflict=await popups[1].evaluate(windowId=>chrome.runtime.sendMessage({action:'bindWindow',windowId}),windows[0].id);assert(conflict.error);
 for(let i=0;i<2;i++){
  console.log('ACTIVATE',await workers[i].evaluate(async()=>{const b=await windowBinding.require();const t=(await chrome.tabs.query({windowId:b.windowId,url:'https://www.binance.com/*'}))[0];return chrome.tabs.sendMessage(t.id,{action:'activatePage'});}));
  const result=await workers[i].evaluate(()=>handleWebSocketMessage({type:'ready',data:{chainName:'bsc',address:'0xaaa'}}));if(!result.healthy)console.log('DOMS',await Promise.all(context.pages().filter(p=>p.url().includes('/alpha/bsc/')).map(p=>p.evaluate(()=>({html:document.body.innerHTML,ready:document.readyState,visible:[...document.querySelectorAll('input,button')].map(e=>({id:e.id,visible:!!e.offsetParent}))})))));assert.equal(result.healthy,true,JSON.stringify(result));assert.equal(result.windowId,windows[i].id);assert.deepEqual(await workers[i].evaluate(()=>protocolReplies),[{type:'isready'}]);
 }
 for(const p of context.pages().filter(p=>p.url().includes('/alpha/bsc/')))await p.evaluate(()=>fetch('/bapi/defi/v1/private/wallet-direct/cloud-wallet/alpha'));
 for(const w of workers){for(let i=0;i<100 && !(await w.evaluate(()=>assetReadiness.key!==null));i++)await new Promise(r=>setTimeout(r,50));assert(await w.evaluate(()=>assetReadiness.key!==null));}
 const initialDispatchAt=Date.now();
 await Promise.all(workers.map((w,i)=>w.evaluate(async i=>enqueueOrder({chainName:'bsc',address:'0xaaa',price:'1',amt:String(i+1),symbol:'AAA',unionId:'order-'+i}),i)));
 for(const w of workers){
  for(let i=0;i<100 && (await w.evaluate(()=>protocolReplies.filter(m=>m.type==='isready').length))<2;i++)await new Promise(r=>setTimeout(r,50));
  const replies=await w.evaluate(()=>protocolReplies);
  assert.equal(replies.filter(m=>m.type==='orderResult' && m.data.bnResp===1).length,1,JSON.stringify(replies));
  assert.equal(replies.filter(m=>m.type==='isready').length,2,JSON.stringify(replies));
 }
 assert.equal(actualOrders.length,2);
 console.log('DISPATCH_TO_REQUEST_MS',actualOrders.map(o=>o.at-initialDispatchAt));
 assert.deepEqual(actualOrders.map(x=>JSON.parse(x.body).amount).sort(),['1','2']);
 rejectNext=true;
 await workers[0].evaluate(()=>enqueueOrder({chainName:'bsc',address:'0xaaa',price:'1',amt:'3',symbol:'AAA',unionId:'order-0'}));
 const failure=await workers[0].evaluate(()=>protocolReplies.filter(m=>m.type==='orderResult').at(-1));assert.equal(failure.data.orderData.code,'INSUFFICIENT_BALANCE');assert.equal(failure.data.orderData.pageDiagnostics.beforeSubmit.values.limitAmount,'3');
 await workers[0].evaluate(()=>enqueueOrder({chainName:'bsc',address:'0xaaa',price:'1',amt:'4',symbol:'AAA',unionId:'order-0'}));
 const retried=await workers[0].evaluate(()=>protocolReplies.filter(m=>m.type==='orderResult').at(-1));assert.equal(retried.data.orderData.code,'000000');assert.equal(actualOrders.length,4);assert.equal(JSON.parse(actualOrders.at(-1).body).amount,'4');
 for(let i=0;i<100 && (await workers[0].evaluate(()=>protocolReplies.filter(m=>m.type==='isready').length))<3;i++)await new Promise(r=>setTimeout(r,50));
 assert.equal(await workers[0].evaluate(()=>protocolReplies.filter(m=>m.type==='isready').length),3);
 const beforeRefresh=await workers[0].evaluate(()=>protocolReplies.length);
 const refreshed=await workers[0].evaluate(()=>handleWebSocketMessage({type:'refresh',data:{chainName:'bsc',address:'0xaaa'}}));assert.equal(refreshed.refreshed,true,JSON.stringify(refreshed));assert.equal(refreshed.healthy,true,JSON.stringify(refreshed));assert.equal(await workers[0].evaluate(()=>protocolReplies.length),beforeRefresh+1);
 // Both instances can prepare a coin absent from their own window.
 for(let i=0;i<2;i++){
  const count=await workers[i].evaluate(()=>protocolReplies.length);
  // Attach the test interceptor before the initial navigation of an extension-created tab.
  await workers[i].evaluate(()=>{globalThis.testNavigationDone=false;globalThis.originalCreate=chrome.tabs.create;chrome.tabs.create=async options=>{const tab=await originalCreate({...options,url:'about:blank'});while(!testNavigationDone)await new Promise(r=>setTimeout(r,10));return chrome.tabs.get(tab.id);};});
  const newPageEvent=context.waitForEvent('page');
  const preparing=workers[i].evaluate(()=>handleWebSocketMessage({type:'ready',data:{chainName:'bsc',address:'0xbbb'}}));
  const opened=await newPageEvent;await opened.goto('https://www.binance.com/zh-CN/alpha/bsc/0xbbb');
  await workers[i].evaluate(()=>{testNavigationDone=true;chrome.tabs.create=originalCreate;});
  const prepared=await preparing;
  assert.equal(prepared.canTrade,true,JSON.stringify(prepared));assert.equal(prepared.windowId,windows[i].id);
  assert.equal(await workers[i].evaluate(()=>protocolReplies.length),count+1);
  const own=await workers[i].evaluate(async()=>{const b=await windowBinding.require();return (await chrome.tabs.query({windowId:b.windowId})).filter(t=>t.url.includes('/0xbbb')).length});assert.equal(own,1);
 }
 await popups[0].waitForFunction(()=>document.getElementById('readinessInfo').textContent.includes('已回复 isready'));
 console.log('PASS ready switches both bound windows to missing coin and popup confirms reply');
 const tab=await workers[0].evaluate(async()=>{const b=await windowBinding.require();return (await chrome.tabs.query({windowId:b.windowId,url:'https://www.binance.com/*'}))[0]});
 await workers[0].evaluate(({tabId,windowId})=>chrome.tabs.move(tabId,{windowId,index:-1}),{tabId:tab.id,windowId:windows[1].id});
 const denied=await workers[0].evaluate(async tabId=>{try{await windowBinding.authorize(tabId);return false}catch{return true}},tab.id);assert.equal(denied,true);
 await workers[0].evaluate(async()=>chrome.tabs.remove((await windowBinding.require()).markerId));
 const closed=await workers[0].evaluate(async()=>{try{await windowBinding.require();return false}catch{return true}});assert.equal(closed,true);
 console.log('Artifacts:',runRoot);
 console.log('PASS: real Chromium, two distinct extension IDs/windows, ownership conflict, concurrent mocked orders, automatic post-asset readiness, moved-tab rejection, closed-marker revocation; external requests blocked.');
 await popups[0].screenshot({path:path.join(runRoot,'popup.png')});
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
