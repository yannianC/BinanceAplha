/**
 * 内容脚本
 * 注入到页面中执行操作和监听网络请求
 */

// 存储当前交易的unionId
let currentUnionId = null;

console.log('币安Alpha交易助手 - Content Script已加载');

// 只注入一次拦截脚本
if (!window.__INTERCEPTOR_INJECTED__) {
  window.__INTERCEPTOR_INJECTED__ = true;
  injectInterceptorScript();
}

/**
 * 注入拦截脚本到页面
 */
function injectInterceptorScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function() {
    console.log('✅ 拦截脚本已通过script标签加载');
    this.remove();
  };
  script.onerror = function() {
    console.error('❌ 拦截脚本加载失败');
  };
  (document.head || document.documentElement).appendChild(script);
}

/**
 * 监听页面发送的消息（fetch拦截结果）
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  
  if (event.data.type === 'ALPHA_HEADERS_CAPTURED') {
    console.log('====== 捕获到私有接口请求头 ======');
    console.log('URL:', event.data.url);
    console.log('字段数:', Object.keys(event.data.headers || {}).length);
    console.log('==================================');

    // 转发到 background script 存储（值不出本机，仅用于重放资产查询）
    try {
      chrome.runtime.sendMessage({
        action: 'alphaHeadersCaptured',
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
        action: 'alphaAssetsData',
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

  if (event.data.type === 'FETCH_RESPONSE') {
    console.log('====== 拦截到API响应 ======');
    console.log('URL:', event.data.url);
    console.log('返回数据:', JSON.stringify(event.data.data, null, 2));
    console.log('UnionId:', currentUnionId);
    console.log('===========================');
    
    // 将结果发送到background script（成功获取到API返回）
    try {
      chrome.runtime.sendMessage({
        action: 'tradeResult',
        data: {
          orderData: event.data.data,
          unionId: currentUnionId,
          bnResp: 1  // 系统返回
        }
      });
      console.log('✅ 结果已发送到background script');
    } catch (error) {
      console.warn('⚠️ 发送到background失败（可能插件已重新加载）:', error.message);
    }
    
    // 清空unionId
    currentUnionId = null;
  }
});

/**
 * 监听来自background script的消息
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    // 响应ping消息，表示content script已就绪
    sendResponse({ success: true, ready: true });
    return true;
  } else if (request.action === 'executeTrade') {
    executeTradeOnPage(request.data)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 保持消息通道打开
  }
});

/**
 * 在页面上执行交易操作
 * @param {Object} tradeInfo - 交易信息
 */
async function executeTradeOnPage(tradeInfo) {
  const { url, price, amount, direction, coin, unionId } = tradeInfo;
  
  console.log('开始执行交易:', tradeInfo);
  
  // 保存unionId
  currentUnionId = unionId;
  
  try {
    // 1. 检查页面URL是否匹配
    if (window.location.href !== url) {
      console.log('URL不匹配，等待页面跳转...');
      // URL会由background script处理跳转
      
      // 发送错误结果
      sendErrorResult('URL_MISMATCH', '页面URL不匹配，等待跳转', unionId);
      return { status: 'url_mismatch', message: '等待页面跳转' };
    }
    
    // 2. 等待页面完全加载
    await waitForPageReady();
    
    // 3. 检查并点击"我知道了"按钮（如果存在）
    await clickKnowItButton();
    
    // 4. 点击买入或卖出标签（.bn-tab__buySell，页面上bn-tab-N有多组会重名）
    await clickTradeTab(direction);

    // 4.5 确保是"限价"下单类型（#bn-tab-LIMIT），否则价格/数量输入框不生效
    await ensureLimitOrderTab();

    // 5. 等待一下让UI更新
    await sleep(500);
    
    // 6. 设置价格
    await setInputValue('limitPrice', price);
    
    // 7. 设置数量
    await setInputValue('limitAmount', amount);
    
    // 8. 等待一下让值生效
    await sleep(300);
    
    // 9. 查找并点击提交按钮
    await clickSubmitButton(direction, coin);
    
    // 10. 等待确认对话框出现
    await sleep(500);
    
    // 11. 再次检查并点击"我知道了"按钮（如果存在）
    await clickKnowItButton();
    
    // 12. 等待确认对话框：出现则点确认；6秒没有弹窗说明已直接提交，不报错（避免成功单被误报失败导致重复下单）
    console.log('等待确认对话框（若有）...');
    await clickDialogConfirmButton();

    console.log('交易操作执行完成，等待API响应...');
    return { status: 'success', message: '交易指令已提交' };
    
  } catch (error) {
    console.error('执行交易失败:', error);
    
    // 发送错误结果
    sendErrorResult('EXECUTION_ERROR', error.message, unionId);
    
    return { status: 'error', message: error.message };
  }
}

/**
 * 发送错误结果到background script
 * @param {string} code - 错误代码
 * @param {string} message - 错误信息
 * @param {string} unionId - 关联ID
 */
function sendErrorResult(code, message, unionId) {
  try {
    chrome.runtime.sendMessage({
      action: 'tradeResult',
      data: {
        orderData: {
          code: code,
          message: message
        },
        unionId: unionId,
        bnResp: 0  // 用户自己构建
      }
    });
  } catch (error) {
    console.warn('⚠️ 发送错误结果失败:', error.message);
  }
}

