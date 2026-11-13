/**
 * 内容脚本
 * 注入到页面中执行操作和监听网络请求
 */

// 存储当前交易的unionId
let activeTrade = null;

console.log('币安Alpha交易助手 - Content Script已加载');

const instanceId = chrome.runtime.id;
let pageBinding = null;
let injectionPromise = null;
function bridgePost(data) {window.postMessage({...data,instanceId,token:pageBinding}, '*');}
async function checkPageAuthority(token = pageBinding) {
  const response = await chrome.runtime.sendMessage({action:'authorizePage',token});
  if(!response?.authorized || (token && response.token !== token)) {
    pageBinding=null;
    throw Error(response?.error || '当前页面未绑定本插件');
  }
  return response;
}
async function activatePage() {
  const response=await checkPageAuthority();
  pageBinding=response.token;
  if(!injectionPromise) injectionPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src=chrome.runtime.getURL('injected.js');
    script.dataset.alphaInstance=instanceId;
    script.dataset.alphaToken=pageBinding;
    script.onload=()=>{script.remove();resolve();};
    script.onerror=()=>{script.remove();injectionPromise=null;reject(Error('回执监听加载失败'));};
    (document.head || document.documentElement).appendChild(script);
  });
  await injectionPromise;
  bridgePost({type:'ALPHA_ENABLE'});
  return {protocol:4,authorized:true};
}
// Unbound copies remain inert and do not install page-world interceptors.
activatePage().catch(()=>{});
async function authorizedClick(element, beforeClick = () => {}) {
  await checkPageAuthority(activeTrade?.token || pageBinding);
  if(activeTrade) {
    if(Date.now()>=activeTrade.deadline)throw Error('订单执行期限已过');
    if(AlphaTrade.assetKey(location.href)!==AlphaTrade.assetKey(activeTrade.url))throw Error('页面币种已变化');
    if(activeTrade.receipt)return false;
  }
  beforeClick();
  element.click();
  return true;
}

/**
 * 监听页面发送的消息（fetch拦截结果）
 */
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.instanceId !== instanceId || !pageBinding || event.data.token !== pageBinding) return;
  
  if (event.data.type === 'ALPHA_HEADERS_CAPTURED') {
    console.log('====== 捕获到私有接口请求头 ======');
    console.log('URL:', event.data.url);
    console.log('字段数:', Object.keys(event.data.headers || {}).length);
    console.log('==================================');

    // 转发到 background script 存储（值不出本机，仅用于重放资产查询）
    try {
      chrome.runtime.sendMessage({
        action: 'alphaHeadersCaptured', token:pageBinding,
        data: {
          url: event.data.url,
          method: event.data.method,
          headers: event.data.headers,
          at: event.data.at
        }
      });
      console.log('✅ 请求头已发送到background script');
    } catch (error) {
      console.warn('⚠️ 转发请求头失败（可能插件已重新加载）:', error.message);
    }
    return;
  }

  if (event.data.type === 'ALPHA_ASSETS_DATA') {
    // 页面自身拉到的资产数据（交易后币安前端自动刷新），转发 background 上报
    try {
      chrome.runtime.sendMessage({
        action: 'alphaAssetsData', token:pageBinding,
        data: {
          url: event.data.url,
          data: event.data.data
        }
      });
    } catch (error) {
      console.warn('⚠️ 转发资产数据失败（可能插件已重新加载）:', error.message);
    }
    return;
  }

  if (event.data.type === 'ALPHA_ORDER_ARMED' && activeTrade && event.data.unionId === activeTrade.id) {
    activeTrade.armed = true;
  }
  if (event.data.type === 'FETCH_RESPONSE' && activeTrade && event.data.unionId === activeTrade.id) {
    activeTrade.receipt = {unionId:activeTrade.unionId, orderData:event.data.data, bnResp:1};
  }
});

/**
 * 监听来自background script的消息
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'activatePage') {
    activatePage().then(sendResponse).catch(e=>sendResponse({protocol:4,authorized:false,error:e.message}));return true;
  }
  if (request.action === 'checkReady') {
    checkPageReady().then(sendResponse).catch(e=>sendResponse({healthy:false,canTrade:false,error:e.message}));return true;
  }
  if (request.action === 'ping') {
    // 响应ping消息，表示content script已就绪
    sendResponse({ success: true, ready: true, protocol:4 });
    return true;
  } else if (request.action === 'executeTrade') {
    executeTradeOnPage(request.data)
      .then(data => sendResponse({ protocol:4, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 保持消息通道打开
  }
});

/**
 * 在页面上执行交易操作
 * @param {Object} tradeInfo - 交易信息
 */
