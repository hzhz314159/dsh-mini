new Promise((res) => {
  // 侧栏已 display:none 隐藏——用 JS 直接展开
  var col = document.querySelector(".pI_x6G_sidebarCol");
  if (col) {
    col.style.display = "";
    col.style.position = "fixed";
    col.style.left = "0";
    col.style.top = "0";
    col.style.bottom = "0";
    col.style.zIndex = "200";
  }
  setTimeout(() => {
    // 点设置按钮
    var setBtn = document.querySelector(".VOzbGW_trigger");
    if (!setBtn) { res("NO_SETTINGS_BTN"); return; }
    setBtn.click();
    setTimeout(() => {
      // 点模型 tab
      var modelTab = [...document.querySelectorAll(".VOzbGW_navCell")].find((c) => c.textContent.trim() === "模型");
      if (!modelTab) { res(JSON.stringify({ err: "no model tab", tabs: [...document.querySelectorAll(".VOzbGW_navCell")].map((c) => c.textContent.trim()) })); return; }
      modelTab.click();
      setTimeout(() => {
        res(JSON.stringify({
          body: (document.body.innerText || "").slice(0, 500),
          modelChips: [...document.querySelectorAll("[class*=modelChip],[class*=modelItem],[class*=providerName],[class*=modelName]")].slice(0, 10).map((e) => e.textContent.trim().slice(0, 40)),
        }));
      }, 2500);
    }, 1200);
  }, 400);
});