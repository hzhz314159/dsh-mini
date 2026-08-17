// 阶段2 契约探查：黑盒调用官方 host（127.0.0.1:46321）采集真实 RPC 返回形状
// 输出 gui-api-samples.json —— dsh-mini 自建 API 的行为参照 + 阶段5 回归夹具
'use strict';
const fs = require('fs');
const path = require('path');
const BASE = 'http://127.0.0.1:46321';
let rpcId = 1000;
async function call(method, payload, { verbose = false } = {}) {
  const id = 'probe-' + (rpcId++);
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload: payload || {} }),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* noop */ }
  const out = { http: r.status, envelope: j };
  if (verbose) console.log(`[${method}] http=${r.status} rpcId=${out.envelope && out.envelope.rpcId} ok=${out.envelope && out.envelope.result && out.envelope.result.ok}`);
  return out;
}
const trunc = (o, n = 220) => JSON.stringify(o)?.slice(0, n);

(async () => {
  const samples = {};

  // ----- 只读高频方法 -----
  let r = await call('host.describe');
  samples['host.describe'] = r;
  console.log('host.describe:', trunc(r.envelope && r.envelope.result));

  r = await call('session.list');
  samples['session.list'] = r;
  console.log('session.list items=', r.envelope && r.envelope.result && r.envelope.result.ok ? r.envelope.result.value.items.length : 'ERR');
  const s0 = r.envelope?.result?.ok ? r.envelope.result.value.items[0] : null;
  if (s0) console.log('  sample item:', trunc(s0, 420));

  r = await call('workspace.list');
  samples['workspace.list'] = r;
  console.log('workspace.list:', trunc(r.envelope && r.envelope.result, 300));

  r = await call('settings.describe');
  samples['settings.describe'] = r;
  console.log('settings.describe writable=', r.envelope?.result?.ok && r.envelope.result.value.writable, 'nss=', r.envelope?.result?.ok && r.envelope.result.value.namespaces.map(n => `${n.ns}:r${n.revision}`).join(','));

  r = await call('credentials.describe', { refs: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'] });
  samples['credentials.describe'] = r;
  console.log('credentials.describe:', trunc(r.envelope && r.envelope.result, 260));

  r = await call('llm.providers');
  samples['llm.providers'] = r;
  console.log('llm.providers providers=', r.envelope?.result?.ok && r.envelope.result.value.providers.length, trunc(r.envelope?.result?.ok && r.envelope.result.value.providers[0], 200));

  r = await call('llm.models');
  samples['llm.models'] = r;
  console.log('llm.models groups=', r.envelope?.result?.ok && r.envelope.result.value.groups.length, 'failures=', r.envelope?.result?.ok && r.envelope.result.value.failures.length);
  const g0 = r.envelope?.result?.ok && r.envelope.result.value.groups[0];
  if (g0) console.log('  group0:', trunc(g0, 300));

  // ----- session 详情（用第一个真实会话） -----
  if (s0) {
    const sid = s0.sessionId;
    r = await call('session.history', { sessionId: sid, maxMessages: 3 });
    samples['session.history'] = r;
    const evts = r.envelope?.result?.ok ? r.envelope.result.value.events : [];
    console.log('session.history events=', evts.length, 'hasMore=', r.envelope?.result?.ok && r.envelope.result.value.hasMore);
    if (evts[0]) console.log('  event0:', trunc(evts[0], 500));
    if (evts[1]) console.log('  event1:', trunc(evts[1], 500));
    const proj = r.envelope?.result?.ok && r.envelope.result.value.projections;
    if (proj) console.log('  projections asOfSeq=', proj.asOfSeq, 'keys=', Object.keys(proj.values || {}).join(','));

    r = await call('session.models', { sessionId: sid });
    samples['session.models'] = r;
    console.log('session.models:', trunc(r.envelope && r.envelope.result, 400));

    r = await call('session.search', { query: '你好' });
    samples['session.search'] = r;
    console.log('session.search:', trunc(r.envelope && r.envelope.result, 200));

    r = await call('subagent.list', { parentSessionId: sid });
    samples['subagent.list'] = r;
    console.log('subagent.list:', trunc(r.envelope && r.envelope.result, 300));

    r = await call('skill.list', { sessionId: sid });
    samples['skill.list'] = r;
    console.log('skill.list skills=', r.envelope?.result?.ok && r.envelope.result.value.skills.length, trunc(r.envelope?.result?.ok && r.envelope.result.value.skills[0], 150));

    r = await call('agentPreset.list');
    samples['agentPreset.list'] = r;
    console.log('agentPreset.list:', trunc(r.envelope && r.envelope.result, 400));
  }

  // ----- 错误形状 -----
  r = await call('session.history', { sessionId: 'no-such-session' });
  samples['err.unknown-session'] = r;
  console.log('err unknown session:', trunc(r.envelope && r.envelope.result, 200));

  r = await call('session.prompt', { sessionId: 'x', mode: 'steer', content: [] });
  samples['err.bad-payload'] = r;
  console.log('err bad payload:', trunc(r.envelope && r.envelope.result, 200));

  fs.writeFileSync(path.join(__dirname, '..', 'gui-api-samples.json'), JSON.stringify(samples, null, 2));
  console.log('\nSAMPLES SAVED -> gui-api-samples.json');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });