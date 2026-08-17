// 对比官方 vs dsh-mini session.list 第一个 item 完整结构
async function callApi(base, method, payload) {
  const res = await fetch(base + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: payload || {} })
  });
  return (await res.json()).result;
}

async function main() {
  // Official
  const offi = await callApi('http://127.0.0.1:46321', 'session.list');
  const offiItem = offi?.value?.items?.[0];
  console.log('=== OFFICIAL first item ===');
  console.log(JSON.stringify(offiItem, null, 1)?.slice(0, 800));

  // dsh-mini
  const mini = await callApi('http://127.0.0.1:46322/api?token=a776441024674c18988959905c057fa9'.replace('/api?token=a776441024674c18988959905c057fa9',''), 'session.list');
  
  // Actually call dsh-mini with token in header
  const miniRes = await fetch('http://127.0.0.1:46322/api/session.list?token=a776441024674c18988959905c057fa9', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {} })
  });
  const miniResult = (await miniRes.json()).result;
  const miniItem = miniResult?.value?.items?.[0];
  console.log('\n=== DSH-MINI first item ===');
  console.log(JSON.stringify(miniItem, null, 1)?.slice(0, 800));

  // Compare specific fields
  if (offiItem && miniItem) {
    console.log('\n=== FIELD COMPARISON ===');
    const fields = ['sessionId', 'cwd', 'updatedAt', 'running', 'blank', 'parentSessionId', 'agentPreset'];
    for (const f of fields) {
      console.log(f + ':', 'official=' + JSON.stringify(offiItem[f]), '| mini=' + JSON.stringify(miniItem[f]));
    }
    console.log('projections.keys official:', Object.keys(offiItem.projections?.values || {}));
    console.log('projections.keys mini:', Object.keys(miniItem.projections?.values || {}));
    console.log('title official:', JSON.stringify(offiItem.projections?.values?.title));
    console.log('title mini:', JSON.stringify(miniItem.projections?.values?.title));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