async function executeTradeOnPage(tradeInfo) {
  const {url, price, amount, direction, coin, unionId, deadline:executionDeadline} = tradeInfo;
  if (activeTrade) return AlphaTrade.failure(unionId, 'ORDER_STATUS_UNKNOWN', '页面已有未完成的订单，请核对订单');
  const trade = {id:tradeInfo.attemptId || unionId, unionId, armed:false, receipt:null, clicked:false,token:tradeInfo.bindingToken,deadline:executionDeadline,url};
  activeTrade = trade;
  try {
    if(!pageBinding || pageBinding!==trade.token)throw Error('窗口绑定已变化');
    await checkPageAuthority(trade.token);
    const checkAsset = () => {
      if (!Number.isFinite(executionDeadline) || Date.now() >= executionDeadline) throw Error('订单执行期限已过，禁止继续点击');
      if (AlphaTrade.assetKey(location.href) !== AlphaTrade.assetKey(url)) throw Error('页面币种与订单不符');
    };
    checkAsset();
    await waitForPageReady();
    await clickKnowItButton();
    await clickTradeTab(direction);
    await ensureLimitOrderTab();
    await checkPageAuthority(trade.token);
    await setInputValue('limitPrice', price);
    await checkPageAuthority(trade.token);
    await setInputValue('limitAmount', amount);
    await waitForOrderForm(direction,price,amount);
    trade.formBeforeSubmit = captureOrderForm();
    checkAsset();
    // Arm the interceptor and wait for acknowledgment before allowing a click.
    bridgePost({type:'ALPHA_ARM_ORDER', unionId:trade.id});
    const armDeadline = Date.now()+2000;
    while (!trade.armed && Date.now()<armDeadline) await sleep(25);
    if (!trade.armed) throw Error('订单回执拦截器未就绪，请刷新页面');
    await clickSubmitButton(direction, coin, () => {checkAsset();assertOrderForm(direction,price,amount);trade.clicked=true;});
    await sleep(100);
    // A direct API response ends the dialog wait immediately.
    await clickDialogConfirmButton(trade, checkAsset);
    const deadline = Date.now()+30000;
    while (!trade.receipt && Date.now()<deadline) await sleep(100);
    if (!trade.receipt) throw Error('未收到币安下单回执，请核对订单');
    return attachOrderDiagnostics(trade.receipt,trade);
  } catch (e) {
    return attachOrderDiagnostics(trade.receipt || AlphaTrade.failure(unionId,trade.clicked ? 'ORDER_STATUS_UNKNOWN' : 'EXECUTION_ERROR',e.message),trade);
  } finally {
    bridgePost({type:'ALPHA_DISARM_ORDER',unionId:trade.id});
    activeTrade = null;
  }
}

/**
 * 等待页面准备就绪
 */
async function waitForPageReady() {
  const deadline = Date.now()+15000;
  while (document.readyState !== 'complete') {
    if (Date.now() >= deadline) throw Error('页面加载超时');
    await sleep(100);
  }
}

/**
 * 点击买入或卖出标签
 * 注意：页面上 bn-tab-N id 有多组（行情筛选/买卖方向都用），
 * 必须按 .bn-tab__buySell class + 文本定位，querySelector('#bn-tab-1') 会点到行情筛选页签
 * @param {string} direction - 买卖方向 "Buy" 或 "Sell"
 */
async function clickTradeTab(direction) {
  const wantText = direction === 'Buy' ? '买入' : '卖出';

  const findTab = () => findTradeDirectionTab(direction);

  let tab = findTab();
  const deadline = Date.now() + 10000;
  while (!tab && Date.now() < deadline) {
    await sleep(300);
    tab = findTab();
  }
  if (!tab) {
    throw new Error(`未找到${wantText}标签（.bn-tab__buySell）`);
  }

  console.log(`点击${wantText}标签:`, (tab.textContent || '').trim());
  if(!tab.classList.contains('active'))await authorizedClick(tab);
  const selectedDeadline=Date.now()+3000;
  while (!findTab()?.classList.contains('active')) {
    if(Date.now()>=selectedDeadline)throw Error('买卖方向切换未完成');
    await sleep(100);
  }
}

/**
 * 确保当前是"限价"下单类型（页面上可能停留在即时/止盈止损）
 */
async function ensureLimitOrderTab() {
  const limitTab = document.querySelector('#bn-tab-LIMIT');
  if (limitTab && !limitTab.classList.contains('active')) {
    console.log('当前不是限价单，切换到限价');
    await authorizedClick(limitTab);
  }
  const deadline=Date.now()+3000;
  while(true) {
    const inputs=['limitPrice','limitAmount'].map(id=>document.getElementById(id));
    if(document.getElementById('bn-tab-LIMIT')?.classList.contains('active') &&
        inputs.every(e=>e && e.offsetParent!==null && !e.disabled && !e.readOnly))return;
    if(Date.now()>=deadline)throw Error('限价输入框尚未就绪');
    await waitForFormUpdate();
  }
}

/**
 * 设置input的值
 * @param {string} inputId - input元素的ID
 * @param {string} value - 要设置的值
 */
async function setInputValue(inputId, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  // Bypass React's own value tracker so the input event reaches its form state.
  for (const next of ['', String(value)]) {
    const input = await waitForElement(`#${inputId}`, 10000);
    if(input.disabled || input.readOnly)throw Error('交易输入框不可编辑');
    input.focus();
    nativeSetter.call(input,next);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    input.blur();
    await waitForFormUpdate();
  }
}

// Let controlled inputs commit a render; hidden windows use a timer fallback (subject to browser throttling).
function waitForFormUpdate() {
  return new Promise(resolve=>{
    let frame,timer,done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(frame);resolve();};
    timer=setTimeout(finish,50);
    frame=requestAnimationFrame(finish);
  });
}

function normalizedFormNumber(value) {
  const text=String(value ?? '').replace(/,/g,'').trim();
  if(!/^\d+(?:\.\d+)?$/.test(text))return null;
  const [whole,fraction='']=text.split('.');
  return (whole.replace(/^0+(?=\d)/,'') || '0')+'.'+fraction.replace(/0+$/,'');
}
function findTradeDirectionTab(direction, tabs) {
  tabs = tabs || Array.from(document.querySelectorAll('.bn-tab__buySell')).filter(e=>e.offsetParent!==null);
  const label = direction==='Buy' ? /^(买入|Buy)$/i : /^(卖出|Sell)$/i;
  return tabs.find(e=>label.test((e.textContent || '').trim())) || tabs[direction==='Buy'?0:1];
}
function assertOrderForm(direction,price,amount) {
  const tabs=Array.from(document.querySelectorAll('.bn-tab__buySell')).filter(e=>e.offsetParent!==null);
  const target=findTradeDirectionTab(direction,tabs);
  if(!target || !target.classList.contains('active'))throw Error('买卖方向与指令不符');
  if(!document.getElementById('bn-tab-LIMIT')?.classList.contains('active'))throw Error('限价表单尚未就绪');
  for(const [id,value] of [['limitPrice',price],['limitAmount',amount]]) {
    const input=document.getElementById(id);
    if(!input || input.disabled || input.readOnly || normalizedFormNumber(input.value)===null || normalizedFormNumber(input.value)!==normalizedFormNumber(value))throw Error('表单数值未同步：'+id);
  }
}
async function waitForOrderForm(direction,price,amount) {
  const deadline=Date.now()+3000;let stable=0,lastError;
  while(Date.now()<deadline) {
    try {
      assertOrderForm(direction,price,amount);
      const selector=direction==='Buy'?'button[class*="bn-button__buy"]':'button[class*="bn-button__sell"]';
      if(!Array.from(document.querySelectorAll(selector)).some(e=>e.offsetParent!==null && !e.disabled))throw Error('提交按钮尚未就绪');
      stable++;if(stable>=3)return;
    }
    catch(e){stable=0;lastError=e;}
    await waitForFormUpdate();
  }
  throw lastError || Error('交易表单未稳定');
}
function captureOrderForm() {
  const values={};
  for(const id of ['limitPrice','limitAmount','limitTotal'])values[id]=document.getElementById(id)?.value || '';
  const lines=(document.body?.innerText || '').split(/\n/);
  const balanceHints=[];
  for(let i=0;i<lines.length && balanceHints.length<8;i++) {
    if(/余额|可用|不足|Available|Insufficient|冻结/i.test(lines[i]))balanceHints.push(lines.slice(Math.max(0,i-1),i+3).join(' ').slice(0,200));
  }
  return {at:Date.now(),values,balanceHints};
}
function attachOrderDiagnostics(result,trade) {
  if(String(result?.orderData?.code)==='000000')return result;
  try {result.orderData={...result.orderData,pageDiagnostics:{beforeSubmit:trade.formBeforeSubmit || null,after:captureOrderForm()}};}catch(_){}
  return result;
}

/**
 * 点击提交按钮
 * @param {string} direction - 买卖方向 "Buy" 或 "Sell"
 * @param {string} coin - 币种
 */
