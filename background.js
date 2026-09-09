/**
 * 后台服务脚本
 * 处理WebSocket连接和消息分发
 */

let ws = null;
let tradingTabId = null;
let wsUrl = 'ws://localhost:8080'; // 默认WebSocket地址，后续可以配置
let heartbeatTimer = null; // 心跳定时器
let heartbeatCheckTimer = null; // 心跳检查定时器
let lastHeartbeatTime = null; // 上次收到心跳响应的时间

// ============ 持有资产查询（cloud-wallet/alpha）============
// 资产接口地址
const ALPHA_ASSETS_URL = 'https://www.binance.com/bapi/defi/v1/private/wallet-direct/cloud-wallet/alpha';
// 捕获到的请求头（内存缓存，随 service worker 休眠清空，所以同时存 storage）
let alphaHeadersCache = null;

/**
 * 重放时不能手动设置的头（浏览器自动管理或 fetch 禁止）
 */
const REPLAY_HEADER_BLOCKLIST = new Set([
  'cookie', 'host', 'connection', 'content-length', 'origin', 'referer',
  'accept-encoding', 'user-agent', 'priority',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'
]);

/**
 * 把捕获的请求头过滤成可重放的头
 */
function buildReplayHeaders(captured) {
  const out = {};
  if (!captured) return out;
  Object.keys(captured).forEach((name) => {
    const lower = name.toLowerCase();
    if (REPLAY_HEADER_BLOCKLIST.has(lower)) return;
    if (lower.startsWith('sec-')) return;
    out[name] = captured[name];
  });
  return out;
}

/**
 * 保存捕获到的请求头（内存 + storage）
 */
function saveAlphaHeaders(record) {
  alphaHeadersCache = record;
  try {
    chrome.storage.local.set({ alphaHeaders: record });
  } catch (e) {
    console.warn('保存请求头到storage失败:', e);
  }
}

/**
 * 读取捕获到的请求头（先内存后storage）
 */
async function loadAlphaHeaders() {
  if (alphaHeadersCache && alphaHeadersCache.headers) return alphaHeadersCache;
  try {
    const result = await chrome.storage.local.get(['alphaHeaders']);
    if (result.alphaHeaders && result.alphaHeaders.headers) {
      alphaHeadersCache = result.alphaHeaders;
      return alphaHeadersCache;
    }
  } catch (e) {
    console.warn('读取storage中的请求头失败:', e);
  }
  return null;
}

/**
 * 重放资产查询请求，获取持有资产
 * 返回 { ok, status, data }
 */
async function refreshAssets() {
  const record = await loadAlphaHeaders();

  if (!record || !record.headers || Object.keys(record.headers).length === 0) {
    return {
      ok: false,
      status: 0,
      data: {
        code: 'NO_HEADERS',
        message: '尚未捕获到资产接口请求头，请先打开/刷新币安Alpha页面，让页面自己发一次该请求'
      }
    };
  }

  const replayHeaders = buildReplayHeaders(record.headers);
  console.log(`重放资产查询，使用 ${Object.keys(replayHeaders).length} 个头（捕获于 ${new Date(record.at || 0).toLocaleTimeString()}）`);

  try {
    const response = await fetch(ALPHA_ASSETS_URL, {
      method: record.method && record.method !== 'GET' ? record.method : 'GET',
      credentials: 'include',  // 自动携带登录cookie
      headers: replayHeaders
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { code: 'PARSE_ERROR', message: '响应不是JSON', raw: text.slice(0, 500) };
    }

    return { ok: response.ok, status: response.status, data: data };
  } catch (error) {
    console.error('重放资产查询失败:', error);
    return {
      ok: false,
      status: 0,
      data: { code: 'REPLAY_ERROR', message: error.message }
    };
  }
}

/**
 * 通过 WebSocket 上报资产结果
 */
function sendAssetsResult(assetsData, unionId, bnResp) {
  const response = {
    type: 'assetsResult',
    data: {
      assetsData: assetsData,
      unionId: unionId,
      bnResp: bnResp  // 0=插件自己构建的错误，1=币安返回
    }
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
    console.log('已发送资产结果到WebSocket, unionId:', unionId);
    return true;
  } else {
    console.warn('WebSocket未连接，资产结果未发送');
    return false;
  }
}

/**
 * 处理刷新资产请求（来自WS或popup测试）
 */
async function handleRefreshAssets(unionId) {
  const result = await refreshAssets();
  if (result.ok) {
    sendAssetsResult(result.data, unionId, 1);
  } else {
    sendAssetsResult(result.data, unionId, 0);
  }
  return result;
}

/**
 * webRequest 兜底捕获：能拿到完整真实请求头（含cookie），作为 injected.js 捕获的备份
 */
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const headers = {};
        (details.requestHeaders || []).forEach((h) => {
          headers[h.name] = h.value;
        });
        if (Object.keys(headers).length > 0) {
          saveAlphaHeaders({
            url: details.url,
            method: details.method,
            headers: headers,
            at: Date.now(),
            source: 'webRequest'
          });
          console.log('webRequest兜底捕获到资产接口请求头，字段数:', Object.keys(headers).length);
        }
      } catch (e) {}
    },
    { urls: ['https://www.binance.com/bapi/defi/v1/private/wallet-direct/cloud-wallet/alpha*'] },
    ['requestHeaders']
  );
  console.log('webRequest兜底捕获已注册');
} catch (e) {
  console.warn('注册webRequest捕获失败:', e);
}

