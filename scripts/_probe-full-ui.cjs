new Promise((res) => {
  var result = {};
  // 1. frame grid 结构
  var frame = document.querySelector("[data-details-collapsed]");
  result.frame = {
    cls: frame ? frame.className : null,
    grid: frame ? frame.style.cssText : null,
    detailsCollapsed: frame ? frame.getAttribute("data-details-collapsed") : null,
  };
  // 2. 侧栏
  var sidebar = document.querySelector(".hHd-Xa_root");
  result.sidebar = {
    exists: !!sidebar,
    width: sidebar ? sidebar.style.width : null,
    text: sidebar ? sidebar.innerText.slice(0, 200) : null,
    collapsed: sidebar ? sidebar.classList.contains("hHd-Xa_collapsed") : null,
  };
  // 3. 预览版 badge
  var badge = document.querySelector(".pXSMma_previewBadge");
  result.previewBadge = {
    exists: !!badge,
    text: badge ? badge.textContent.trim() : null,
    parent: badge ? badge.parentElement.className : null,
    html: badge ? badge.outerHTML.slice(0, 120) : null,
  };
  // 4. composer
  var ta = document.querySelector("textarea");
  result.composer = {
    exists: !!ta,
    readOnly: ta ? ta.readOnly : null,
    disabled: ta ? ta.disabled : null,
    placeholder: ta ? ta.placeholder : null,
    className: ta ? ta.className : null,
    parentChain: ta ? (function(){var p=ta.parentElement,s=[];for(var i=0;i<5&&p;i++){s.push(p.className.slice(0,40));p=p.parentElement}return s})() : null,
  };
  // 5. 设置页 tabs
  result.settings = {
    tabs: [...document.querySelectorAll("[role=tab],[class*=tab],[class*=Tab],[class*=sectionTab]")].map(e => e.textContent.trim().slice(0, 20)).filter(Boolean),
    sectionBtns: [...document.querySelectorAll("button")].filter(b => /通用|模型|插件|Agent|预设/.test(b.textContent)).map(b => ({text: b.textContent.trim().slice(0, 20), cls: b.className.slice(0, 40)})),
  };
  // 6. 右侧栏
  result.rightSidebar = {
    detailsCol: !!document.querySelector("[class*=detailsCol],[class*=details]"),
    gridThirdCol: frame ? frame.style.cssText.match(/grid-template-columns:\s*([^;]+)/) : null,
  };
  // 7. 所有顶层按钮（侧栏+顶栏）
  result.allButtons = [...document.querySelectorAll("button")].slice(0, 30).map(b => ({
    text: b.textContent.trim().slice(0, 20) || "(icon)",
    cls: b.className.slice(0, 30),
    aria: b.getAttribute("aria-label"),
  }));
  res(JSON.stringify(result));
});