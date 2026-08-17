new Promise((res) => {
  var b = document.querySelector(".hHd-Xa_newSession");
  if (!b) return res("NO_NEWSESSION_BTN");
  b.click();
  setTimeout(() => {
    res(JSON.stringify({
      body: (document.body.innerText || "").slice(0, 250),
      taRO: document.querySelector("textarea") ? document.querySelector("textarea").readOnly : "no-ta",
      hasChat: document.querySelectorAll("[class*=message],[class*=conversation],[class*=chat],[class*=turn]").length,
      taPlaceholder: document.querySelector("textarea") ? document.querySelector("textarea").placeholder : null,
    }));
  }, 2500);
});