/**
 * 连接WebSocket服务器
 */
function connectWebSocket() {
  try {
    // 清除旧的心跳定时器
    clearHeartbeat();

    // 关闭旧连接：先摘掉回调，防止旧连接的事件误杀新连接心跳、或安排多余的重连
    if (ws) {
      try {
        const old = ws;
        old.onopen = null;
        old.onmessage = null;
        old.onerror = null;
        old.onclose = null;
        old.close();
      } catch (e) {}
      ws = null;
    }

    // 用局部变量持有本次连接，事件触发时校验身份，陈旧连接的事件一律忽略
    const sock = new WebSocket(wsUrl);
    ws = sock;

    sock.onopen = () => {
      if (sock !== ws) return;
      console.log('WebSocket连接已建立');
      // 启动心跳机制
      startHeartbeat();
      // 连接建立后，如已捕获到请求头，主动查询并上报一次持有资产
      loadAlphaHeaders().then((record) => {
        if (sock !== ws) return;
        if (record && record.headers && Object.keys(record.headers).length > 0) {
          console.log('连接建立，主动刷新一次持有资产...');
          handleRefreshAssets('startup');
        } else {
          console.log('尚无捕获的请求头，跳过启动资产刷新（打开币安Alpha页面后会自动捕获）');
        }
      });
    };

    sock.onmessage = (event) => {
      if (sock !== ws) return;
      console.log('收到WebSocket消息:', event.data);

      // 先判断是否是心跳响应（字符串 'pong'）
      if (event.data === 'pong') {
        lastHeartbeatTime = Date.now();
        console.log('收到心跳响应: pong');
        return;
      }

      // 尝试解析JSON消息
      try {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
      } catch (error) {
        console.error('解析WebSocket消息失败:', error);
      }
    };

    sock.onerror = (error) => {
      if (sock !== ws) return;
      console.error('WebSocket错误:', error);
    };

    sock.onclose = (event) => {
      if (sock !== ws) return; // 陈旧连接关闭：不杀新连接心跳，也不安排重连
      console.log('===== WebSocket连接已关闭 =====');
      console.log('关闭代码:', event.code);
      console.log('关闭原因:', event.reason || '无');
      console.log('是否正常关闭:', event.wasClean);
      console.log('关闭类型说明:', getCloseCodeDescription(event.code));
      console.log('5秒后自动重连...');
      console.log('================================');

      clearHeartbeat();
      setTimeout(connectWebSocket, 5000);
    };
  } catch (error) {
    console.error('连接WebSocket失败:', error);
    clearHeartbeat();
    setTimeout(connectWebSocket, 5000);
  }
}

/**
 * 启动心跳机制
 */
function startHeartbeat() {
  // 幂等：先清掉可能残留的旧定时器，防止叠加
  clearHeartbeat();

  // 初始化最后心跳时间
  lastHeartbeatTime = Date.now();
  
  // 每5秒发送一次心跳
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('ping');
      console.log('发送心跳: ping');
    }
  }, 5000);
  
  // 每5秒检查一次是否超时（30秒未收到响应）
  heartbeatCheckTimer = setInterval(() => {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - lastHeartbeatTime;
    
    if (timeSinceLastHeartbeat > 30000) {
      console.log('心跳超时（超过30秒未响应），断开连接...');
      if (ws) {
        ws.close();
      }
    }
  }, 5000);
}

/**
 * 清除心跳定时器
 */
function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
  }
  
  lastHeartbeatTime = null;
}

/**
 * 获取WebSocket关闭代码的描述
 * @param {number} code - 关闭代码
 * @returns {string} 关闭代码的描述
 */
function getCloseCodeDescription(code) {
  const descriptions = {
    1000: '正常关闭',
    1001: '终端离开（浏览器标签页关闭或离开页面）',
    1002: '协议错误',
    1003: '收到不支持的数据类型',
    1005: '未收到关闭代码（保留）',
    1006: '连接异常关闭（没有发送关闭帧）',
    1007: '收到的数据类型不一致',
    1008: '收到违反政策的消息',
    1009: '收到过大的消息',
    1010: '客户端期望协商扩展，但服务器未响应',
    1011: '服务器遇到意外情况',
    1012: '服务器正在重启',
    1013: '服务器临时过载，稍后再试',
    1015: 'TLS握手失败（保留）'
  };
  
  return descriptions[code] || `未知关闭代码: ${code}`;
}

