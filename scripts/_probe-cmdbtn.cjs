// 捕获点击命令按钮时的前端错误
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
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text || '').slice(0, 300));
    }
  };
  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable');
  await send('Runtime.evaluate', { expression: `document.querySelector('.uV2eYG_add').click(); 'ok'` });
  await new Promise(r => setTimeout(r, 1500));
  const res = await send('Runtime.evaluate', {
    expression: `JSON.stringify({expanded: (document.querySelector('.uV2eYG_add')||{}).getAttribute?.('aria-expanded'), menus: document.querySelectorAll('[role=listbox],[role=menu],[class*=command]').length})`,
    returnByValue: true
  });
  console.log('STATE', res.result.value);
  console.log('ERRORS:', JSON.stringify(errors));
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });