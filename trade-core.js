/* Order policy shared by the worker and page. No browser or network dependencies. */
(function(root) {
  function assetKey(raw) {
    const u = new URL(raw);
    const m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?alpha\/([a-z0-9_-]+)\/([a-zA-Z0-9_-]+)\/?$/i.exec(u.pathname);
    if (u.origin !== 'https://www.binance.com' || !m) throw Error('无效的币安 Alpha 币种网址');
    const address = /^0x[0-9a-f]+$/i.test(m[2]) ? m[2].toLowerCase() : m[2];
    return m[1].toLowerCase() + '/' + address;
  }
  function failure(id, code, message) { return {unionId:id,bnResp:0,orderData:{code,message}}; }
  // The server owns deduplication and retries. This queue only serializes page actions.
  class TradeQueue {
    constructor(ports) {
      this.ports = ports;
      this.pending = 0;
      this.tail = Promise.resolve();
      this.ready = this.restore();
    }
    async persist() {
      try { await this.ports.save(this.state); }
      catch (_) { /* Diagnostic persistence must not gate server commands. */ }
    }
    async restore() {
      let saved = {};
      try { saved = await this.ports.load() || {}; } catch (_) {}
      this.state = {entries: saved.entries || {}, blocked:false};
      for (const [id, entry] of Object.entries(this.state.entries)) {
        if (entry.status === 'running') {
          entry.status = 'done';
          entry.result = failure(id,'ORDER_STATUS_UNKNOWN','插件重启前的订单结果未确认，由服务器决定后续操作');
        }
      }
      await this.persist();
    }
    async submit(trade) {
      await this.ready;
      if (this.pending >= 100) {
        this.ports.report(failure(trade.unionId,'QUEUE_FULL','等待队列已满，本指令未执行'));
        return;
      }
      this.pending++;
      const run = this.tail.then(async () => {
        const id = trade.unionId;
        const entry = {trade, status:'running', at:Date.now()};
        // Keep only the latest attempt for each server ID, for diagnostics, never admission.
        delete this.state.entries[id];
        Object.defineProperty(this.state.entries,id,{value:entry,enumerable:true,writable:true,configurable:true});
        const keys = Object.keys(this.state.entries);
        for (const key of keys.slice(0, Math.max(0, keys.length-5000))) delete this.state.entries[key];
        await this.persist();
        let result;
        try { result = await this.ports.execute(trade); }
        catch (_) { result = failure(id,'ORDER_STATUS_UNKNOWN','执行中断或回执超时，由服务器决定后续操作'); }
        if (!result || result.unionId !== id || ![0,1].includes(result.bnResp) || !result.orderData || typeof result.orderData.code !== 'string') result = failure(id,'ORDER_STATUS_UNKNOWN','订单回执不匹配，由服务器决定后续操作');
        entry.status = 'done';
        entry.result = result;
        await this.persist();
        this.ports.report(result);
      });
      this.tail = run.catch(() => {});
      return run.finally(()=>{this.pending--;});
    }
    async status() { await this.ready; return {blocked:false, count:Object.keys(this.state.entries).length, pending:this.pending}; }
  }
  const api = {assetKey, TradeQueue, failure};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AlphaTrade = api;
})(globalThis);
