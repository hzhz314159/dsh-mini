// 阶段1 验证 v2：网关 GUI 应用服务器全链路
// LAN 场景用 x-dsh-mini-gateway:1 头模拟（真实手机经网关进来的 remoteAddress 是回环，
// 必须靠该头区分；无头+回环 = 本机直连，免鉴权——桌面测试便利，属设计行为）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const BASE = 'http://127.0.0.1:46322';
const token = fs.readFileSync(path.join(os.homedir(), '.dsh', 'dsh-mini', 'token.txt'), 'utf8').trim();
let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`); if (!ok) failures++; };
const LAN = { 'x-dsh-mini-gateway': '1' };
const cookieFor = sid => ({ cookie: 'dsh_mini_sid=' + sid, ...LAN });

(async () => {
  // 1. 本机直连（无网关头）-> 200 免鉴权（桌面测试便利）
  let r = await fetch(BASE + '/');
  check('loopback direct / -> 200', r.status === 200, 'status=' + r.status);

  // 2. LAN 无 token -> 403
  r = await fetch(BASE + '/', { headers: LAN });
  check('lan no-token / -> 403', r.status === 403, 'status=' + r.status);

  // 3. LAN ?token= -> 302 + Set-Cookie
  r = await fetch(BASE + '/?token=' + token, { headers: LAN, redirect: 'manual' });
  const setCook = r.headers.get('set-cookie') || '';
  check('lan ?token= -> 302', r.status === 302, 'status=' + r.status);
  check('Set-Cookie dsh_mini_sid HttpOnly', /dsh_mini_sid=[0-9a-f-]+; Path=\/; HttpOnly/.test(setCook), setCook.slice(0, 60));
  const sid = /dsh_mini_sid=([0-9a-f-]+)/.exec(setCook)?.[1];
  check('redirect strips token', !(r.headers.get('location') || '').includes('token='), r.headers.get('location'));

  // 4. 带 cookie -> 200 + boot manifest
  r = await fetch(BASE + '/', { headers: cookieFor(sid) });
  const html = await r.text();
  check('cookie / -> 200', r.status === 200 && html.includes('<div id="root">'), 'status=' + r.status + ' len=' + html.length);
  const bootM = /window\.__DSH_BOOT__\s*=\s*(\{[\s\S]*?\})<\/script>/.exec(html);
  check('boot manifest injected', !!bootM);
  let boot = null;
  if (bootM) { try { boot = JSON.parse(bootM[1]); } catch { /* noop */ } }
  check('boot 37 entries', boot && boot.entries.length === 37, 'entries=' + (boot && boot.entries.length));
  check('boot rev present', !!boot && !!boot.rev, boot && boot.rev);
  const e0 = boot && boot.entries[0];
  check('entry shape', e0 && e0.id && e0.url && e0.rev && typeof e0.immediately === 'boolean', e0 && e0.url);
  check('immediately count (expect 9, no client-hmr dup ok)', boot && boot.entries.filter(e => e.immediately).length >= 9, 'im=' + (boot && boot.entries.filter(e => e.immediately).length));

  // 5. LAN 无 cookie 访问 assets -> 403（会话门槛一致性）
  r = await fetch(BASE + '/assets/index-Dqw48FrP.js', { headers: LAN });
  check('lan no-session assets -> 403', r.status === 403, 'status=' + r.status);

  // 6. 静态资源（带 cookie）
  r = await fetch(BASE + '/assets/index-Dqw48FrP.js', { headers: cookieFor(sid) });
  const js = await r.text();
  check('assets js 200', r.status === 200 && js.length > 100000, 'status=' + r.status + ' len=' + js.length);
  r = await fetch(BASE + '/assets/index-CSGf6Qzd.css', { headers: cookieFor(sid) });
  check('assets css 200', r.status === 200 && (r.headers.get('content-type') || '').includes('text/css'), 'status=' + r.status);
  r = await fetch(BASE + '/favicon.svg', { headers: cookieFor(sid) });
  check('favicon 200', r.status === 200, 'status=' + r.status);
  r = await fetch(BASE + '/manifest.webmanifest', { headers: cookieFor(sid) });
  check('manifest.webmanifest 200', r.status === 200, 'status=' + r.status);

  // 7. plugin bundle
  r = await fetch(BASE + '/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=fdd41b0168e3', { headers: cookieFor(sid) });
  const b = await r.text();
  check('plugin bundle 200', r.status === 200 && b.includes('__ModuleLoader__'), 'status=' + r.status + ' len=' + b.length);
  r = await fetch(BASE + '/plugins/nope/client.js', { headers: cookieFor(sid) });
  check('unknown bundle 404', r.status === 404, 'status=' + r.status);

  // 8. 旧协议兼容（LAN 带 token 走 /dsh-mini 代理）
  r = await fetch(BASE + '/dsh-mini/api/health?token=' + token, { headers: LAN });
  let j = null; try { j = await r.json(); } catch { /* noop */ }
  check('legacy /dsh-mini/api/health via gw -> 200', r.status === 200 && j && j.ok === true, 'status=' + r.status + ' ' + JSON.stringify(j).slice(0, 60));

  // 9. 404/穿越
  r = await fetch(BASE + '/whatever', { headers: cookieFor(sid) });
  check('unknown path 404', r.status === 404, 'status=' + r.status);
  r = await fetch(BASE + '/assets/../package.json', { headers: cookieFor(sid) });
  check('path traversal rejected', r.status === 404 || r.status === 403, 'status=' + r.status);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('SCRIPT ERROR:', e.message); process.exit(1); });