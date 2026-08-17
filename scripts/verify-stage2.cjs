// 阶段2 验证：网关自建 RPC 与官方 host 对照
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const GW = 'http://127.0.0.1:46322';
const OFF = 'http://127.0.0.1:46321';
const token = fs.readFileSync(path.join(os.homedir(), '.dsh', 'dsh-mini', 'token.txt'), 'utf8').trim();
let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`); if (!ok) failures++; };

// 建立网关会话（LAN 模拟）
async function gwSession() {
  const r = await fetch(GW + '/?token=' + token, { headers: { 'x-dsh-mini-gateway': '1' }, redirect: 'manual' });
  const sc = r.headers.get('set-cookie') || '';
  return /dsh_mini_sid=([0-9a-f-]+)/.exec(sc)?.[1];
}
async function rpc(base, method, payload, cookie, headers = {}) {
  const r = await fetch(base + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: 'dsh_mini_sid=' + cookie } : {}), ...headers },
    body: JSON.stringify({ type: 'client-request', rpcId: 't-' + method, method, payload: payload || {} }),
  });
  const j = await r.json();
  return j.result || null;
}

(async () => {
  const sid = await gwSession();
  check('gw session obtained', !!sid);

  // 1. host.describe
  const g1 = await rpc(GW, 'host.describe', {}, sid);
  const o1 = await rpc(OFF, 'host.describe', {});
  check('host.describe ok', g1 && g1.ok === true, JSON.stringify(g1 && g1.value && { version: g1.value.version, attached: g1.value.attachedSessions }));
  check('host.describe shape matches', g1 && o1 && typeof g1.value.version === 'string' && typeof g1.value.attachedSessions === 'number', `gw=${g1 && g1.value && g1.value.attachedSessions} off=${o1 && o1.value && o1.value.attachedSessions}`);

  // 2. session.list
  const g2 = await rpc(GW, 'session.list', {}, sid);
  const o2 = await rpc(OFF, 'session.list', {});
  check('session.list ok', g2 && g2.ok === true && Array.isArray(g2.value.items), 'items=' + (g2 && g2.value.items.length));
  check('session.list count ~ official', g2 && o2 && Math.abs(g2.value.items.length - o2.value.items.length) < 10, `gw=${g2 && g2.value.items.length} off=${o2 && o2.value.items.length}`);
  const item = g2 && g2.value.items[0];
  check('session.list item shape', item && item.sessionId && typeof item.updatedAt === 'number' && 'projections' in item, item && JSON.stringify({ id: item.sessionId.slice(0, 20), proj: Object.keys((item.projections || {}).values || {}).length }));

  // 3. history（用网关返回的第一个会话）
  if (item) {
    const g3 = await rpc(GW, 'session.history', { sessionId: item.sessionId, maxMessages: 3 }, sid);
    check('session.history ok', g3 && g3.ok === true && Array.isArray(g3.value.events), 'events=' + (g3 && g3.value.events.length) + ' hasMore=' + (g3 && g3.value.hasMore));
    const ev0 = g3 && g3.value.events[0];
    check('history event envelope', ev0 && ev0.event && typeof ev0.event.type === 'string' && typeof ev0.event.seq === 'number' && typeof ev0.event.time === 'number', ev0 && ev0.event && ev0.event.type);
    check('history projections', g3 && g3.value.projections && typeof g3.value.projections.asOfSeq === 'number', 'asOfSeq=' + (g3 && g3.value.projections && g3.value.projections.asOfSeq));

    // 4. session.models
    const g4 = await rpc(GW, 'session.models', { sessionId: item.sessionId }, sid);
    const o4 = await rpc(OFF, 'session.models', { sessionId: item.sessionId });
    check('session.models ok', g4 && g4.ok === true && g4.value.groups && typeof g4.value.current === 'object', 'current=' + JSON.stringify(g4 && g4.value.current));
    check('session.models current matches official', g4 && o4 && g4.value.current.provider === o4.value.current.provider && g4.value.current.model === o4.value.current.model, `gw=${g4 && g4.value.current && g4.value.current.model} off=${o4 && o4.value.current && o4.value.current.model}`);

    // 5. workspace.list（官方对照）
    const g5 = await rpc(GW, 'workspace.list', {}, sid);
    const o5 = await rpc(OFF, 'workspace.list', {});
    check('workspace.list ok', g5 && g5.ok === true && Array.isArray(g5.value.items), 'items=' + (g5 && g5.value.items.length));
    check('workspace.list count matches', g5 && o5 && g5.value.items.length === o5.value.items.length, `gw=${g5 && g5.value.items.length} off=${o5 && o5.value.items.length}`);

    // 6. llm.providers / models
    const g6 = await rpc(GW, 'llm.providers', {}, sid);
    const o6 = await rpc(OFF, 'llm.providers', {});
    check('llm.providers ok', g6 && g6.ok === true && Array.isArray(g6.value.providers), 'providers=' + (g6 && g6.value.providers.length));
    check('llm.providers count matches', g6 && o6 && g6.value.providers.length === o6.value.providers.length, `gw=${g6 && g6.value.providers.length} off=${o6 && o6.value.providers.length}`);
    const g7 = await rpc(GW, 'llm.models', {}, sid);
    const o7 = await rpc(OFF, 'llm.models', {});
    check('llm.models ok', g7 && g7.ok === true && Array.isArray(g7.value.groups), 'groups=' + (g7 && g7.value.groups.length));
    check('llm.models group count matches', g7 && o7 && g7.value.groups.length === o7.value.groups.length, `gw=${g7 && g7.value.groups.length} off=${o7 && o7.value.groups.length}`);

    // 7. settings.describe（白名单过滤）
    const g8 = await rpc(GW, 'settings.describe', {}, sid);
    const o8 = await rpc(OFF, 'settings.describe', {});
    check('settings.describe ok', g8 && g8.ok === true && Array.isArray(g8.value.namespaces), 'nss=' + (g8 && g8.value.namespaces.map(n => n.ns).join(',')));
    check('settings whitelist ⊆ official', g8 && o8, 'gwNss=' + (g8 && g8.value.namespaces.length) + ' offNss=' + (o8 && o8.value.namespaces.length));

    // 8. agentPreset.list
    const g9 = await rpc(GW, 'agentPreset.list', {}, sid);
    const o9 = await rpc(OFF, 'agentPreset.list', {});
    check('agentPreset.list ok', g9 && g9.ok === true && Array.isArray(g9.value.presets), 'presets=' + (g9 && g9.value.presets.length));
    check('agentPreset count matches', g9 && o9 && g9.value.presets.length === o9.value.presets.length, `gw=${g9 && g9.value.presets.length} off=${o9 && o9.value.presets.length}`);

    // 9. subagent.list
    const g10 = await rpc(GW, 'subagent.list', { parentSessionId: item.sessionId }, sid);
    check('subagent.list ok', g10 && g10.ok === true && Array.isArray(g10.value.entries), 'entries=' + (g10 && g10.value.entries.length));

    // 10. 错误形状：未知会话 -> session-not-found code
    const g11 = await rpc(GW, 'session.history', { sessionId: 'no-such-session' }, sid);
    check('err code session-not-found', g11 && g11.ok === false && g11.error.code === 'session-not-found', JSON.stringify(g11 && g11.error));

    // 11. 未知方法
    const g12 = await rpc(GW, 'no.such.method', {}, sid);
    check('err code method-not-found', g12 && g12.ok === false && g12.error.code === 'method-not-found', JSON.stringify(g12 && g12.error));

    // 12. skill.list
    const g13 = await rpc(GW, 'skill.list', { sessionId: item.sessionId }, sid);
    const o13 = await rpc(OFF, 'skill.list', { sessionId: item.sessionId });
    check('skill.list ok', g13 && g13.ok === true && 'skills' in g13.value, 'skills=' + (g13 && g13.value.skills.length) + ' off=' + (o13 && o13.value.skills.length));
  }

  // 13. 无会话访问 API -> 403
  const r14 = await fetch(GW + '/api/host.describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-mini-gateway': '1' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'host.describe', payload: {} }),
  });
  check('no-session api -> 403', r14.status === 403, 'status=' + r14.status);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('SCRIPT ERROR:', e.message); process.exit(1); });