async function clickSubmitButton(direction, coin, beforeClick) {
  const buttonClass = direction === 'Buy' ? 'bn-button__buy' : 'bn-button__sell';
  const dirText = direction === 'Buy' ? '买入' : '卖出';

  // 查找所有包含指定class且未禁用的按钮
  const buttons = Array.from(document.querySelectorAll(`button[class*="${buttonClass}"]`))
    .filter(b => !b.disabled && b.offsetParent !== null);

  console.log(`查找class="${buttonClass}"的可用按钮，找到${buttons.length}个`);

  const texts = [];
  for (const button of buttons) {
    const buttonText = (button.textContent || button.innerText || '').trim();
    texts.push(buttonText);

    if (buttonText.includes(coin)) {
      console.log(`找到匹配的按钮，准备点击: "${buttonText}"`);
      await authorizedClick(button,()=>{
        if(button.isConnected===false || button.disabled)throw Error('提交按钮状态已变化');
        beforeClick();
      });
      console.log('按钮已点击');
      return;
    }
  }

  throw new Error(`未找到包含币种"${coin}"的${dirText}按钮。候选按钮: ${texts.join(' | ') || '(无可用按钮)'}`);
}

/**
 * 检查并点击"我知道了"按钮
 */
async function clickKnowItButton() {
  try {
    // 查找所有包含bn-button__primary的按钮
    const buttons = document.querySelectorAll('button[class*="bn-button__primary"]');
    
    for (const button of buttons) {
      const buttonText = (button.textContent || button.innerText).trim();
      
      if (buttonText === '我知道了') {
        console.log('找到"我知道了"按钮，准备点击:', button);
        await sleep(300);
        await authorizedClick(button);
        console.log('"我知道了"按钮已点击');
        await sleep(500); // 等待弹窗关闭
        return;
      }
    }
    
    console.log('未找到"我知道了"按钮，继续执行');
  } catch (error) {
    console.warn('检查"我知道了"按钮时出错:', error);
    // 不抛出错误，继续执行
  }
}

/**
 * 等待并点击确认对话框中的按钮
 * Alpha 下单可能没有二次确认弹窗；未发现弹窗仍须等待真实下单回执。
 * @returns {Promise<boolean>} 是否点到了确认按钮
 */
async function clickDialogConfirmButton(trade, checkAsset) {
  const deadline = Date.now() + 6000;
  const confirmKeywords = ['继续', '确认', '确定', '买入', '卖出'];

  while (Date.now() < deadline) {
    if (trade.receipt) return false;
    checkAsset();
    try {
      const dialogs = Array.from(document.querySelectorAll(
        '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'
      )).filter(d => d.offsetParent !== null && d.offsetHeight > 0);

      for (const dlg of dialogs) {
        const allBtns = Array.from(dlg.querySelectorAll('button')).filter(b => !b.disabled && b.offsetParent !== null);
        // 优先点弹窗里的主按钮（币安确认钮常是"卖出 CT"这类带币种文案，精确匹配不可靠）
        const btn = allBtns.find(b => (b.className || '').includes('bn-button__primary'))
                 || allBtns.find(b => confirmKeywords.some(k => (b.textContent || '').includes(k)));
        if (btn) {
          console.log('找到确认对话框，点击:', (btn.textContent || '').trim(), '|', (btn.className || '').slice(0, 60));
          await sleep(200);
          if (trade.receipt) return false;
          checkAsset();
          await authorizedClick(btn);
          return true;
        }
      }
    } catch (e) {}
    await sleep(300);
  }

  console.log('未出现确认对话框，继续等待真实API回执');
  return false;
}

/**
 * 等待元素出现
 * @param {string} selector - CSS选择器
 * @param {number} timeout - 超时时间（毫秒）
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }
    
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`等待元素"${selector}"超时`));
    }, timeout);
  });
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function checkPageReady() {
  await checkPageAuthority();
  const visible=e=>!!(e && e.offsetParent!==null);
  const inputs=['limitPrice','limitAmount'].map(id=>document.getElementById(id));
  const controls=inputs.every(visible);
  const editable=inputs.every(e=>e && !e.disabled && !e.readOnly);
  const buttons=Array.from(document.querySelectorAll('button[class*="bn-button__buy"],button[class*="bn-button__sell"]')).filter(visible);
  const loginRequired=buttons.some(b=>/登录|Log In|Sign In/i.test(b.textContent || ''));
  const healthy=document.readyState==='complete' && controls && buttons.length>0 && !loginRequired;
  // An empty order form normally disables submit; readiness means it can accept an order.
  return {healthy,canTrade:healthy && editable && !activeTrade,loginRequired,url:location.href,checkedAt:Date.now()};
}
