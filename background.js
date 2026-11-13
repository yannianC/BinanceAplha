/**
 * 后台服务脚本
 * 处理WebSocket连接和消息分发
 */

importScripts('ws-config.js', 'trade-core.js', 'window-binding.js', 'asset-readiness.js');

let ws = null;
let tradingTabId = null;
let wsUrl = 'ws://localhost:8080'; // 默认WebSocket地址，后续可以配置
let heartbeatTimer = null; // 心跳定时器
let heartbeatCheckTimer = null; // 心跳检查定时器
let lastHeartbeatTime = null; // 上次收到心跳响应的时间

const windowBinding = new AlphaWindow.WindowBinding({
  id:chrome.runtime.id,
  load:async()=>(await chrome.storage.session.get('windowBinding')).windowBinding,
  save:b=>chrome.storage.session.set({windowBinding:b}),
  query:windowId=>chrome.tabs.query({windowId}),
  get:id=>chrome.tabs.get(id),
  create:(windowId,url)=>chrome.tabs.create({windowId,url,active:false,pinned:true}),
  remove:id=>chrome.tabs.remove(id),
  token:()=>crypto.randomUUID()
});
const assetReadiness = new AlphaAssets.AssetReadiness({
  busy:()=>isBusy(),
  check:async trade=>{
    if(ws!==trade.socket || ws?.readyState!==WebSocket.OPEN)return false;
    const binding=await windowBinding.require();
    if(binding.token!==trade.bindingToken)return false;
    const [chainName,address]=AlphaTrade.assetKey(trade.url).split('/');
    const result=await handlePageCommand({type:'refresh',data:{chainName,address}},{bindingToken:trade.bindingToken,socket:trade.socket});
    return result.healthy && result.canTrade;
  }
});
let maintenance = false;
let acceptingOrders = 0;
async function authorizeSender(sender, token) {
  if(sender.frameId !== 0 || !sender.tab || !sender.url?.startsWith('https://www.binance.com/')) throw Error('无效页面来源');
  return windowBinding.authorize(sender.tab.id,token);
}
function isBusy() {return maintenance || acceptingOrders > 0 || tradeQueue.pending > 0;}

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
  await windowBinding.require();
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
 * 资产上报接口地址（HTTP POST，不走 WebSocket）
 */
const ALPHA_BALANCE_URL = WS_CONFIG.assetsUrl || 'https://sg.bicoin.com.cn/98h/sp/alphaBalance';

/**
 * 从币安资产响应中取出上报用的 data 体
 * 币安 bapi 响应一般是 { code, message, data: {...} }，取内层 data
 */
function extractAssetsPayload(bnData) {
  if (bnData && bnData.data && typeof bnData.data === 'object') {
    return bnData.data;
  }
  return null;
}

/**
 * 获取当前账户编号（多个实例共用资产上报 name）
 */
async function currentBrowserName() {
  try {
    const stored = await WS_CONFIG.load();
    return WS_CONFIG.accountName(stored);
  } catch (e) {}
  return '';
}

/**
 * 把资产结果 POST 到后端接口
 * body: { name: "23", totalValuation: "...", list: [...] }
 */
