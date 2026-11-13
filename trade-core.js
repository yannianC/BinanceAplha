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
  function fingerprint(t) { return JSON.stringify([assetKey(t.url),t.direction,t.price,t.amount,t.coin]); }
  class TradeQueue {
    constructor(ports) {
      this.ports = ports;
      this.now = ports.now || Date.now;
      this.pending = 0;
      this.inflight = new Map();
      this.tail = Promise.resolve();
      this.ready = this.restore();
    }
    async restore() {
      const saved = await this.ports.load();
      this.state = {entries: saved.entries || {}, blocked: !!saved.blocked};
      for (const [id, entry] of Object.entries(this.state.entries)) {
        if (entry.status === 'running') {
          entry.status = 'done';
          entry.result = failure(id,'ORDER_STATUS_UNKNOWN','插件重启前的订单结果不明，请核对币安订单后恢复队列');
          this.state.blocked = true;
        }
      }
      await this.ports.save(this.state);
    }
    async submit(trade) {
      const receivedAt = this.now();
      await this.ready;
      const waiting = this.inflight.get(trade.unionId);
      if (waiting) {
        if (waiting.fingerprint !== fingerprint(trade)) {
          this.ports.report(failure(trade.unionId,'DUPLICATE_ID_CONFLICT','相同订单编号包含不同参数，已拒绝'));
          return;
        }
        await waiting.promise;
        const entry = this.state.entries[trade.unionId];
        if (entry?.result) this.ports.report(entry.result);
        return;
      }
      const completed = Object.hasOwn(this.state.entries,trade.unionId) && this.state.entries[trade.unionId];
      if (completed) {
        this.ports.report(fingerprint(completed.trade) === fingerprint(trade) ? completed.result : failure(trade.unionId,'DUPLICATE_ID_CONFLICT','相同订单编号包含不同参数，已拒绝'));
        return;
      }
      if (this.pending >= 100) {
        this.ports.report(failure(trade.unionId,'QUEUE_FULL','等待队列已满，本指令未执行'));
        return Promise.resolve();
      }
      this.pending++;
      const run = this.tail.then(async () => {
        await this.ready;
        const id = trade.unionId;
        const entries = this.state.entries;
        const previous = Object.hasOwn(entries,id) ? entries[id] : null;
        if (previous) {
          if (fingerprint(previous.trade) !== fingerprint(trade)) {
            this.ports.report(failure(id,'DUPLICATE_ID_CONFLICT','相同订单编号包含不同参数，已拒绝'));
          } else this.ports.report(previous.result);
          return;
        }
        if (this.state.blocked) { this.ports.report(failure(id,'QUEUE_BLOCKED','有结果不明的订单，请在插件中核对并恢复队列')); return; }
        // Keep IDs across restarts. Fail closed rather than silently evicting deduplication records.
        if (Object.keys(entries).length >= 5000) { this.ports.report(failure(id,'JOURNAL_FULL','订单记录已满，请联系维护人员归档')); return; }
        const expired = this.now()-receivedAt > 30000;
        const entry = {trade, status:expired ? 'done' : 'running'};
        if (expired) entry.result = failure(id,'ORDER_EXPIRED','等待超过30秒，本指令未执行');
        Object.defineProperty(entries,id,{value:entry,enumerable:true,writable:true,configurable:true});
        await this.ports.save(this.state); // Durable reservation MUST precede any page action.
        if (expired) { this.ports.report(entry.result); return; }
        let result;
        try { result = await this.ports.execute(trade); }
        catch (_) { result = failure(id,'ORDER_STATUS_UNKNOWN','执行中断或回执超时；请核对订单，禁止自动重下'); }
        if (!result || result.unionId !== id || ![0,1].includes(result.bnResp) || !result.orderData || typeof result.orderData.code !== 'string') result = failure(id,'ORDER_STATUS_UNKNOWN','订单回执不匹配，请核对订单');
        entry.status = 'done';
        entry.result = result;
        if (result.orderData?.code === 'ORDER_STATUS_UNKNOWN') this.state.blocked = true;
        try { await this.ports.save(this.state); }
        catch (e) { this.state.blocked = true; throw e; }
        this.ports.report(result);
      });
      this.tail = run.catch(() => { if (this.state) this.state.blocked = true; });
      const completion = run.finally(()=>{this.pending--;this.inflight.delete(trade.unionId);});
      this.inflight.set(trade.unionId,{fingerprint:fingerprint(trade),promise:completion});
      return completion;
    }
    async status() { await this.ready; return {blocked:this.state.blocked, count:Object.keys(this.state.entries).length}; }
    resume() {
      const run = this.tail.then(async()=>{await this.ready;this.state.blocked=false;await this.ports.save(this.state);});
      this.tail=run.catch(()=>{this.state.blocked=true;});
      return run;
    }
  }
  const api = {assetKey, TradeQueue, failure};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AlphaTrade = api;
})(globalThis);
