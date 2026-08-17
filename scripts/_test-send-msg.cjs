new Promise(async (res) => {
  var ta = document.querySelector("textarea");
  if (!ta) return res("NO_TEXTAREA");
  // 设置值并触发 React onChange
  var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  nativeInputValueSetter.call(ta, "测试：请只回复'收到'两个字");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  // 点发送按钮
  var sendBtn = document.querySelector(".uV2eYG_primary");
  if (!sendBtn) return res("NO_SEND_BTN");
  sendBtn.click();
  // 等待 AI 回复
  var messages = [];
  for (var i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    var msgs = document.querySelectorAll("[class*=message],[class*=bubble],[class*=turn]");
    messages.push({ t: i * 2, count: msgs.length, body: (document.body.innerText || "").slice(0, 300) });
    if (msgs.length > 0 && i > 2) break;
  }
  res(JSON.stringify({
    taVal: ta.value,
    sendClicked: true,
    messages: messages,
    finalBody: (document.body.innerText || "").slice(0, 400),
  }));
});