async function reportAssetsBalance(result) {
  const inner = extractAssetsPayload(result.data);
  const hasPayload = Array.isArray(inner) ||
    (inner && typeof inner === 'object' &&
      ('list' in inner || 'assets' in inner || 'totalValuation' in inner));
  if (!hasPayload) {
    console.warn('资产响应结构异常，跳过接口上报:', JSON.stringify(result.data).slice(0, 300));
    return { ok: false, status: 0 };
  }

  const name = await currentBrowserName();
  if (!name) return { ok: false, status: 0 };
  const body = {};
  if (Array.isArray(inner)) {
    body.list = inner;
  } else {
    Object.assign(body, inner);
    if (!Array.isArray(body.list) && Array.isArray(inner.assets)) {
      body.list = inner.assets;
    }
    if (!Array.isArray(body.list)) body.list = [];
  }

  body.name = name; // Page payload must not override the configured account.

  try {
    const resp = await fetch(ALPHA_BALANCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    console.log(`资产已通过接口上报 HTTP ${resp.status}:`, text.slice(0, 300));
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    console.error('资产接口上报失败:', e);
    return { ok: false, status: 0 };
  }
}

// 被动捕获上报的去重：相同内容60秒内只报一次
let lastPassiveAssetsKey = '';
let lastPassiveAssetsAt = 0;

/**
 * 页面自身拉取的资产数据 → POST 到后端接口
 * （交易后币安前端自动刷新资产时被动捕获，无需重放查询）
 */
async function reportInterceptedAssets(msg) {
  void assetReadiness.observe(msg?.data).catch(e=>console.warn(e.message));
  const result = { ok: true, status: 200, data: msg && msg.data };
  try {
    const payload = extractAssetsPayload(result.data);
    if (!payload) {
      console.warn('被动捕获的资产数据结构异常，跳过上报:', JSON.stringify(result.data).slice(0, 200));
      return { ok: false, status: 0 };
    }
    const key = JSON.stringify(payload);
    const now = Date.now();
    if (key === lastPassiveAssetsKey && now - lastPassiveAssetsAt < 60000) {
      console.log('资产数据与60秒内上次相同，跳过重复上报');
      return { ok: true, status: 200, skipped: true };
    }
    lastPassiveAssetsKey = key;
    lastPassiveAssetsAt = now;
  } catch (e) {}
  return reportAssetsBalance(result);
}

/**
 * 处理刷新资产请求（来自WS或popup测试）
 * 查询币安资产后，通过 HTTP 接口上报（不再走 WebSocket）
 */
async function handleRefreshAssets(unionId) {
  const result = await refreshAssets();
  if (result.ok) {
    void assetReadiness.observe(result.data).catch(e=>console.warn(e.message));
    result.report = await reportAssetsBalance(result);
  } else {
    console.warn('资产查询失败，跳过接口上报, HTTP', result.status);
  }
  return result;
}

/**
 * webRequest 兜底捕获：能拿到完整真实请求头（含cookie），作为 injected.js 捕获的备份
 */
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    async (details) => {
      try {
        await windowBinding.authorize(details.tabId);
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
function getConnectionStatus() {
  const readyState = ws ? ws.readyState : WebSocket.CLOSED;
  const connected = readyState === WebSocket.OPEN;
  const message = connected ? 'WebSocket: 已连接' :
    readyState === WebSocket.CONNECTING ? 'WebSocket: 正在连接...' :
    readyState === WebSocket.CLOSING ? 'WebSocket: 正在断开...' : 'WebSocket: 未连接';
  return { readyState, connected, message };
}

function publishConnectionStatus() {
  // A closed popup has no receiver; this must never interrupt socket handling.
  chrome.runtime.sendMessage({ action: 'updateStatus', ...getConnectionStatus() }).catch(() => {});
}

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
    publishConnectionStatus();

    sock.onopen = () => {
      if (sock !== ws) return;
      publishConnectionStatus();
      console.log('WebSocket连接已建立');
      // 启动心跳机制
      startHeartbeat();
      // 连接建立后，如已捕获到请求头，主动查询并上报一次持有资产
      loadAlphaHeaders().then((record) => {
        if (sock !== ws) return;
        if (record && record.headers && Object.keys(record.headers).length > 0) {
          console.log('连接建立，主动刷新一次持有资产...');
          handleRefreshAssets('startup').catch(()=>{});
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
      publishConnectionStatus();
      console.error('WebSocket错误:', error);
    };

    sock.onclose = (event) => {
      if (sock !== ws) return; // 陈旧连接关闭：不杀新连接心跳，也不安排重连
      publishConnectionStatus();
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
    publishConnectionStatus();
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
    handleRefreshAssets(unionId).catch(e=>console.warn(e.message));
    return;
  }

  if (['refresh','ready','checkTradeReady','refreshTradePage'].includes(message.type)) return handlePageCommand(message);
  if (message.type === 'order' && message.data) enqueueOrder(message.data);
}

async function handlePageCommand(message, expected = null) {
  // Server naming is intentional: refresh probes readiness; ready reloads the page.
  const compact = message.type === 'refresh' || message.type === 'ready';
  const reload = message.type === 'ready' || message.type === 'refreshTradePage';
  const replySocket = ws;
  const {requestId,chainName,address}=message.data || {};
  const result={requestId,healthy:false,canTrade:false,checkedAt:Date.now(),instanceId:chrome.runtime.id};
  let locked=false;
  try {
    if((!compact && (typeof requestId!=='string' || !requestId)) || !/^[a-z0-9_-]+$/i.test(chainName || '') || !/^[a-z0-9_-]+$/i.test(address || '')) throw Error('无效检查参数');
    if(isBusy())throw Error('BUSY: 正在下单或维护，不能检查切页或刷新');
    maintenance=true;locked=true;
    const binding=await windowBinding.require();
    if(expected && (binding.token!==expected.bindingToken || ws!==expected.socket))throw Error('窗口或连接已变化');
    const url=`https://www.binance.com/zh-CN/alpha/${chainName}/${address}`;
    const tab=await findTabByUrl(url);
    if(!tab)throw Error('绑定窗口中没有该币种页面');
    await windowBinding.authorize(tab.id,binding.token);
    await chrome.tabs.update(tab.id,{active:true});
    if(reload) {
      await reloadBoundTab(tab.id,binding.token);
      result.refreshed=true;
    } else await waitForTabLoaded(tab.id);
    await windowBinding.authorize(tab.id,binding.token);
    await ensureContentScriptLoaded(tab.id);
    const page=await withTimeout(chrome.tabs.sendMessage(tab.id,{action:'checkReady'}),5000);
    if(AlphaTrade.assetKey(page?.url)!==AlphaTrade.assetKey(url))throw Error('币种已变化');
    Object.assign(result,page);
    result.windowId=binding.windowId;
  } catch(e){result.healthy=false;result.canTrade=false;result.error=e.message;}
  finally {if(locked){maintenance=false;void assetReadiness.flush();}}
  result.checkedAt=Date.now();
  if(replySocket === ws && replySocket?.readyState===WebSocket.OPEN) {
    if(!compact) replySocket.send(JSON.stringify({type:message.type+'Result',data:result}));
    else if(message.type==='refresh' && result.healthy && result.canTrade) replySocket.send(JSON.stringify({type:'isready'}));
  }
  // Compact protocol has no error/refresh acknowledgement; keep diagnostics local.
  if(compact && result.error) console.warn('页面指令未就绪:',message.type,result.error);
  return result;
}
async function reloadBoundTab(tabId, token) {
  await windowBinding.authorize(tabId,token);
  let listener,removed;
  const loaded=new Promise((resolve,reject)=>{
    listener=(id,info)=>{if(id===tabId && info.status==='complete')resolve();};
    removed=id=>{if(id===tabId)reject(Error('刷新期间标签页被关闭'));};
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.reload(tabId).catch(reject);
  });
  try {await withTimeout(loaded,30000);}
  finally {chrome.tabs.onUpdated.removeListener(listener);chrome.tabs.onRemoved.removeListener(removed);}
  await windowBinding.authorize(tabId,token);
}

async function enqueueOrder(data) {
  const {chainName, address, amt, symbol, price, unionId} = data;
  let accepting=false;
  try {
    if (maintenance) throw Error('窗口正在绑定或刷新，暂不接单');
    acceptingOrders++;accepting=true;
    const binding = await windowBinding.require();
    if (maintenance) throw Error('窗口正在维护');
    if (typeof unionId !== 'string' || !unionId || unionId.length > 160) throw Error('订单编号必须是非空字符串');
    if (!/^[a-z0-9_-]+$/i.test(chainName || '') || !/^[a-z0-9_-]+$/i.test(address || '')) throw Error('无效链或合约地址');
    const decimal = /^-?\d+(?:\.\d+)?$/;
    if (!decimal.test(String(amt)) || !Number.isFinite(Number(amt)) || Number(amt) === 0 ||
        !decimal.test(String(price)) || !Number.isFinite(Number(price)) || Number(price) <= 0 ||
        typeof symbol !== 'string' || !symbol.trim()) throw Error('无效数量、价格或币种');
    const trade = {
      url: `https://www.binance.com/zh-CN/alpha/${chainName}/${address}`,
      price: String(price), amount: String(amt).replace(/^-/, ''),
      direction: Number(amt) > 0 ? 'Buy' : 'Sell', coin: symbol, unionId, bindingToken:binding.token
    };
    AlphaTrade.assetKey(trade.url);
    await tradeQueue.submit(trade).catch(e => notify('订单结果上报失败', e.message));
  } catch (e) { reportTradeResult(AlphaTrade.failure(unionId, 'INVALID_ORDER', e.message)); }
  finally {if(accepting)acceptingOrders--;void assetReadiness.flush();}
}

function reportTradeResult(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'orderResult',data}));
  const od = data.orderData || {};
  notify(data.bnResp === 1 ? '下单回执' : '下单未完成', `${data.unionId}: ${od.code || ''} ${od.message || ''}`);
  if (data.bnResp === 1 && String(od.code) === '000000') setTimeout(() => handleRefreshAssets('after-trade').catch(()=>{}), 5000);
}
const tradeQueue = new AlphaTrade.TradeQueue({
  load: async () => (await chrome.storage.local.get('alphaOrderJournal')).alphaOrderJournal || {},
  save: state => chrome.storage.local.set({alphaOrderJournal:state}),
  execute: executeTrade,
  report: reportTradeResult
});
// Observe startup storage errors even when no order arrives.
tradeQueue.ready.catch(e => notify('交易队列无法初始化', e.message));

/**
 * 执行交易操作
 * @param {Object} tradeInfo - 交易信息
 */
async function executeTrade(tradeInfo) {
  const ticket=assetReadiness.begin({...tradeInfo,socket:ws});
  let dispatched = false;
  try {
    const binding = await windowBinding.require();
    if (binding.token !== tradeInfo.bindingToken) throw Error('订单所属窗口绑定已变化，请重新检查');
    const tab = await getOrCreateTradingTab(tradeInfo.url);
    const tabId = tab.id; // Local to this order; never use mutable shared routing state.
    await windowBinding.authorize(tabId,tradeInfo.bindingToken);
    tradingTabId = tabId; // Popup display only.
    await chrome.tabs.update(tabId, {active:true, autoDiscardable:false});
    await waitForTabLoaded(tabId);
    await ensureContentScriptLoaded(tabId);
    const current = await chrome.tabs.get(tabId);
    if (AlphaTrade.assetKey(current.url) !== AlphaTrade.assetKey(tradeInfo.url)) throw Error('标签页已切换到其他币种');
    await windowBinding.authorize(tabId,tradeInfo.bindingToken);
    dispatched = true;
    const result = await withTimeout(chrome.tabs.sendMessage(tabId, {action:'executeTrade',data:{...tradeInfo, attemptId:crypto.randomUUID(), deadline:Date.now()+80000}}), 90000);
    if (!result || result.protocol !== 4 || !result.data) throw Error('页面返回了旧版或无效回执');
    assetReadiness.finish(ticket,result.data.bnResp===1 && String(result.data.orderData?.code)==='000000');
    return result.data;
  } catch (e) {
    assetReadiness.finish(ticket,false);
    return AlphaTrade.failure(tradeInfo.unionId, dispatched ? 'ORDER_STATUS_UNKNOWN' : 'PAGE_NOT_READY', e.message);
  }
}

const tabCreations = new Map();
async function getOrCreateTradingTab(url) {
  const binding = await windowBinding.require();
  const key = binding.token + ':' + AlphaTrade.assetKey(url);
  if (tabCreations.has(key)) return tabCreations.get(key);
  const creation = (async()=>{
    const tab = await findTabByUrl(url) || await chrome.tabs.create({url,windowId:binding.windowId,active:false});
    await windowBinding.authorize(tab.id,binding.token);
    await chrome.tabs.update(tab.id, {autoDiscardable:false});
    return tab;
  })();
  tabCreations.set(key, creation);
  try { return await creation; } finally { tabCreations.delete(key); }
}
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_,reject) => {
    timer=setTimeout(()=>reject(Error('页面操作或回执超时，请核对订单')),ms);
  })]).finally(()=>clearTimeout(timer));
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
  const reply = await chrome.tabs.sendMessage(tabId, {action:'activatePage'});
  if (reply?.protocol !== 4 || !reply.authorized) throw Error('请刷新币安标签页以加载新版插件');
}

