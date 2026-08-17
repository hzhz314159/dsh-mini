// _verify-settings-write.cjs — 验证手机 GUI 设置写入链路（isLoopback 修复后）
// 前提：①真机 CDP 已 forward tcp:9222 ②页面已加载 GUI ③token 在 ~/.dsh/dsh-mini/token.txt
// 用法: node _verify-settings-write.cjs <js-expr>（对真机执行，返回 Results）
// 不直接可独立运行：需配合 cdp-eval 手动执行。本文件为回归巡检参考清单。
const fs = require("fs");
const os = require("os");
const path = require("path");

// host 端 settings.describe 读指定命名空间
async function readNs(token, nsName) {
  const r = await fetch("http://127.0.0.1:46322/api/settings.describe?token=" + token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "r", method: "settings.describe", payload: {} }),
  });
  const j = await r.json();
  const ns = j.result.value.namespaces.find((n) => n.ns === nsName);
  return ns ? ns.value : null;
}

// host 端写设置
async function writeNs(token, nsName, patch) {
  const r = await fetch("http://127.0.0.1:46322/api/settings.update?token=" + token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "w", method: "settings.update", payload: { ns: nsName, patch } }),
  });
  return (await r.json()).result.ok === true;
}

(async () => {
  const tokenFile = path.join(os.homedir(), ".dsh", "dsh-mini", "token.txt");
  if (!fs.existsSync(tokenFile)) {
    console.error("NO_TOKEN", tokenFile);
    process.exit(1);
  }
  const token = fs.readFileSync(tokenFile, "utf8").trim();

  const before = {
    preset: (await readNs(token, "agent-presets"))?.default,
    locale: (await readNs(token, "locale"))?.preference,
    permission: (await readNs(token, "permission"))?.defaultPreset,
    busyEnter: (await readNs(token, "ui-conversation"))?.busyEnter,
  };
  console.log("BEFORE:", JSON.stringify(before));

  // 临时改值（写入 ≠ 原值）
  const targets = [
    { ns: "agent-presets", patch: { default: "code" }, key: "default", expectNot: before.preset },
    { ns: "locale", patch: { preference: "en" }, key: "preference", expectNot: before.locale },
    { ns: "permission", patch: { defaultPreset: "workspace-write" }, key: "defaultPreset", expectNot: before.permission },
    { ns: "ui-conversation", patch: { busyEnter: "steer" }, key: "busyEnter", expectNot: before.busyEnter },
  ];
  const results = [];
  for (const t of targets) {
    const ok = await writeNs(token, t.ns, t.patch);
    const now = (await readNs(token, t.ns))?.[t.key];
    const applied = ok && now !== undefined && ("" + now) !== ("" + t.expectNot);
    results.push({ ns: t.ns, writeOk: ok, hostNow: now, changed: applied ? "YES" : "NO" });
    // 还原
    if (applied) await writeNs(token, t.ns, { [t.key]: before[t.key] });
  }
  console.log("RESULTS:", JSON.stringify(results, null, 2));

  const after = {
    preset: (await readNs(token, "agent-presets"))?.default,
    locale: (await readNs(token, "locale"))?.preference,
    permission: (await readNs(token, "permission"))?.defaultPreset,
    busyEnter: (await readNs(token, "ui-conversation"))?.busyEnter,
  };
  const restored = JSON.stringify(before) === JSON.stringify(after);
  console.log("AFTER:", JSON.stringify(after), "RESTORED:", restored ? "YES" : "NO");
  const allPass = results.every((r) => r.changed === "YES") && restored;
  console.log(allPass ? "ALL_PASS" : "FAIL");
  process.exit(allPass ? 0 : 1);
})();