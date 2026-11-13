/* Cross-copy window ownership is represented by one visible pinned control tab.
 * Tab IDs elect a single owner even if two copies try to bind simultaneously.
 * Session storage deliberately requires rebinding after a browser restart. */
(function(root) {
  function isMarker(tab) {
    try {const u=new URL(tab.pendingUrl || tab.url);return u.protocol==='chrome-extension:' && u.pathname==='/window-owner.html' && u.hash==='#alpha-window-owner-v1';} catch (_) {return false;}
  }
  class WindowBinding {
    constructor(ports) {this.p=ports;this.busy=false;}
    async bind(windowId) {
      if(this.busy) throw Error('正在绑定，请稍后重试');
      if(!Number.isInteger(windowId) || windowId<0) throw Error('无效窗口');
      this.busy=true;
      let marker;
      try {
        const current=await this.p.load();
        if(current) {
          try {await this.require();if(current.windowId===windowId)return current;throw Error('请先关闭原实例控制标签页，再绑定新窗口');}
          catch(e){if(e.message.includes('请先'))throw e;}
        }
        const existing=(await this.p.query(windowId)).filter(isMarker);
        if(existing.some(t=>new URL(t.pendingUrl || t.url).hostname!==this.p.id))throw Error('此窗口已由其他插件绑定');
        for(const tab of existing) await this.p.remove(tab.id); // Only this copy's stale markers.
        const token=this.p.token();
        const url=`chrome-extension://${this.p.id}/window-owner.html?token=${encodeURIComponent(token)}#alpha-window-owner-v1`;
        marker=await this.p.create(windowId,url);
        const binding={windowId,markerId:marker.id,token,url};
        await this.p.save(binding);
        await this.require();
        return binding;
      } catch(e) {if(marker)await this.p.remove(marker.id).catch(()=>{});throw e;}
      finally {this.busy=false;}
    }
    async require() {
      const b=await this.p.load();
      if(!b)throw Error('尚未绑定窗口，请在目标窗口的插件弹窗中绑定');
      const marker=await this.p.get(b.markerId);
      if(marker.windowId!==b.windowId || (marker.pendingUrl || marker.url)!==b.url)throw Error('绑定已失效，请重新绑定窗口');
      const claims=(await this.p.query(b.windowId)).filter(isMarker).sort((a,b)=>a.id-b.id);
      if(claims[0]?.id!==b.markerId)throw Error('窗口已由其他插件占用');
      return b;
    }
    async authorize(tabId,token) {
      const b=await this.require();
      const tab=await this.p.get(tabId);
      if(tab.windowId!==b.windowId || (token && token!==b.token))throw Error('页面不属于当前绑定窗口');
      return b;
    }
  }
  if(typeof module!=='undefined' && module.exports)module.exports={WindowBinding,isMarker};
  else root.AlphaWindow={WindowBinding,isMarker};
})(globalThis);
