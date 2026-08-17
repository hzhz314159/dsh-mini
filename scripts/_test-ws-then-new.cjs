new Promise((res) => {
  // 1. 先点选择工作区展开菜单
  var wsBtn = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "选择工作区");
  if (wsBtn) wsBtn.click();
  setTimeout(() => {
    // 2. 点 DSH Zone 菜单项
    var item = [...document.querySelectorAll("[role=menuitem],[role=option]")].find((e) => e.textContent.includes("DSH Zone"));
    if (item) item.click();
    setTimeout(() => {
      // 3. 点新建会话
      var newBtn = document.querySelector(".hHd-Xa_brand");
      if (newBtn) newBtn.click();
      setTimeout(() => {
        res(JSON.stringify({
          body: (document.body.innerText || "").slice(0, 250),
          taRO: document.querySelector("textarea") ? document.querySelector("textarea").readOnly : "no-ta",
          taVal: document.querySelector("textarea") ? document.querySelector("textarea").value : null,
          hasChat: document.querySelectorAll("[class*=message],[class*=conversation],[class*=chat],[class*=turn]").length,
        }));
      }, 2000);
    }, 1000);
  }, 1500);
});