/**
 * 查找匹配URL的标签页
 * @param {string} url - 要查找的URL
 * @returns {Promise<chrome.tabs.Tab|null>} 找到的标签页或null
 */
async function findTabByUrl(url) {
  try {
    const binding = await windowBinding.require();
    const tabs = await chrome.tabs.query({windowId:binding.windowId});
    
    // 查找完全匹配的标签页
    for (const tab of tabs) {
      if (tab.url && (() => { try { return AlphaTrade.assetKey(tab.url) === AlphaTrade.assetKey(url); } catch (_) { return false; } })()) {
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
async function waitForTabLoaded(tabId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && !tab.discarded) return;
    await sleep(100);
  }
  throw Error('标签页加载超时');
}

/**
 * 监听来自content script的消息
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (['getConnectionStatus','testTrade','preloadTabs','bindWindow','openAlpha','connectWS','refreshAssetsTest'].includes(request.action) && sender.url !== chrome.runtime.getURL('popup.html')) { sendResponse({error:'仅插件弹窗可操作'}); return false; }
  if (request.action === 'authorizePage') {
    authorizeSender(sender,request.token).then(b=>sendResponse({authorized:true,token:b.token,instanceId:chrome.runtime.id})).catch(e=>sendResponse({authorized:false,error:e.message}));
    return true;
  }
  if (['alphaHeadersCaptured','alphaAssetsData'].includes(request.action)) {
    authorizeSender(sender,request.token).then(()=>{
      if(request.action==='alphaHeadersCaptured') {saveAlphaHeaders({...request.data,at:Date.now(),source:'injected'});sendResponse({success:true});}
      else reportInterceptedAssets(request.data).then(sendResponse).catch(e=>sendResponse({error:e.message}));
    }).catch(e=>sendResponse({error:e.message}));
    return true;
  }
  if (request.action === 'bindWindow') {
    (async()=>{
      if(isBusy()) throw Error('有订单或维护操作进行中，不能更改窗口绑定');
      maintenance=true;
      try {
        const b=await windowBinding.bind(request.windowId);
        alphaHeadersCache=null;await chrome.storage.local.remove('alphaHeaders');
        for(const tab of await chrome.tabs.query({windowId:b.windowId,url:'https://www.binance.com/*'})) {
          chrome.tabs.sendMessage(tab.id,{action:'activatePage'}).catch(()=>{});
        }
        return {success:true,windowId:b.windowId};
      } finally {maintenance=false;void assetReadiness.flush();}
    })().then(sendResponse).catch(e=>sendResponse({error:e.message}));
    return true;
  }
  if (request.action === 'bindingStatus') {
    windowBinding.require().then(b=>sendResponse({bound:true,windowId:b.windowId,instanceId:chrome.runtime.id})).catch(e=>sendResponse({bound:false,error:e.message,instanceId:chrome.runtime.id}));return true;
  }
  if (request.action === 'openAlpha') {
    windowBinding.require().then(b=>chrome.tabs.create({windowId:b.windowId,url:'https://www.binance.com/zh-CN/alpha',active:false})).then(()=>sendResponse({success:true})).catch(e=>sendResponse({error:e.message}));return true;
  }
  if (request.action === 'tradeResult') {
    // Old pages must be refreshed; unsolicited page results cannot complete queued orders.
    sendResponse({success:false});
  } else if (request.action === 'refreshAssetsTest') {
    // popup 测试按钮：重放资产查询
    handleRefreshAssets('popup-test').then((result) => {
      sendResponse({ success: result.ok, status: result.status, data: result.data });
    }).catch(e=>sendResponse({success:false,error:e.message}));
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
  } else if (request.action === 'getConnectionStatus') {
    sendResponse(getConnectionStatus());
  } else if (request.action === 'connectWS') {
    (async()=>{
      if(isBusy()) throw Error('订单执行期间不能更换连接编号');
      maintenance=true;
      try {
      await windowBinding.require();
      wsUrl=WS_CONFIG.buildUrl(request.number);
      await chrome.storage.local.set({browserNumber:request.number,wsUrl});
      connectWebSocket();return {success:true};
      } finally {maintenance=false;void assetReadiness.flush();}
    })().then(sendResponse).catch(e=>sendResponse({error:e.message}));
  } else if (request.action === 'testTrade') {
    enqueueOrder(request.data);
    sendResponse({success:true});
  } else if (request.action === 'queueStatus') {
    tradeQueue.status().then(sendResponse).catch(e=>sendResponse({error:e.message}));

  } else if (request.action === 'preloadTabs') {
    (async()=>{
      const urls = request.urls;
      if (!Array.isArray(urls) || urls.length > 20) throw Error('最多保存20个币种网址');
      urls.forEach(url=>AlphaTrade.assetKey(url));
      await chrome.storage.local.set({alphaFavoriteUrls:urls});
      for (const url of urls) await getOrCreateTradingTab(url);
      return {success:true};
    })().then(sendResponse).catch(e=>sendResponse({error:e.message}));
  }
  return true;
});

/**
 * 根据浏览器编号拼接WS地址
 */
function buildWsUrl(number) {
  return WS_CONFIG.buildUrl(number);
}

/**
 * 后台自动连接：读取保存的编号/地址，自动连上WS（无需打开popup）
 */
async function autoConnectFromStorage(reason) {
  try {
    // 已有活跃连接就不重复连
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    await windowBinding.require();
    const stored = await WS_CONFIG.load();
    const url = stored.wsUrl || (stored.browserNumber ? buildWsUrl(stored.browserNumber) : null);
    if (!url) {
      console.log(`[${reason}] 未保存浏览器编号，暂不自动连接（在popup里输入编号连接一次即可，之后全自动）`);
      return;
    }
    wsUrl = url;
    console.log(`[${reason}] 自动连接WebSocket:`, wsUrl);
    connectWebSocket();
  } catch (e) {
    console.warn('自动连接失败:', e);
  }
}

/**
 * 收集币安Alpha页面DOM诊断（chrome.scripting在隔离世界执行，不改页面、无需刷新）
 * 结果存 chrome.storage.local.pageDiag，便于远程排查下单选择器
 */
async function collectPageDiag(reason) {
  try {
    const binding = await windowBinding.require();
    const tabs = await chrome.tabs.query({ windowId:binding.windowId, url: 'https://www.binance.com/*' });
    const tab = tabs.find(t => t.url && t.url.includes('/alpha')) || tabs[0];
    if (!tab || !tab.id) {
      console.log(`[diag:${reason}] 没有币安页面标签`);
      return;
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const vis = e => !!(e && e.offsetParent !== null);
        const txt = e => (e && (e.textContent || '')).trim().slice(0, 50);
        const cls = e => (e && (e.className || '')).toString().slice(0, 90);
        return {
          url: location.href,
          buySellTabs: Array.from(document.querySelectorAll('.bn-tab__buySell')).map(e => ({
            text: txt(e), cls: cls(e), active: e.classList.contains('active'), vis: vis(e)
          })),
          orderTabs: ['LIMIT', 'INSTANT', 'STOP_LIMIT'].map(id => {
            const e = document.getElementById('bn-tab-' + id);
            return e ? { id, text: txt(e), active: e.classList.contains('active'), vis: vis(e) } : null;
          }).filter(Boolean),
          buttons: Array.from(document.querySelectorAll('button[class*="bn-button"]')).filter(vis).map(e => ({
            text: txt(e), cls: cls(e), disabled: !!e.disabled
          })).slice(0, 40),
          inputs: ['limitPrice', 'limitAmount', 'limitTotal'].map(id => {
            const e = document.getElementById(id);
            return e ? { id, vis: vis(e), value: e.value } : { id, missing: true };
          }),
          dialogs: Array.from(document.querySelectorAll(
            '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'
          )).filter(vis).map(e => ({
            cls: cls(e), text: txt(e),
            buttons: Array.from(e.querySelectorAll('button')).map(b => txt(b)).slice(0, 10)
          })).slice(0, 5)
        };
      }
    });
    if (res && res.result) {
      const diag = { reason, at: Date.now(), ...res.result };
      await chrome.storage.local.set({ pageDiag: diag });
      console.log(`[diag:${reason}] 页面诊断已保存:`, diag.url);
    }
  } catch (e) {
    console.warn(`[diag:${reason}] 收集失败:`, e.message);
  }
}

