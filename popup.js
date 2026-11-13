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
  WS_CONFIG.load().then((result) => {
    if (result.browserNumber) {
      browserNumberInput.value = result.browserNumber;
      
      // 如果有保存的编号，10秒后自动连接
      statusDiv.textContent = 'WebSocket: 10秒后自动连接...';
      statusDiv.className = 'status';
      
      autoConnectTimer = setTimeout(() => {
        connectWebSocket();
      }, 10000);
    }
  });
  
  /**
   * 编号输入框变化时保存
   */
  browserNumberInput.addEventListener('input', () => {
    const number = browserNumberInput.value.trim();
    if (number) {
      chrome.storage.local.set({ browserNumber: number });
    } else {
      chrome.storage.local.remove('browserNumber');
    }
    
    // 取消自动连接定时器
    if (autoConnectTimer) {
      clearTimeout(autoConnectTimer);
      autoConnectTimer = null;
    }
  });
  
  /**
   * 连接WebSocket
   */
  function connectWebSocket() {
    const number = browserNumberInput.value.trim();
    
    if (!number) {
      alert('请输入浏览器编号');
      return;
    }
    
    // 拼接完整的WebSocket地址
    const wsUrl = WS_CONFIG.buildUrl(number);
    
    chrome.runtime.sendMessage({
      action: 'connectWS',
      url: wsUrl
    }, (response) => {
      if (response && response.success) {
        statusDiv.textContent = 'WebSocket: 正在连接...';
        statusDiv.className = 'status';
        
        // 3秒后更新状态
        setTimeout(() => {
          statusDiv.textContent = 'WebSocket: 已连接';
          statusDiv.className = 'status connected';
        }, 3000);
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
  createTabBtn.addEventListener('click', () => {
    chrome.tabs.create({
      url: 'https://www.binance.com/zh-CN/alpha',
      active: false
    });
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
