const TOKEN = 'a776441024674c18988959905c057fa9';
const BASE = 'http://127.0.0.1:46322';

async function rpc(method, payload) {
  const res = await fetch(BASE + '/api/' + method + '?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: payload || {} })
  });
  const j = await res.json();
  const v = j.result;
  const short = (o) => {
    const s = JSON.stringify(o);
    return s.length > 300 ? s.slice(0, 300) + '...' : s;
  };
  console.log('\n=== ' + method + ' ===');
  if (v && v.ok) {
    console.log('OK:', short(v.value));
  } else {
    console.log('ERR:', v && v.error ? v.error.code + ': ' + v.error.message : 'no result', '| details:', v?.error?.details ? short(v.error.details) : '-');
  }
}

async function main() {
  // agentPreset
  await rpc('agentPreset.list');
  await rpc('agentPreset.read', { id: 'standard' });
  // settings describe for various namespaces
  await rpc('settings.describe', { namespace: 'permission' });
  await rpc('settings.describe', { namespace: 'ui-conversation' });
  await rpc('settings.describe', { namespace: 'agent-presets' });
  await rpc('settings.describe', { namespace: 'agent-loop' });
  // credentials (model providers)
  await rpc('credentials.describe');
  // llm
  await rpc('llm.providerOptions', {});
  await rpc('llm.providers');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });