// Create an unpacked copy with a stable unique Chrome ID. No private keys are saved.
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const [destination,label]=process.argv.slice(2);
if(!destination || !label)throw Error('Usage: node scripts/make-instance.cjs /absolute/new/directory instance-label');
const root=path.resolve(__dirname,'..'),out=path.resolve(destination);
if(fs.existsSync(out))throw Error('Destination exists; refusing to overwrite an installed instance');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const {publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const der=publicKey.export({type:'spki',format:'der'});
manifest.key=der.toString('base64');manifest.name+=' '+label;
const files=['background.js','local-log.js','content.js','injected.js','trade-core.js','window-binding.js','asset-readiness.js','window-owner.html','instance-ui.js','popup.html','popup.js','ws-config.js','icon.png','使用说明.txt'];
fs.mkdirSync(out,{recursive:true});for(const name of files)fs.copyFileSync(path.join(root,name),path.join(out,name));
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const id=crypto.createHash('sha256').update(der).digest('hex').slice(0,32).replace(/[0-9a-f]/g,n=>String.fromCharCode(97+parseInt(n,16)));
console.log(JSON.stringify({directory:out,extensionId:id,label}));