/**
 * 系统通知（下单指令/回执提醒，后台运行时用户能感知）
 */
function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: title,
      message: message
    });
  } catch (e) {}
}

/**
 * 插件安装或更新时的处理
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('币安Alpha交易助手已安装/更新');
  autoConnectFromStorage('onInstalled');
});

/**
 * 浏览器启动时的处理
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('币安Alpha交易助手已随浏览器启动');
  autoConnectFromStorage('onStartup');
});

/**
 * 看门狗：每30秒检查一次WS，断了自动重连
 * （service worker 被休眠唤醒时也靠它兜底恢复连接）
 */
chrome.alarms.create('ws-watchdog', { periodInMinutes: 0.5 });
chrome.alarms.create('page-diag', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'page-diag') {
    collectPageDiag('alarm');
    return;
  }
  if (alarm.name !== 'ws-watchdog') return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    console.log('看门狗检测到WS未连接，尝试自动重连...');
    autoConnectFromStorage('watchdog');
  }
});

/**
 * Service Worker 每次被唤醒/启动时，也尝试自动连接
 */
autoConnectFromStorage('sw-start');
// SW启动后延迟收集一次页面诊断（scripting直接读DOM，页面无需刷新）
setTimeout(() => collectPageDiag('sw-start'), 15000);
