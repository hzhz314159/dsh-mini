// 验证 12 项 UI 补丁在真机上的效果
const WS = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/json');
// Actually use http to get the page target
const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page');
  if (!page) { console.log('NO PAGE TARGET'); process.exit(1); }

  const wsUrl = page.webSocketDebuggerUrl;
  const sock = new WS(wsUrl);

  let id = 1;
  const pending = new Map();

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      pending.set(msgId, { resolve, reject });
      sock.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  sock.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error); else resolve(msg.result);
    }
  });

  await new Promise(r => sock.on('open', r));

  // Enable Page for reload
  await send('Page.enable');

  // Reload
  await send('Page.reload', {});

  // Wait for load
  await new Promise(r => setTimeout(r, 4000));

  // Run verification checks
  const checks = await send('Runtime.evaluate', {
    expression: `(function(){
      var r = {};
      // Toggle button
      r.toggleBtn = !!document.getElementById('dsh-sb-toggle');
      // Scrim
      r.scrim = !!document.querySelector('.dsh-scrim');
      // Sidebar display
      var sb = document.querySelector('.pI_x6G_sidebarCol');
      r.sidebarDisplay = sb ? getComputedStyle(sb).display : 'NOT_FOUND';
      // Details column
      var dc = document.querySelector('.pI_x6G_detailsCol');
      r.detailsDisplay = dc ? getComputedStyle(dc).display : 'NOT_FOUND';
      // Preview badge
      var pb = document.querySelector('.pXSMma_previewBadge');
      r.previewBadgeDisplay = pb ? getComputedStyle(pb).display : 'NOT_FOUND';
      // Session log
      var sl = document.querySelector('.nL4_yW_sessionLogButton');
      r.sessionLogDisplay = sl ? getComputedStyle(sl).display : 'NOT_FOUND';
      // Settings nav cells
      var navCells = document.querySelectorAll('.VOzbGW_navCell');
      r.navCellCount = navCells.length;
      r.navCell3Display = navCells[2] ? getComputedStyle(navCells[2]).display : 'N/A';
      r.navCell4Display = navCells[3] ? getComputedStyle(navCells[3]).display : 'N/A';
      // Settings panel direction
      var panel = document.querySelector('.VOzbGW_panel');
      r.panelDirection = panel ? getComputedStyle(panel).flexDirection : 'NOT_FOUND';
      // Input box
      var input = document.querySelector('.uV2eYG_input');
      r.inputFound = !!input;
      r.inputUserSelect = input ? getComputedStyle(input).userSelect : 'N/A';
      r.inputPointerEvents = input ? getComputedStyle(input).pointerEvents : 'N/A';
      // Root content
      r.rootChildren = document.getElementById('root') ? document.getElementById('root').childElementCount : 0;
      r.bodyLen = document.body ? document.body.innerHTML.length : 0;
      r.title = document.title;
      return JSON.stringify(r);
    })()`,
    returnByValue: true
  });

  console.log('Result:', checks.result.value);

  // Test toggle button click
  const toggleResult = await send('Runtime.evaluate', {
    expression: `(function(){
      var btn = document.getElementById('dsh-sb-toggle');
      if(!btn) return 'NO_BTN';
      btn.click();
      var open = document.body.classList.contains('dsh-sb-open');
      var sb = document.querySelector('.pI_x6G_sidebarCol');
      var sbDisplay = sb ? getComputedStyle(sb).display : 'N/A';
      var sbPos = sb ? getComputedStyle(sb).position : 'N/A';
      return JSON.stringify({open:open, sbDisplay:sbDisplay, sbPos:sbPos});
    })()`,
    returnByValue: true
  });
  console.log('Toggle:', toggleResult.result.value);

  // Close sidebar
  await send('Runtime.evaluate', {
    expression: `document.body.classList.remove('dsh-sb-open')`,
    returnByValue: true
  });

  sock.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
