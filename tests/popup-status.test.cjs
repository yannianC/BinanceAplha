const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
 const elements={},dom=[],requests=[],listeners=[];
 const document={getElementById:id=>elements[id] ||= {value:'',addEventListener(type,fn){this[type]=fn}},addEventListener:(_,fn)=>dom.push(fn)};
 let poll;
 const chrome={runtime:{sendMessage:(m,cb)=>requests.push({m,cb}),onMessage:{addListener:fn=>listeners.push(fn)}}};
 const ctx=vm.createContext({document,chrome,WS_CONFIG:{load:async()=>({}),parseNumber:()=>true},setInterval:fn=>poll=fn,clearTimeout(){}});
 vm.runInContext(fs.readFileSync('popup.js','utf8'),ctx);dom[0]();
 const queries=()=>requests.filter(x=>x.m.action==='getConnectionStatus');
 return {elements,requests,queries,poll:()=>poll(),event:()=>listeners[0]({action:'updateStatus'})};
}
const open={connected:true,message:'WebSocket: 已连接'};
test('opening popup reads live state; notifications and polling reconcile it',()=>{
 const f=fixture();assert.equal(f.queries().length,1);f.queries()[0].cb(open);assert.equal(f.elements.status.textContent,open.message);
 f.event();f.queries().at(-1).cb({connected:false,message:'WebSocket: 未连接'});assert.equal(f.elements.status.className,'status disconnected');
 f.poll();f.queries().at(-1).cb(open);assert.equal(f.elements.status.className,'status connected');
});
test('connect acknowledgement cannot overwrite established state; stale query is ignored',()=>{
 const f=fixture();f.queries()[0].cb(open);f.elements.browserNumber.value='23-1';f.elements.connectBtn.click();
 f.requests.find(x=>x.m.action==='connectWS').cb({success:true});assert.equal(f.elements.status.textContent,open.message);
 const stale=f.queries().at(-1);f.event();f.queries().at(-1).cb(open);stale.cb({connected:false,message:'WebSocket: 正在连接...'});
 assert.equal(f.elements.status.textContent,open.message);
});
