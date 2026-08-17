// 阶段0 采集脚本：官方 GUI 前端资产 → dsh-mini 内置目录
// 输入：运行中桌面 manifest（__DSH_BOOT__）+ 安装版 node_modules
// 输出：gui/dist（官方 dist 全量）、gui/bundles/<id>/client.js、gui/manifest.json（内置 boot 清单）
// 用法：node scripts/collect-gui-assets.cjs [--skip-dist]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const GUI = path.join(ROOT, 'gui');
const DIST_SRC = 'C:\\Program Files\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh-web-frontend\\dist';
const NODE_MOD = 'C:\\Program Files\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai';

// 白名单：官方 DSH 前端核心（用户指示：不要第三方/壳增强插件）
const WHITELIST = [
  'dsh-typert-registry','dsh-api-gateway','dsh-session-log-export','dsh-client-hmr',
  'dsh-client-modules','dsh-client-connection','dsh-api-remotes','dsh-client-runtime',
  'dsh-cordis-client-runner','dsh-client-ui-theme','dsh-client-locale','dsh-client-ui-layout',
  'dsh-client-ui-sidebar','dsh-client-ui-settings','dsh-client-ui-settings-general',
  'dsh-client-ui-settings-models','dsh-client-ui-settings-plugin-inventory','dsh-client-ui-conversation',
  'dsh-client-ui-tool','dsh-client-ui-cordis','dsh-client-ui-workflow-run','dsh-client-ui-deliverables',
  'dsh-client-ui-workspace','dsh-client-ui-input-trigger','dsh-client-ui-commands','dsh-client-ui-skill',
  'dsh-client-ui-subagent','dsh-client-ui-jobs','dsh-client-ui-goal','dsh-client-ui-message-feedback',
  'dsh-client-ui-model-selection','dsh-client-ui-permission-presets','dsh-client-ui-agent-preset',
  'dsh-client-ui-settings-plugins','dsh-client-ui-plan','dsh-client-ui-user-questions',
  'dsh-client-ui-trajectory'
];

async function main() {
  const skipDist = process.argv.includes('--skip-dist');

  // 1. 抓运行中 manifest 获得 inject/immediately/rev 官方值
  const html = await (await fetch('http://127.0.0.1:46321/')).text();
  const m = html.match(/window\.__DSH_BOOT__\s*=\s*(\{[\s\S]*?\})<\/script>/);
  if (!m) throw new Error('NO BOOT MANIFEST');
  const live = JSON.parse(m[1]);
  const liveById = new Map(live.entries.map(e => [e.id, e]));

  // 2. 白名单 ∩ 官方 manifest（防缺漏）
  const missing = WHITELIST.filter(id => !liveById.has('@deepseek-ai/' + id));
  if (missing.length) console.log('WARN not in live manifest:', missing.join(', '));

  // 3. 复制 bundles + 重算 rev 校验
  const bundlesDir = path.join(GUI, 'bundles');
  fs.mkdirSync(bundlesDir, { recursive: true });
  const entries = [];
  let revMismatch = 0;
  for (const short of WHITELIST) {
    const id = '@deepseek-ai/' + short;
    const srcClient = path.join(NODE_MOD, short, 'lib', 'client.js');
    if (!fs.existsSync(srcClient)) { console.log('SKIP missing client.js:', id); continue; }
    const content = fs.readFileSync(srcClient);
    const myRev = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
    const liveEntry = liveById.get(id);
    const liveRev = liveEntry ? new URL(liveEntry.url, 'http://x').searchParams.get('rev') : null;
    if (liveRev && liveRev !== myRev) { revMismatch++; console.log(`REV MISMATCH ${id}: live=${liveRev} local=${myRev}`); }
    const outDir = path.join(bundlesDir, id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(srcClient, path.join(outDir, 'client.js'));
    entries.push({
      id,
      url: `/plugins/${id}/client.js?rev=${myRev}`,
      rev: myRev,
      inject: liveEntry ? (liveEntry.inject || []) : [],
      immediately: liveEntry ? !!liveEntry.immediately : false
    });
    console.log(`bundle ${id} ${(content.length/1024).toFixed(0)}KB rev=${myRev}`);
  }
  console.log(`revMismatch=${revMismatch}`);

  // 4. 复制 dist
  let distFiles = 0, distBytes = 0;
  if (!skipDist) {
    const distDst = path.join(GUI, 'dist');
    fs.rmSync(distDst, { recursive: true, force: true });
    fs.cpSync(DIST_SRC, distDst, { recursive: true });
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(distDst)) { distFiles++; distBytes += fs.statSync(f).size; }
    console.log(`dist: ${distFiles} files, ${(distBytes/1024/1024).toFixed(2)}MB`);
  }

  // 5. 生成内置 manifest
  const bundleBytes = entries.reduce((s, e) => s + fs.statSync(path.join(bundlesDir, e.id, 'client.js')).size, 0);
  const bootRev = crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
  const manifest = { rev: bootRev, entries };
  fs.writeFileSync(path.join(GUI, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`manifest.json rev=${bootRev} entries=${entries.length} totalBundleMB=${(bundleBytes/1024/1024).toFixed(2)}`);
  console.log('DONE');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });