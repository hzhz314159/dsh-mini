new Promise((res) => {
  var b = document.querySelector(".hHd-Xa_brand");
  if (!b) return res("NO_BTN");
  // 模拟真实 PointerEvent + MouseEvent
  var rect = b.getBoundingClientRect();
  var opts = { bubbles: true, cancelable: true, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2, view: window };
  b.dispatchEvent(new PointerEvent("pointerdown", opts));
  b.dispatchEvent(new MouseEvent("mousedown", opts));
  b.dispatchEvent(new PointerEvent("pointerup", opts));
  b.dispatchEvent(new MouseEvent("mouseup", opts));
  b.dispatchEvent(new MouseEvent("click", opts));
  setTimeout(() => {
    res(JSON.stringify({
      body: (document.body.innerText || "").slice(0, 200),
      taRO: document.querySelector("textarea") ? document.querySelector("textarea").readOnly : "no-ta",
      hasChat: document.querySelectorAll("[class*=message],[class*=conversation],[class*=chat],[class*=turn]").length,
      btns: [...document.querySelectorAll("button")].slice(0, 20).map(x => x.innerText.trim().slice(0, 15)).filter(Boolean),
    }));
  }, 2000);
});