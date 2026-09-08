/**
 * 注入到页面主世界的脚本
 * 用于拦截Fetch和XMLHttpRequest请求
 */

(function() {
  // 防止重复注入
  if (window.__BINANCE_INTERCEPTOR_LOADED__) {
    console.log('⚠️ API拦截器已存在，跳过重复注入');
    return;
  }
  
  console.log('%c=== API拦截器已注入(injected.js) ===', 'color: green; font-size: 16px; font-weight: bold;');
  
  // 标记拦截器已加载
  window.__BINANCE_INTERCEPTOR_LOADED__ = true;
  
  // 拦截fetch
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    
    // 只记录包含bapi的请求，减少日志
    if (url.includes('/bapi/')) {
      console.log('%cFetch请求:', 'color: blue;', url);
    }
    
    return originalFetch.apply(this, args).then(response => {
      // 克隆response以便我们可以读取它
      const clonedResponse = response.clone();
      
      // 检查是否是我们要监听的接口
      if (url.includes('/bapi/asset/v1/private/alpha-trade/order/place')) {
        console.log('%c拦截到目标Fetch请求!', 'color: red; font-size: 14px; font-weight: bold;', url);
        clonedResponse.json().then(data => {
          console.log('%cFetch响应数据:', 'color: red; font-size: 14px;', data);
          // 将响应数据发送到页面
          window.postMessage({
            type: 'FETCH_RESPONSE',
            url: url,
            data: data
          }, '*');
        }).catch(err => {
          console.error('解析Fetch响应失败:', err);
        });
      }
      
      return response;
    });
  };
  
  console.log('Fetch拦截器已设置');
  
  // 拦截XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    this._method = method;
    
    // 只记录包含bapi的请求，减少日志
    if (url.includes('/bapi/')) {
      console.log('%cXHR请求:', 'color: blue;', method, url);
    }
    
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };
  
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._url && this._url.includes('/bapi/asset/v1/private/alpha-trade/order/place')) {
      console.log('%c拦截到目标XHR请求!', 'color: red; font-size: 14px; font-weight: bold;', this._url);
      
      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          console.log('%cXHR响应数据:', 'color: red; font-size: 14px;', data);
          window.postMessage({
            type: 'FETCH_RESPONSE',
            url: this._url,
            data: data
          }, '*');
        } catch (err) {
          console.error('解析XHR响应失败:', err);
        }
      });
    }
    
    return originalXHRSend.apply(this, args);
  };
  
  console.log('XHR拦截器已设置');
  console.log('%c=== API拦截器注入完成 ===', 'color: green; font-size: 16px; font-weight: bold;');
})();

