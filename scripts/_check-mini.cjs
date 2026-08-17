const TOKEN = 'a776441024674c18988959905c057fa9';
async function main() {
  const res = await fetch('http://127.0.0.1:46322/api/session.list?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {} })
  });
  const result = (await res.json()).result;
  const items = result?.value?.items || [];
  console.log('count:', items.length);
  for (let i = 0; i < Math.min(3, items.length); i++) {
    const it = items[i];
    console.log('---item', i, '---');
    console.log('sessionId:', it.sessionId?.slice(0, 24));
    console.log('cwd:', it.cwd);
    console.log('running:', it.running);
    console.log('blank:', it.blank);
    console.log('agentPreset:', it.agentPreset);
    console.log('updatedAt:', it.updatedAt);
    console.log('title:', JSON.stringify(it.projections?.values?.title));
    console.log('projKeys:', Object.keys(it.projections?.values || {}).slice(0, 8));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });