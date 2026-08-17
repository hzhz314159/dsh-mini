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
  const items = sl.value?.items || [];
  // Show first 3 items fully
  for (let i = 0; i < Math.min(3, items.length); i++) {
    const item = items[i];
    console.log('---item', i, '---');
    console.log('sessionId:', item.sessionId);
    console.log('cwd:', item.cwd);
    console.log('running:', item.running);
    console.log('blank:', item.blank);
    console.log('updatedAt:', item.updatedAt);
    console.log('projections keys:', Object.keys(item.projections?.values || {}));
    console.log('title projection:', JSON.stringify(item.projections?.values?.title));
    console.log('sessionStats:', JSON.stringify(item.projections?.values?.sessionStats)?.slice(0, 100));
  }
  
  // Check official API for comparison
  const officialRes = await fetch('http://127.0.0.1:46321/api/session.list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {} })
  });
  const official = (await officialRes.json()).result;
  const officialItems = official?.value?.items || [];
  console.log('\n--- OFFICIAL session.list count:', officialItems.length, '---');
  if (officialItems.length > 0) {
    const item = officialItems[0];
    console.log('sessionId:', item.sessionId);
    console.log('cwd:', item.cwd);
    console.log('projections keys:', Object.keys(item.projections?.values || {}));
    console.log('title:', JSON.stringify(item.projections?.values?.title));
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
