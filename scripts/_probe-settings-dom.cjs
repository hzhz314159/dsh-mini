new Promise((res) => {
  // 探查设置页 DOM 结构
  var settingsRoot = document.querySelector("[class*=_settingsRoot],[class*=_settingsContainer],[class*=_settings]") || document.querySelector("[class*=_overlayLayer]");
  if (!settingsRoot) return res("NO_SETTINGS_ROOT");

  // 找所有 section/card
  var sections = [...settingsRoot.querySelectorAll("[class*=_section],[class*=_card],[class*=_panel],[class*=_block]")].slice(0, 12).map((s) => ({
    cls: s.className.slice(0, 50),
    text: (s.textContent || "").slice(0, 60),
    childCount: s.children.length,
    firstChildCls: s.firstElementChild ? s.firstElementChild.className.slice(0, 30) : null,
  }));

  // 找 tab/section header
  var headers = [...settingsRoot.querySelectorAll("button,[role=tab]")].slice(0, 15).map((h) => ({
    text: h.textContent.trim().slice(0, 20),
    cls: h.className.slice(0, 40),
    parentCls: h.parentElement ? h.parentElement.className.slice(0, 40) : null,
  }));

  res(JSON.stringify({ rootCls: settingsRoot.className.slice(0, 50), sections: sections, headers: headers, bodyLen: (document.body.innerText || "").length }));
});