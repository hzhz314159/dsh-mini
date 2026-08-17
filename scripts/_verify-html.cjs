// 验证 public/index.html：<script> 块 JS 语法 + <style> 块 CSS 括号平衡
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const file = process.argv[2] || path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .filter(b => b.trim().length > 0);
if (scripts.length !== 1) { console.error('FAIL: expected 1 inline <script>, got ' + scripts.length); process.exit(1); }

const tmp = path.join(__dirname, '_check.js');
fs.writeFileSync(tmp, scripts[0], 'utf8');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('JS syntax: OK (' + scripts[0].length + ' chars)');
} catch (e) {
  console.error('FAIL JS syntax:\n' + e.stderr.toString());
  process.exit(1);
}
fs.unlinkSync(tmp);

// CSS 括号平衡
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) { console.error('FAIL: no <style> block'); process.exit(1); }
const css = styleMatch[1];
let depth = 0, min = 0;
for (const ch of css) {
  if (ch === '{') depth++;
  else if (ch === '}') depth--;
  if (depth < min) min = depth;
}
if (depth !== 0) { console.error('FAIL: CSS brace imbalance, depth=' + depth); process.exit(1); }
console.log('CSS braces: balanced (' + css.length + ' chars, min depth ' + min + ')');

// 引用完整性：CSS 里用的 var(--xxx) 是否都在 :root 定义过
const defined = new Set([...css.matchAll(/^(\s*)(--[\w-]+)\s*:/gm)].map(m => m[2]));
const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]));
const missing = [...used].filter(v => !defined.has(v));
if (missing.length) console.log('WARN: var() used but not defined in :root: ' + missing.join(', '));
else console.log('CSS vars: all used vars defined (' + used.size + ' used, ' + defined.size + ' defined)');
console.log('DONE');