/* A successful submission plus a balance change is a reason to recheck the page,
 * not evidence of a fill. Never infer readiness from the asset event alone. */
(function(root){
  function balanceKey(response) {
    if(!response || String(response.code)!=='000000')return null;
    const data=response.data;
    const rows=Array.isArray(data)?data:(data?.list || data?.assets);
    if(!Array.isArray(rows))return null;
    const fields=['chainId','contractAddress','tokenId','symbol','free','freeze','locked','withdrawing','amount'];
    if(rows.some(r=>!r || typeof r!=='object' || !['free','freeze','locked','withdrawing','amount'].some(k=>r[k]!==undefined)))return null;
    return JSON.stringify(rows.map(r=>JSON.stringify(fields.map(k=>r[k]===undefined?'':String(r[k])))).sort());
  }
  class AssetReadiness {
    constructor({busy,check,now=Date.now}){this.busy=busy;this.check=check;this.now=now;this.key=null;this.revision=0;this.generation=0;this.pending=null;this.checking=false;}
    begin(trade){this.pending=null;return {trade,generation:++this.generation,revision:this.revision,at:this.now()};}
    finish(ticket,success){if(ticket.generation===this.generation){if(success)ticket.at=this.now();this.pending=success?ticket:null;}}
    async observe(response){
      const key=balanceKey(response);
      if(key===null)return;
      // A first valid snapshot received after begin is also a fresh asset update.
      if(this.key!==key)this.revision++;
      this.key=key;
      await this.flush();
    }
    async flush(){
      const ticket=this.pending;
      if(!ticket || this.checking || this.busy())return;
      if(this.now()-ticket.at>60000){this.pending=null;return;}
      if(this.revision<=ticket.revision)return;
      this.checking=true;
      try {if(await this.check(ticket.trade) && this.pending===ticket)this.pending=null;}
      catch(_){} // No positive announcement on an unverified page.
      finally {this.checking=false;}
    }
  }
  const api={balanceKey,AssetReadiness};
  if(typeof module!=='undefined' && module.exports)module.exports=api;else root.AlphaAssets=api;
})(globalThis);
