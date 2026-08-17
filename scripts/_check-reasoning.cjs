const TOKEN = 'a776441024674c18988959905c057fa9';
const BASE = 'http://127.0.0.1:46322';
async function rpc(method, payload) {
  const res = await fetch(BASE + '/api/' + method + '?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: payload || {} })
  });
  return (await res.json()).result;
}
async function main() {
  const sl = await rpc('session.list');
  const sid = sl.value?.items?.[0]?.sessionId;
  console.log('sessionId:', sid);
  const models = await rpc('session.models', { sessionId: sid });
  const v = models.value;
  console.log('routable:', v?.routable, 'failures:', JSON.stringify(v?.failures));
  // Check first group's models for reasoning field
  for (const g of v?.groups || []) {
    const m = g.models[0];
    console.log('group', g.id, 'model0 keys:', m ? Object.keys(m).join(',') : 'none');
    if (m) console.log('  reasoning:', JSON.stringify(m.reasoning));
    break;
  }
  // Also check llm.resolveModelInfo directly
  const info = await rpc('llm.resolveModelInfo', { provider: 'opencode-go', model: 'deepseek-v4-flash' });
  console.log('\nresolveModelInfo:', JSON.stringify(info.value)?.slice(0, 500));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });