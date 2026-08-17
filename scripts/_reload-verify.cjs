// CDP reload 并等待，然后验证
const CDP = 'http://127.0.0.1:9222';
(async () => {
  const list = await (await fetch(CDP + '/json')).json();
  const page = list.find(t => t.type === 'page');
  if (!page) { console.log('NO_PAGE'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    }
  };
  await new Promise(r => ws.onopen = r);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 6000));
  const res = await send('Runtime.evaluate', {
    expression: `JSON.stringify({href:location.href.slice(0,50), cssLen:(document.getElementById('dsh-mobile-patch')||{textContent:''}).textContent.length, arrow:!!document.getElementById('dsh-sb-arrow'), backBtn:!!document.getElementById('dsh-back-conn'), title:document.title})`,
    returnByValue: true
  });
  console.log(res.result.value);
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });