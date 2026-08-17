// 探测官方模型选择弹窗的推理档结构
const HTTP = require('http');
function getTargets() {
  return new Promise((resolve, reject) => {
    HTTP.get('http://127.0.0.1:9222/json', (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
async function main() {
  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page');
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1; const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = id++; pending.set(mid, { res, rej });
    sock.send(JSON.stringify({ id: mid, method, params }));
  });
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(msg.error) : p.res(msg.result); }
  };
  await new Promise(r => sock.onopen = r);
  // Click the model trigger
  const expr = `(function(){
    var all = document.querySelectorAll('*');
    var trig = null;
    for (var i=0;i<all.length;i++){ var c=all[i].className; if(typeof c==='string'&&c.indexOf('7KE1Ra_trigger')>=0&&c.indexOf('root')<0&&c.indexOf('Label')<0){trig=all[i];break} }
    if(!trig) return 'NO_TRIGGER';
    trig.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    return 'clicked';
  })()`;
  const r1 = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('trigger:', r1.result?.value);
  await new Promise(r => setTimeout(r, 800));
  // Now dump all visible text blocks > 60px
  const dump = `(function(){
    var out = [];
    var all = document.querySelectorAll('div');
    for (var i=0;i<all.length;i++){
      var el = all[i];
      var rc = el.getBoundingClientRect();
      if (rc.width < 150 || rc.height < 40) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0') continue;
      var t = (el.textContent||'').trim().replace(/\\s+/g,' ');
      if (!t || t.length < 8 || t.length > 600) continue;
      out.push((el.className||'').toString().slice(0,40) + ' :: ' + t.slice(0,100));
    }
    return out.join('\\n---\\n');
  })()`;
  const r2 = await send('Runtime.evaluate', { expression: dump, returnByValue: true });
  console.log('\n=== VISIBLE BLOCKS ===');
  console.log(r2.result?.value?.slice(0, 3000));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });