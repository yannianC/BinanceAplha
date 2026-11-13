/**
 * 弹出窗口脚本
 * 处理用户界面交互
 */

let autoConnectTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  const connectBtn = document.getElementById('connectBtn');
  const createTabBtn = document.getElementById('createTabBtn');
  const testBtn = document.getElementById('testBtn');
  const statusDiv = document.getElementById('status');
  const browserNumberInput = document.getElementById('browserNumber');
  
  /**
   * 从存储中加载已保存的编号
   */
  WS_CONFIG.load().then(result=>{browserNumberInput.value=result.browserNumber || '';});
  // Commit the instance number only when the user explicitly connects.
  /**
   * 连接WebSocket
   */
  function connectWebSocket() {
    const number = browserNumberInput.value.trim();
    
    if (!WS_CONFIG.parseNumber(number)) {
      alert('实例编号格式：23 或 23-1，每段1至12位数字');
      return;
    }
    
    chrome.runtime.sendMessage({
      action: 'connectWS',
      number
    }, (response) => {
      if (response && response.success) {
        statusDiv.textContent = 'WebSocket: 正在连接...';
        statusDiv.className = 'status';
        
      } else {
        statusDiv.textContent=response?.error || '连接失败';
        statusDiv.className='status disconnected';
      }
    });
  }
  
  /**
   * 连接WebSocket按钮点击事件
   */
  connectBtn.addEventListener('click', () => {
    // 取消自动连接定时器
    if (autoConnectTimer) {
      clearTimeout(autoConnectTimer);
      autoConnectTimer = null;
    }
    
    connectWebSocket();
  });
  
  /**
   * 创建交易标签页按钮点击事件
   */
  createTabBtn.addEventListener('click', async () => {
    const response=await chrome.runtime.sendMessage({action:'openAlpha'});
    if(response.error)alert(response.error);
  });

  /**
   * 刷新持有资产按钮点击事件
   */
  const refreshAssetsBtn = document.getElementById('refreshAssetsBtn');
  const assetsInfo = document.getElementById('assetsInfo');

  refreshAssetsBtn.addEventListener('click', () => {
    assetsInfo.textContent = '资产查询中...';
    chrome.runtime.sendMessage({ action: 'refreshAssetsTest' }, (response) => {
      if (!response) {
        assetsInfo.textContent = '无响应（background未就绪）';
        return;
      }
      if (response.success) {
        const d = response.data || {};
        const list = (d.data && Array.isArray(d.data)) ? d.data : (Array.isArray(d.data) ? d.data : null);
        if (list) {
          const summary = list.map(a => `${a.asset || a.tokenSymbol || a.symbol || '?'}:${a.free || a.amount || a.balance || '?'}`).join(' ');
          assetsInfo.textContent = `✅ 成功(HTTP ${response.status}) 共${list.length}项: ${summary.slice(0, 120)}`;
        } else {
          assetsInfo.textContent = `✅ 成功(HTTP ${response.status}): ${JSON.stringify(d).slice(0, 150)}`;
        }
      } else {
        assetsInfo.textContent = `❌ 失败(HTTP ${response.status || 0}): ${JSON.stringify(response.data).slice(0, 150)}`;
      }
    });
  });

  /**
   * 打开popup时显示请求头捕获状态
   */
  chrome.runtime.sendMessage({ action: 'getCapturedHeadersInfo' }, (response) => {
    if (response && response.captured) {
      const time = response.at ? new Date(response.at).toLocaleTimeString() : '?';
      assetsInfo.textContent = `已捕获请求头 ${response.headerNames.length} 个字段（${time}，来源:${response.source || '?'}）`;
    }
  });
  
  /**
   * 测试交易按钮点击事件
   */
  testBtn.addEventListener('click', () => {
    const chainName = document.getElementById('testChainName').value;
    const address = document.getElementById('testAddress').value;
    const amt = document.getElementById('testAmt').value;
    const symbol = document.getElementById('testSymbol').value;
    const price = document.getElementById('testPrice').value;
    const unionId = document.getElementById('testUnionId').value;
    
    if (!chainName || !address || !amt || !symbol || !price || !unionId) {
      alert('请填写所有必填字段');
      return;
    }
    
    // 构建测试消息
    const testData = {
      chainName,
      address,
      amt,
      symbol,
      price,
      unionId
    };
    
    console.log('发送测试数据:', testData);
    
    // 发送测试消息到background script
    chrome.runtime.sendMessage({
      action: 'testTrade',
      data: testData
    });
    
    // 显示构建的URL
    const url = `https://www.binance.com/zh-CN/alpha/${chainName}/${address}`;
    const direction = parseFloat(amt) > 0 ? '买入' : '卖出';
    const amount = Math.abs(parseFloat(amt));
    
    // alert(`测试指令已发送！\n\n目标URL: ${url}\n方向: ${direction}\n数量: ${amount}\n价格: ${price}\n币种: ${symbol}\n\n请查看控制台输出。`);
  });
});

/**
 * 监听来自background script的消息以更新状态
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateStatus') {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = request.message;
    statusDiv.className = `status ${request.connected ? 'connected' : 'disconnected'}`;
  }
});

// This UI only manages tabs/queue; it never submits a trade by preloading.
document.addEventListener('DOMContentLoaded', async () => {
  const urls = document.getElementById('favoriteUrls');
  const info = document.getElementById('queueInfo');
  const resume = document.getElementById('resumeQueueBtn');
  urls.value = ((await chrome.storage.local.get('alphaFavoriteUrls')).alphaFavoriteUrls || []).join('\n');
  async function refresh() {
    const state = await chrome.runtime.sendMessage({action:'queueStatus'});
    info.textContent = state.error || (state.blocked ? '队列已暂停：请先核对币安订单，结果不明的订单不会自动重下。' : '多币种顺序下单已启用；已打开的币种页会自动复用。');
    resume.hidden = !state.blocked;
  }
  document.getElementById('preloadBtn').addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({action:'preloadTabs',urls:urls.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)});
    info.textContent = result.error || '已保存并打开币种页；首次加载请依次查看页面是否登录、可交易。';
  });
  resume.addEventListener('click', async () => {
    if (!confirm('已在币安核对结果不明的订单，且关闭遗留确认弹窗？恢复后仅接收新指令，不重放旧单。')) return;
    const result = await chrome.runtime.sendMessage({action:'resumeQueue'});
    if (result.error) info.textContent=result.error; else await refresh();
  });
  await refresh();
});

document.addEventListener('DOMContentLoaded',async()=>{
  const info=document.getElementById('bindingInfo');
  async function showBinding(){
    const state=await chrome.runtime.sendMessage({action:'bindingStatus'});
    info.textContent=`实例 ID：${state.instanceId}；`+(state.bound?`已绑定窗口 ${state.windowId}`:`未绑定：${state.error}`);
  }
  document.getElementById('bindWindowBtn').addEventListener('click',async()=>{
    const window=await chrome.windows.getCurrent();
    if(window.incognito || window.type!=='normal'){info.textContent='请在普通窗口绑定';return;}
    const result=await chrome.runtime.sendMessage({action:'bindWindow',windowId:window.id});
    if(result.error)info.textContent=result.error;else await showBinding();
  });
  await showBinding();
});
