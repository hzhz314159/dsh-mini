async function rpc(base, method, payload) {
  const res = await fetch(base + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: payload || {} })
  });
  return (await res.json()).result;
}

async function main() {
  // Official
  const offi = await rpc('http://127.0.0.1:46321', 'settings.describe');
  const offiNs = offi.value?.namespaces || [];
  console.log('OFFICIAL namespaces:', offiNs.length);
  const uiTheme = offiNs.find(n => n.ns === 'ui-theme');
  console.log('ui-theme schema:', JSON.stringify(uiTheme?.schema)?.slice(0, 400));
  console.log('ui-theme value:', JSON.stringify(uiTheme?.value)?.slice(0, 200));
  const loc = offiNs.find(n => n.ns === 'locale');
  console.log('\nlocale schema:', JSON.stringify(loc?.schema)?.slice(0, 400));
  console.log('locale value:', JSON.stringify(loc?.value)?.slice(0, 200));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });