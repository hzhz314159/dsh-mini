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
const short = (o) => { const s = JSON.stringify(o); return s.length > 200 ? s.slice(0, 200) + '...' : s; };

async function main() {
  // agentPreset.read with correct param
  const read = await rpc('agentPreset.read', { agentPreset: 'standard' });
  console.log('agentPreset.read standard:', read.ok ? 'OK' : 'ERR ' + read.error?.code + ': ' + read.error?.message);

  // settings.describe - check schemas now
  const sd = await rpc('settings.describe', {});
  const nss = sd.value?.namespaces || [];
  console.log('\nsettings.describe namespaces:', nss.length);
  for (const n of nss) {
    const schemaKeys = Object.keys(n.schema || {}).slice(0, 10);
    console.log('  ns=' + n.ns, '| schemaKeys=' + JSON.stringify(schemaKeys), '| hasValue=' + (Object.keys(n.value || {}).length > 0));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });