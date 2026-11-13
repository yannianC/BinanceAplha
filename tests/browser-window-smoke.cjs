const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');const fs=require('node:fs');
const path=require('node:path'),os=require('node:os');
const runRoot=fs.mkdtempSync(path.join(os.tmpdir(),'alpha-window-smoke-'));
for(const label of ['A','B'])require('node:child_process').execFileSync(process.execPath,[path.join(__dirname,'../scripts/make-instance.cjs'),path.join(runRoot,label),label]);
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(runRoot,'profile'),{headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || chromium.executablePath(),args:['--host-resolver-rules=MAP www.binance.com 127.0.0.1',`--disable-extensions-except=${runRoot}/A,${runRoot}/B`,`--load-extension=${runRoot}/A,${runRoot}/B`]});
 try {
 const actualOrders=[];
 await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('chrome-extension:')){await route.continue();return;}
  if(url.includes('/alpha-trade/order/place')){actualOrders.push({url,body:route.request().postData()});await route.fulfill({json:{code:'000000',data:{orderId:'mock'}}});return;}
  if(url.startsWith('https://www.binance.com/en/alpha/')){await route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><button class="bn-tab__buySell">买入</button><button class="bn-tab__buySell">卖出</button><button id="bn-tab-LIMIT" class="active">限价</button><input id="limitPrice"><input id="limitAmount"><button class="bn-button__buy" onclick="fetch('/bapi/asset/v1/private/alpha-trade/order/place',{method:'POST',body:JSON.stringify({price:document.getElementById('limitPrice').value,amount:document.getElementById('limitAmount').value})})">买入 AAA</button></body></html>`});return;}
  await route.abort();
 });
 for(let i=0;i<100&&context.serviceWorkers().length<2;i++)await new Promise(r=>setTimeout(r,100));
 const workers=context.serviceWorkers();assert.equal(workers.length,2);
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
  const result=await workers[i].evaluate(()=>handlePageCommand({type:'checkTradeReady',data:{requestId:'ready',chainName:'bsc',address:'0xaaa'}}));if(!result.healthy)console.log('DOMS',await Promise.all(context.pages().filter(p=>p.url().includes('/alpha/bsc/')).map(p=>p.evaluate(()=>({html:document.body.innerHTML,ready:document.readyState,visible:[...document.querySelectorAll('input,button')].map(e=>({id:e.id,visible:!!e.offsetParent}))})))));assert.equal(result.healthy,true,JSON.stringify(result));assert.equal(result.windowId,windows[i].id);
 }
 const results=await Promise.all(workers.map((w,i)=>w.evaluate(async i=>{
  const b=await windowBinding.require();return executeTrade({url:'https://www.binance.com/en/alpha/bsc/0xaaa',price:'1',amount:String(i+1),direction:'Buy',coin:'AAA',unionId:'order-'+i,bindingToken:b.token});
 },i)));
 assert(results.every(r=>r.bnResp===1),JSON.stringify(results));assert.equal(actualOrders.length,2);
 assert.deepEqual(actualOrders.map(x=>JSON.parse(x.body).amount).sort(),['1','2']);
 const refreshed=await workers[0].evaluate(()=>handlePageCommand({type:'refreshTradePage',data:{requestId:'refresh',chainName:'bsc',address:'0xaaa'}}));assert.equal(refreshed.refreshed,true,JSON.stringify(refreshed));assert.equal(refreshed.healthy,true,JSON.stringify(refreshed));
 const tab=await workers[0].evaluate(async()=>{const b=await windowBinding.require();return (await chrome.tabs.query({windowId:b.windowId,url:'https://www.binance.com/*'}))[0]});
 await workers[0].evaluate(({tabId,windowId})=>chrome.tabs.move(tabId,{windowId,index:-1}),{tabId:tab.id,windowId:windows[1].id});
 const denied=await workers[0].evaluate(async tabId=>{try{await windowBinding.authorize(tabId);return false}catch{return true}},tab.id);assert.equal(denied,true);
 await workers[0].evaluate(async()=>chrome.tabs.remove((await windowBinding.require()).markerId));
 const closed=await workers[0].evaluate(async()=>{try{await windowBinding.require();return false}catch{return true}});assert.equal(closed,true);
 console.log('Artifacts:',runRoot);
 console.log('PASS: real Chromium, two distinct extension IDs/windows, ownership conflict, concurrent mocked orders, moved-tab rejection, closed-marker revocation; external requests blocked.');
 await popups[0].screenshot({path:path.join(runRoot,'popup.png')});
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
