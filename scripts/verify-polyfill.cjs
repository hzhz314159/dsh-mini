// /api/verify-polyfill.cjs — 检查网关根路径注入的 polyfill 与 boot manifest
(async () => {
  const html = await (await fetch("http://127.0.0.1:46322/")).text();
  const polyAt = html.indexOf("__dshPolyfill");
  const bootAt = html.indexOf("__DSH_BOOT__");
  const hasHasOwn = html.includes("Object,'hasOwn'");
  const bootOk = bootAt > -1;
  const orderOk = bootAt < 0 || polyAt < 0 || polyAt < bootAt;
  console.log(JSON.stringify({ polyAt, bootAt, hasHasOwn, bootOk, orderOk, len: html.length }, null, 2));
  // 提取 entries 数
  const m = html.match(/window\.__DSH_BOOT__ = (\{.*?\})<\/script>/s);
  if (m) {
    const boot = JSON.parse(m[1]);
    console.log("entries:", boot.entries.length, "rev:", boot.rev);
  }
})();