const TOKEN = 'a776441024674c18988959905c057fa9';
const BASE = 'http://127.0.0.1:46322';
async function rpc(method, payload) {
  const res = await fetch(BASE + '/api/' + method + '?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: payload || {} })
  });
  const j = await res.json();
  return j.result;
}
async function main() {
  const sl = await rpc('session.list');
  const items = sl?.value?.items || [];
  console.log('session.list count:', items.length);
  const running = items.find(i => i.running) || items[0];
  console.log('using:', running?.sessionId, 'running:', running?.running);
  const models = await rpc('session.models', { sessionId: running.sessionId });
  console.log('models result:', models?.ok ? 'OK' : 'ERR ' + JSON.stringify(models?.error));
  const v = models?.value;
  if (v) {
    console.log('routable:', v.routable, 'failures:', JSON.stringify(v.failures));
    for (const g of v.groups || []) {
      if (g.models && g.models.length) {
        const m = g.models[0];
        console.log('group', g.id, 'model0 reasoning:', JSON.stringify(m.reasoning));
        break;
      }
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });