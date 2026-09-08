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
  chrome.storage.local.get(['browserNumber'], (result) => {
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
    const name = `BINANCEALPHA-${number}`;
    const wsUrl = `wss://sg.bicoin.com.cn/98c/weborder/${name}`;
    
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
      url: 'https://www.binance.com/zh-CN/trade',
      active: false 
    });
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