/**
 * 等待页面准备就绪
 */
function waitForPageReady() {
  return new Promise((resolve) => {
    if (document.readyState === 'complete') {
      resolve();
    } else {
      window.addEventListener('load', resolve);
    }
  });
}

/**
 * 点击买入或卖出标签
 * 注意：页面上 bn-tab-N id 有多组（行情筛选/买卖方向都用），
 * 必须按 .bn-tab__buySell class + 文本定位，querySelector('#bn-tab-1') 会点到行情筛选页签
 * @param {string} direction - 买卖方向 "Buy" 或 "Sell"
 */
async function clickTradeTab(direction) {
  const wantText = direction === 'Buy' ? '买入' : '卖出';

  const findTab = () => {
    const tabs = Array.from(document.querySelectorAll('.bn-tab__buySell'));
    return tabs.find(t => (t.textContent || '').trim() === wantText)
        || tabs[direction === 'Buy' ? 0 : 1];
  };

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
  tab.click();
}

/**
 * 确保当前是"限价"下单类型（页面上可能停留在即时/止盈止损）
 */
async function ensureLimitOrderTab() {
  const limitTab = document.querySelector('#bn-tab-LIMIT');
  if (limitTab && !limitTab.classList.contains('active')) {
    console.log('当前不是限价单，切换到限价');
    limitTab.click();
    await sleep(300);
  }
}

/**
 * 设置input的值
 * @param {string} inputId - input元素的ID
 * @param {string} value - 要设置的值
 */
async function setInputValue(inputId, value) {
  const input = await waitForElement(`#${inputId}`, 10000);
  
  console.log(`设置${inputId}的值为:`, value);
  
  // 清空原有值
  input.value = '';
  
  // 触发focus事件
  input.focus();
  
  // 设置新值
  input.value = value;
  
  // 触发input和change事件以确保React等框架能检测到变化
  const inputEvent = new Event('input', { bubbles: true, cancelable: true });
  const changeEvent = new Event('change', { bubbles: true, cancelable: true });
  input.dispatchEvent(inputEvent);
  input.dispatchEvent(changeEvent);
  
  // 触发blur事件
  input.blur();
}

/**
 * 点击提交按钮
 * @param {string} direction - 买卖方向 "Buy" 或 "Sell"
 * @param {string} coin - 币种
 */
async function clickSubmitButton(direction, coin) {
  const buttonClass = direction === 'Buy' ? 'bn-button__buy' : 'bn-button__sell';
  const dirText = direction === 'Buy' ? '买入' : '卖出';

  // 查找所有包含指定class且未禁用的按钮
  const buttons = Array.from(document.querySelectorAll(`button[class*="${buttonClass}"]`))
    .filter(b => !b.disabled);

  console.log(`查找class="${buttonClass}"的可用按钮，找到${buttons.length}个`);

  const texts = [];
  for (const button of buttons) {
    const buttonText = (button.textContent || button.innerText || '').trim();
    texts.push(buttonText);

    if (buttonText.includes(coin)) {
      console.log(`找到匹配的按钮，准备点击: "${buttonText}"`);
      await sleep(200);
      button.click();
      console.log('按钮已点击');
      return;
    }
  }

  // 兜底：代币专属页通常只有一个买/卖按钮，币种文本没匹配上时直接点唯一可用按钮
  const visible = buttons.filter(b => b.offsetParent !== null);
  if (visible.length === 1) {
    console.log(`未匹配到币种"${coin}"，使用唯一${dirText}按钮:`, (visible[0].textContent || '').trim());
    await sleep(200);
    visible[0].click();
    console.log('按钮已点击（兜底）');
    return;
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
        button.click();
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
 * Alpha 下单可能没有二次确认弹窗：6秒内没等到就按"已直接提交"处理，返回 false
 * @returns {Promise<boolean>} 是否点到了确认按钮
 */
async function clickDialogConfirmButton() {
  const deadline = Date.now() + 6000;
  const confirmKeywords = ['继续', '确认', '确定', '买入', '卖出'];

  while (Date.now() < deadline) {
    try {
      const dialogs = Array.from(document.querySelectorAll(
        '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'
      )).filter(d => d.offsetParent !== null && d.offsetHeight > 0);

      for (const dlg of dialogs) {
        const allBtns = Array.from(dlg.querySelectorAll('button')).filter(b => !b.disabled);
        // 优先点弹窗里的主按钮（币安确认钮常是"卖出 CT"这类带币种文案，精确匹配不可靠）
        const btn = allBtns.find(b => (b.className || '').includes('bn-button__primary'))
                 || allBtns.find(b => confirmKeywords.some(k => (b.textContent || '').includes(k)));
        if (btn) {
          console.log('找到确认对话框，点击:', (btn.textContent || '').trim(), '|', (btn.className || '').slice(0, 60));
          await sleep(200);
          btn.click();
          return true;
        }
      }
    } catch (e) {}
    await sleep(300);
  }

  console.log('6秒内未出现确认对话框，按已直接提交处理');
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

