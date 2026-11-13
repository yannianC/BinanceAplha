/**
 * 注入到页面主世界的脚本
 * 1. 拦截 alpha-trade/order/place 响应（下单回执）
 * 2. 捕获 cloud-wallet/alpha 等私有接口的请求头（csrftoken/device-info 等），
 *    供插件重放资产查询；同时挂到 window.__ALPHA_HEADERS__ 便于调试
 */

(function() {
  const instanceId=document.currentScript?.dataset.alphaInstance;
  let token=document.currentScript?.dataset.alphaToken;
  if(!instanceId || !token)return;
  const installed=window.__ALPHA_INSTANCE_HOOKS__ ||= {};
  if(installed[instanceId])return;
  installed[instanceId]=true;
  function post(data, responseToken=token) {window.postMessage({...data,instanceId,token:responseToken}, '*');}

  // ============ 目标接口 ============
  const ORDER_PLACE_PATH = '/bapi/asset/v1/private/alpha-trade/order/place';
  const HISTORY_PATH='/bapi/defi/v1/private/alpha-trade/order/get-order-history-merge';
  let armedOrder = null;
  function captureOrderRequest(id,body,responseToken) {
    if(!id || typeof body!=='string')return;
    try {
      const raw=JSON.parse(body),data={};
      for(const key of ['symbol','side','price','quantity'])if(typeof raw[key]==='string' && raw[key].length<=100)data[key]=raw[key];
      post({type:'ALPHA_ORDER_REQUEST',unionId:id,data},responseToken);
    } catch(_) {}
  }
  window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.instanceId !== instanceId) return;
    if(event.data.type==='ALPHA_ENABLE') {if(token!==event.data.token)armedOrder=null;token=event.data.token;return;}
    if(event.data.token !== token)return;
    if (event.data.type === 'ALPHA_ARM_ORDER') {
      armedOrder = event.data.unionId;
      post({type:'ALPHA_ORDER_ARMED',unionId:armedOrder});
    } else if (event.data.type === 'ALPHA_DISARM_ORDER' && armedOrder === event.data.unionId) armedOrder = null;
  });
  function takeOrderId(url) {
    if (!url.includes(ORDER_PLACE_PATH)) return null;
    const id = armedOrder;
    armedOrder = null;
    return id;
  }

  // 需要捕获请求头的私有接口（资产相关）
  const HEADER_CAPTURE_MATCHES = [
    '/bapi/defi/v1/private/wallet-direct/cloud-wallet/alpha'
  ];

  /**
   * 把各种形态的 headers 转成普通对象
   */
  function headersToObject(h, store) {
    store = store || {};
    if (!h) return store;
    try {
      if (typeof h.forEach === 'function') {           // Headers / Map
        h.forEach(function(v, k) { store[k] = v; });
      } else if (Array.isArray(h)) {                    // [[k,v],...]
        h.forEach(function(p) { if (p && p.length >= 2) store[p[0]] = p[1]; });
      } else if (typeof h === 'object') {               // 普通对象
        Object.keys(h).forEach(function(k) { store[k] = h[k]; });
      }
    } catch (e) {}
    return store;
  }

  /**
   * 捕获请求头：挂 window + postMessage 给 content.js
   */
  function captureRequestHeaders(url, method, headers) {
    const record = {
      url: url,
      method: method || 'GET',
      headers: headers,
      at: Date.now()
    };
    // 调试可读（主世界）
    // Headers are sent only through this instance's namespaced bridge.
    console.log('%c捕获到私有接口请求头:', 'color: purple; font-weight: bold;', url, '字段数:', Object.keys(headers).length);
    // 转发给 content.js（值不出本机）
    try {
      post({
        type: 'ALPHA_HEADERS_CAPTURED',
        url: record.url,
        method: record.method,
        headers: record.headers,
        at: record.at
      });
    } catch (e) {}
  }

  function shouldCaptureHeaders(url) {
    return HEADER_CAPTURE_MATCHES.some(function(p) { return url.indexOf(p) >= 0; });
  }

  // ============ 拦截 fetch ============
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const init = args[1] || {};
    const req = (typeof args[0] === 'object') ? args[0] : null;
    const pageUrl = location.href;

    // 只记录包含bapi的请求，减少日志
    if (url.includes('/bapi/')) {
      console.log('%cFetch请求:', 'color: blue;', url);
    }

    // 捕获请求头（资产接口）
    if (shouldCaptureHeaders(url)) {
      try {
        const hdrs = {};
        headersToObject(req && req.headers, hdrs);
        headersToObject(init.headers, hdrs);
        captureRequestHeaders(url, init.method || (req && req.method) || 'GET', hdrs);
      } catch (e) {
        console.error('捕获请求头失败:', e);
      }
    }

    const orderId = takeOrderId(url);
    const responseToken=token;
    if(orderId) {
      if(typeof init.body==='string')captureOrderRequest(orderId,init.body,responseToken);
      else if(req && typeof req.clone==='function')req.clone().text().then(body=>captureOrderRequest(orderId,body,responseToken)).catch(()=>{});
    }
    return originalFetch.apply(this, args).then(response => {
      // 克隆response以便我们可以读取它
      const clonedResponse = response.clone();

      // 检查是否是我们要监听的接口
      if (url.includes(ORDER_PLACE_PATH)) {
        console.log('%c拦截到目标Fetch请求!', 'color: red; font-size: 14px; font-weight: bold;', url);
        clonedResponse.json().then(data => {
          console.log('%cFetch响应数据:', 'color: red; font-size: 14px;', data);
          // 将响应数据发送到页面
          post({
            type: 'FETCH_RESPONSE',
            unionId: orderId,
            url: url,
            data: data
          }, responseToken);
        }).catch(err => {
          console.error('解析Fetch响应失败:', err);
        });
      } else if(url.includes(HISTORY_PATH)) {
        clonedResponse.json().then(data=>post({type:'ALPHA_ORDER_HISTORY',pageUrl,data},responseToken)).catch(()=>{});
      } else if (shouldCaptureHeaders(url)) {
        // 资产接口：捕获响应体（币安前端交易后自动刷新资产时被动拿到最新数据）
        clonedResponse.json().then(data => {
          post({
            type: 'ALPHA_ASSETS_DATA',
            url: url,
            pageUrl,
            data: data
          }, responseToken);
        }).catch(() => {});
      }

      return response;
    });
  };

  console.log('Fetch拦截器已设置');

  // ============ 拦截 XMLHttpRequest ============
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    this._method = method;
    this._headers = {};

    // 只记录包含bapi的请求，减少日志
    if (url.includes('/bapi/')) {
      console.log('%cXHR请求:', 'color: blue;', method, url);
    }

    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  // 记录 XHR 的请求头
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    try {
      if (this._url && shouldCaptureHeaders(this._url)) {
        this._headers = this._headers || {};
        this._headers[name] = value;
      }
    } catch (e) {}
    return originalXHRSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const orderId = takeOrderId(this._url || "");
    const responseToken=token;
    const pageUrl = location.href;
    captureOrderRequest(orderId,args[0],responseToken);
    if((this._url || '').includes(HISTORY_PATH))this.addEventListener('load',function(){
      try {post({type:'ALPHA_ORDER_HISTORY',pageUrl,data:JSON.parse(this.responseText)},responseToken);}catch(_) {}
    });
    // 捕获请求头 + 响应体（资产接口）
    if (this._url && shouldCaptureHeaders(this._url)) {
      try {
        captureRequestHeaders(this._url, this._method || 'GET', this._headers || {});

        this.addEventListener('load', function() {
          try {
            const data = JSON.parse(this.responseText);
            post({
              type: 'ALPHA_ASSETS_DATA',
              url: this._url,
              pageUrl,
              data: data
            }, responseToken);
          } catch (e) {}
        });
      } catch (e) {}
    }

    if (this._url && this._url.includes(ORDER_PLACE_PATH)) {
      console.log('%c拦截到目标XHR请求!', 'color: red; font-size: 14px; font-weight: bold;', this._url);

      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          console.log('%cXHR响应数据:', 'color: red; font-size: 14px;', data);
          post({
            type: 'FETCH_RESPONSE',
            unionId: orderId,
            url: this._url,
            data: data
          }, responseToken);
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
