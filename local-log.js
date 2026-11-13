/* Bounded per-extension diagnostics. Never store raw messages, headers or credentials. */
(function(root){
  const allowed=new Set('unionId attemptId instanceNumber version chainName address price amt amount direction coin symbol tabId windowId stage code message error reason bnResp healthy canTrade isreadySent refreshed checkedAt type expected preparationErrors attempt at formCheck id actual exists disabled readOnly visible stableChecks elapsedMs beforeSubmit after values limitPrice limitAmount limitTotal balanceHints pageDiagnostics orderData historyCheck queried matched candidates orderId side origQty executedQty status time updateTime'.split(' '));
  function clean(value,depth=0){
    if(depth>8)return undefined;
    if(typeof value==='string')return value.replace(/(?:authorization|cookie|csrftoken|password|secret|token)\s*[:=]\s*[^\n]*/gi,'[REDACTED]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').slice(0,800);
    if(typeof value==='boolean' || typeof value==='number' || value===null)return value;
    if(Array.isArray(value))return value.slice(0,10).map(v=>clean(v,depth+1));
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>allowed.has(k)).map(([k,v])=>[k,clean(v,depth+1)]));
  }
  class LocalLog {
    constructor({load,save,limit=1000,maxChars=500000,now=Date.now}){
      this.save=save;this.limit=limit;this.maxChars=maxChars;this.now=now;this.rows=[];this.persisted=true;this.dropped=0;this.pending=0;
      this.tail=Promise.resolve().then(load).then(rows=>{this.rows=Array.isArray(rows)?rows:[];this.trim();}).catch(()=>{this.persisted=false;});
    }
    trim(){
      if(this.rows.length>this.limit)this.rows.splice(0,this.rows.length-this.limit);
      let size=JSON.stringify(this.rows).length;
      while(this.rows.length && size>this.maxChars){size-=JSON.stringify(this.rows.shift()).length+1;}
    }
    append(event,data={}){
      if(this.pending>=100){this.dropped++;return Promise.resolve();}
      // Capture at the event, before asynchronous storage operations.
      const at=this.now(),timestamp=new Date(at).toISOString();
      const beijingTime=new Date(at+8*3600000).toISOString().replace('T',' ').replace('Z',' +08:00');
      const row={at,timestamp,beijingTime,event:String(event).slice(0,80),data:clean(data)};
      this.pending++;
      this.tail=this.tail.then(async()=>{this.rows.push(row);this.trim();await this.save(this.rows);this.persisted=true;}).catch(()=>{this.persisted=false;}).finally(()=>{this.pending--;});
      return this.tail;
    }
    async export(){await this.tail;return {entries:JSON.parse(JSON.stringify(this.rows)),persisted:this.persisted,dropped:this.dropped,limit:this.limit};}
  }
  const api={LocalLog};if(typeof module!=='undefined' && module.exports)module.exports=api;else root.AlphaLocalLog=api;
})(globalThis);