/**
 * 处理接收到的WebSocket消息
 * @param {Object} message - WebSocket消息对象
 */
function handleWebSocketMessage(message) {
  // 消息格式示例:
  // {
  //   "type": "order",
  //   "data": {
  //     "chainName": "bsc",
  //     "address": "0xaafe1f781bc5e4d240c4b73f6748d76079678fa8",
  //     "amt": "120.5",
  //     "symbol": "GAIX",
  //     "price": "0.0234",
  //     "unionId": "xxxxxxxx"
  //   }
  // }
  
  // 刷新持有资产指令:
  // { "type": "refreshAssets", "data": { "unionId": "xxxxxxxx" } }
  if (message.type === 'refreshAssets') {
    const unionId = (message.data && message.data.unionId) || '';
    console.log('收到刷新资产指令, unionId:', unionId);
    handleRefreshAssets(unionId);
    return;
  }

  if (message.type === 'order' && message.data) {
    const { chainName, address, amt, symbol, price, unionId } = message.data;
    
    if (chainName && address && amt && symbol && price && unionId) {
      // 构建URL
      const url = `https://www.binance.com/zh-CN/alpha/${chainName}/${address}`;
      
      // 根据amt的正负判断买卖方向
      const direction = parseFloat(amt) > 0 ? 'Buy' : 'Sell';
      const amount = Math.abs(parseFloat(amt)).toString();
      
      executeTrade({
        url,
        price,
        amount,
        direction,
        coin: symbol,
        unionId
      });
    }
  }
}

/**
 * 执行交易操作
 * @param {Object} tradeInfo - 交易信息
 */
async function executeTrade(tradeInfo) {
  try {
    // 先查找是否已有匹配URL的标签页
    const existingTab = await findTabByUrl(tradeInfo.url);
    
    if (existingTab) {
      console.log(`找到已存在的标签页 ${existingTab.id}，直接使用`);
      tradingTabId = existingTab.id;
      
      // 如果标签页没有完全加载，等待加载
      if (existingTab.status !== 'complete') {
        await waitForTabLoaded(tradingTabId);
      }
    } else if (!tradingTabId) {
      // 没有交易标签页，创建新标签页
      console.log('没有匹配的标签页，创建新标签页');
      const tab = await chrome.tabs.create({ url: tradeInfo.url, active: false });
      tradingTabId = tab.id;
      
      // 监听标签页关闭事件
      chrome.tabs.onRemoved.addListener((tabId) => {
        if (tabId === tradingTabId) {
          tradingTabId = null;
        }
      });
      
      // 等待标签页加载完成
      await waitForTabLoaded(tradingTabId);
    } else {
      // 检查标签页是否存在
      try {
        const tab = await chrome.tabs.get(tradingTabId);
        // 检查URL是否匹配
        if (tab.url !== tradeInfo.url) {
          console.log(`URL不匹配，关闭标签页${tradingTabId}并创建新标签页`);
          console.log(`当前URL: ${tab.url}`);
          console.log(`目标URL: ${tradeInfo.url}`);
          
          // 关闭当前标签页
          await chrome.tabs.remove(tradingTabId);
          tradingTabId = null;
          
          // 再次检查是否有其他匹配的标签页
          const newExistingTab = await findTabByUrl(tradeInfo.url);
          if (newExistingTab) {
            console.log(`关闭旧标签页后，找到已存在的匹配标签页 ${newExistingTab.id}`);
            tradingTabId = newExistingTab.id;
            if (newExistingTab.status !== 'complete') {
              await waitForTabLoaded(tradingTabId);
            }
          } else {
            // 创建新的标签页
            const newTab = await chrome.tabs.create({ url: tradeInfo.url, active: false });
            tradingTabId = newTab.id;
            
            // 等待新标签页加载完成
            await waitForTabLoaded(tradingTabId);
          }
        }
      } catch (error) {
        // 标签页不存在，查找或创建新的
        console.log('标签页不存在，查找或创建新标签页');
        const newExistingTab = await findTabByUrl(tradeInfo.url);
        if (newExistingTab) {
          console.log(`找到已存在的匹配标签页 ${newExistingTab.id}`);
          tradingTabId = newExistingTab.id;
          if (newExistingTab.status !== 'complete') {
            await waitForTabLoaded(tradingTabId);
          }
        } else {
          const tab = await chrome.tabs.create({ url: tradeInfo.url, active: false });
          tradingTabId = tab.id;
          await waitForTabLoaded(tradingTabId);
        }
      }
    }
    
    // 切换到交易标签页
    await chrome.tabs.update(tradingTabId, { active: true });
    console.log(`已切换到标签页 ${tradingTabId}`);
    
    // 等待一下确保标签页激活和content script准备好
    await sleep(500);
    
    // 确保content script已加载
    await ensureContentScriptLoaded(tradingTabId);
    
    // 向content script发送交易指令
    await chrome.tabs.sendMessage(tradingTabId, {
      action: 'executeTrade',
      data: tradeInfo
    });
    
  } catch (error) {
    console.error('执行交易失败:', error);
  }
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 确保content script已加载到标签页
 * @param {number} tabId - 标签页ID
 */
async function ensureContentScriptLoaded(tabId) {
  const maxRetries = 10;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      // 尝试发送ping消息
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      console.log('Content script已就绪');
      return;
    } catch (error) {
      retries++;
      console.log(`等待content script加载... (${retries}/${maxRetries})`);
      
      if (retries >= maxRetries) {
        console.log('Content script未响应，尝试手动注入...');
        // 手动注入content script
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content.js']
          });
          console.log('Content script已手动注入');
          await sleep(500);
          return;
        } catch (injectError) {
          console.error('注入content script失败:', injectError);
          throw new Error('无法加载content script');
        }
      }
      
      await sleep(500);
    }
  }
}

