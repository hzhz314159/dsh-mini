new Promise((res) => {
  var setBtn = document.querySelector(".VOzbGW_trigger");
  if (!setBtn) return res("NO_BTN");
  setBtn.click();
  setTimeout(() => {
    var result = {
      body: (document.body.innerText || "").slice(0, 500),
      tabs: [...document.querySelectorAll("button,[role=tab]")].filter((b) => /通用|模型|插件|Agent|预设|权限|外观|语言|搜索/.test(b.textContent)).map((b) => ({ text: b.textContent.trim().slice(0, 20), display: getComputedStyle(b).display, vis: getComputedStyle(b).visibility })),
      sectionCount: document.querySelectorAll("[class*=_section],[class*=_card],[class*=_panel]").length,
    };
    res(JSON.stringify(result));
  }, 2500);
});