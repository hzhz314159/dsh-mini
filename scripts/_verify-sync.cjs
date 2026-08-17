// 验证同步功能：workspace.list / session.list / session.selectModel
const TOKEN = 'a776441024674c18988959905c057fa9';
const BASE = 'http://127.0.0.1:46322';

async function rpc(method, payload) {
  const res = await fetch(BASE + '/api/' + method + '?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: payload || {} })
  });
  const j = await res.json();
  return j;
}

async function main() {
  // 1. workspace.list
  const ws = await rpc('workspace.list');
  console.log('workspace.list:', JSON.stringify(ws.result?.value || ws.result?.error || 'ERR'));

  // 2. session.list (first 5 items)
  const sl = await rpc('session.list');
  const items = sl.result?.value?.items || [];
  console.log('session.list count:', items.length);
  if (items.length > 0) {
    console.log('first 3:', items.slice(0, 3).map(i => ({
      id: i.sessionId?.slice(0, 12),
      title: i.projections?.values?.title?.title?.slice(0, 30),
      cwd: i.cwd,
      running: i.running
    })));
  }

  // 3. session.models for first session
  if (items.length > 0) {
    const sid = items[0].sessionId;
    const models = await rpc('session.models', { sessionId: sid });
    console.log('session.models:', JSON.stringify(models.result?.value || models.result?.error || 'ERR'));
  }

  // 4. llm.providers + llm.models
  const providers = await rpc('llm.providers');
  console.log('llm.providers count:', providers.result?.value?.providers?.length || 0);
  
  if (providers.result?.value?.providers?.length > 0) {
    const pid = providers.result.value.providers[0].id;
    const models = await rpc('llm.models', { provider: pid });
    console.log('llm.models for', pid, ':', JSON.stringify(models.result?.value || models.result?.error || 'ERR'));
  }

  // 5. host.describe
  const desc = await rpc('host.describe');
  console.log('host.describe:', JSON.stringify(desc.result?.value || desc.result?.error || 'ERR'));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
