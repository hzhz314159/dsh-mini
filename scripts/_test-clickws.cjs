new Promise((res) => {
  var b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("选择工作区") || x.getAttribute("aria-label") === "选择工作区");
  if (!b) return res("NO_WS_BTN");
  b.click();
  setTimeout(() => {
    res(JSON.stringify({
      body: (document.body.innerText || "").slice(0, 300),
      menuItems: [...document.querySelectorAll("[role=menuitem],[role=option],[class*=menuItem],[class*=workspaceItem]")].map((e) => e.textContent.trim().slice(0, 30)),
      wsExpanded: b.getAttribute("aria-expanded"),
    }));
  }, 1500);
});