/**
 * 查找匹配URL的标签页
 * @param {string} url - 要查找的URL
 * @returns {Promise<chrome.tabs.Tab|null>} 找到的标签页或null
 */
async function findTabByUrl(url) {
  try {
    const tabs = await chrome.tabs.query({});
    
    // 查找完全匹配的标签页
    for (const tab of tabs) {
      if (tab.url === url) {
        return tab;
      }
    }
    
    return null;
  } catch (error) {
    console.error('查找标签页失败:', error);
    return null;
  }
}

/**
 * 等待标签页加载完成
 * @param {number} tabId - 标签页ID
 */
function waitForTabLoaded(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // 额外等待一段时间确保页面完全加载
        setTimeout(resolve, 2000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * 监听来自content script的消息
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'tradeResult') {
    console.log('交易结果:', request.data);
    
    // 构建返回消息
    const response = {
      type: 'orderResult',
      data: {
        orderData: request.data.orderData,
        unionId: request.data.unionId,
        bnResp: request.data.bnResp
      }
    };
    
    // 将结果发送回WebSocket服务器
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
      console.log('已发送交易结果到WebSocket:', response);
    }
    
    sendResponse({ success: true });
  } else if (request.action === 'alphaHeadersCaptured') {
    // content.js 转发来的资产接口请求头（injected.js 捕获）
    saveAlphaHeaders({
      url: request.data.url,
      method: request.data.method,
      headers: request.data.headers,
      at: request.data.at || Date.now(),
      source: 'injected'
    });
    console.log('已保存injected捕获的请求头，字段数:', Object.keys(request.data.headers || {}).length);
    sendResponse({ success: true });
  } else if (request.action === 'refreshAssetsTest') {
    // popup 测试按钮：重放资产查询
    handleRefreshAssets('popup-test').then((result) => {
      sendResponse({ success: result.ok, status: result.status, data: result.data });
    });
    return true; // 异步响应
  } else if (request.action === 'getCapturedHeadersInfo') {
    // popup 查询捕获状态（只回字段名和时间，不回值）
    loadAlphaHeaders().then((record) => {
      if (record && record.headers) {
        sendResponse({
          captured: true,
          url: record.url,
          at: record.at,
          source: record.source,
          headerNames: Object.keys(record.headers)
        });
      } else {
        sendResponse({ captured: false });
      }
    });
    return true; // 异步响应
  } else if (request.action === 'getTabId') {
    sendResponse({ tabId: tradingTabId });
  } else if (request.action === 'connectWS') {
    if (request.url) {
      wsUrl = request.url;
    }
    connectWebSocket();
    sendResponse({ success: true });
  } else if (request.action === 'testTrade') {
    // 处理测试交易请求
    const { chainName, address, amt, symbol, price, unionId } = request.data;
    
    // 构建URL
    const url = `https://www.binance.com/zh-CN/alpha/${chainName}/${address}`;
    
    // 根据amt的正负判断买卖方向
    const direction = parseFloat(amt) > 0 ? 'Buy' : 'Sell';
    const amount = Math.abs(parseFloat(amt)).toString();
    
    executeTrade({
      url,
      price,
      amount,
      direction,
      coin: symbol,
      unionId
    });
    
    sendResponse({ success: true });
  }
  return true;
});

/**
 * 插件安装或更新时的处理
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('币安Alpha交易助手已安装');
  // 暂时不自动连接WebSocket，等待用户手动连接
  // connectWebSocket();
});

/**
 * 监听插件启动
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('币安Alpha交易助手已启动');
  // 暂时不自动连接WebSocket
  // connectWebSocket();
});

