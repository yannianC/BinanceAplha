const {test}=require('node:test'),assert=require('node:assert/strict');
const {LocalLog}=require('../local-log.js');
test('logs survive restart, serialize concurrent events and rotate oldest',async()=>{
 let saved=[];const ports={load:async()=>saved,save:async rows=>{saved=structuredClone(rows)},limit:3};
 const log=new LocalLog(ports);await Promise.all([1,2,3,4].map(n=>log.append('order_received',{unionId:String(n)})));
 const restored=new LocalLog(ports);assert.deepEqual((await restored.export()).entries.map(e=>e.data.unionId),['2','3','4']);
});
test('logs select diagnostic fields and exclude credentials and arbitrary payload',async()=>{
 const log=new LocalLog({load:async()=>[],save:async()=>{}});
 await log.append('order_result',{unionId:'u',headers:{cookie:'SECRET'},token:'SECRET',data:{password:'SECRET'},orderData:{code:'ERROR',message:'Authorization: Bearer SECRET',pageDiagnostics:{expected:{price:'1'},after:{values:{limitPrice:'2'}}}}});
 const result=await log.export();assert(!JSON.stringify(result).includes('SECRET'));assert.equal(result.entries[0].data.orderData.pageDiagnostics.after.values.limitPrice,'2');
});
test('storage failures are observable without rejecting trading callers',async()=>{
 const log=new LocalLog({load:async()=>[],save:async()=>{throw Error('quota')}});await log.append('order_received',{unionId:'x'});
 assert.equal((await log.export()).persisted,false);
});
test('byte budget limits large entries independently of entry count',async()=>{
 const log=new LocalLog({load:async()=>[],save:async()=>{},maxChars:1500});for(let i=0;i<10;i++)await log.append('order_result',{unionId:String(i),message:'x'.repeat(2000)});
 const result=await log.export();assert(JSON.stringify(result.entries).length<=1500);assert(result.entries.length<10);
});
test('timestamp is captured before storage delay with millisecond UTC and Beijing time',async()=>{
 let release,now=1794567748508;const log=new LocalLog({load:()=>new Promise(r=>release=r),save:async()=>{},now:()=>now});
 await Promise.resolve();const writing=log.append('submit_clicked',{unionId:'x'});now+=5000;release([]);await writing;
 const row=(await log.export()).entries[0];assert.equal(row.at,1794567748508);assert.equal(row.timestamp,new Date(row.at).toISOString());assert.equal(row.beijingTime,new Date(row.at+28800000).toISOString().replace('T',' ').replace('Z',' +08:00'));
});
