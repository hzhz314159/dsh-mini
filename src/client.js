// dsh-mini — 桌面客户端半边（浏览器 bundle，零构建）
//
// 职责：
//   1) 左侧栏 footer 手机图标（sidebar.footer.action，order 210，渲染在
//      side-session 的「临时会话」图标上方）→ 网关未开启时点击自动跳转
//      DSH 设置页；已开启时弹出二维码面板（系统相机 / DSH Mini 应用扫码）。
//   2) 设置页分节（settings.section，order 70）：局域网网关开关、token
//      显示/重置、绑定地址与端口、二维码预览、上传限额、连接自检。
//   3) 余额转发：监听 Desktop 壳的 "dsh-balance-changed" 事件 + 周期性
//      refreshBalance()，把余额数据 POST 到 host 缓存供手机余额圆环读取
//      （dsh-balance 无 host API，插件只能走 client 半边）。
//
// 实现约束：客户端插件 require 只能取平台 seed 模块（跨插件值导入是构建
// 错误），本文件全部代码内联（含 vendored MIT QR 编码器 qrcode-generator，
// Kazuhiko Arase / http://www.d-project.com/，见 vendor/qrcode.js 头部注释）。

window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-mini",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var reactDom = require("react-dom/client");
    var jsxRuntime = require("react/jsx-runtime");
    var jsx = jsxRuntime.jsx;
    var jsxs = jsxRuntime.jsxs;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    // startup beacon: fires the moment this bundle's factory materializes
    var BUNDLE_REV = 4;
    (function () {
      try {
        fetch("/dsh-mini/api/client-beacon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ev: "factory", msg: "bundle factory materialized rev=" + BUNDLE_REV }),
          keepalive: true,
        }).catch(function () {});
      } catch (e) {
        /* diagnostic only */
      }
    })();

    // ------------------------------------------------------------------
    // vendored QR encoder (MIT, Kazuhiko Arase) — isolated in an IIFE so
    // its UMD tail (`module.exports = factory()`) cannot hijack our
    // plugin's module.exports (that bug silently dropped name/apply/inject
    // and made the client fiber never activate).
    // ------------------------------------------------------------------
    var qrcode = (function () {
      var module = { exports: {} };
      var exports = module.exports;
      var define;
      /*__QRCODE_LIB__*/
      return module.exports;
    })();

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      if (children.length === 0) return jsx(type, props || {});
      if (children.length === 1)
        return jsx(type, Object.assign({}, props || {}, { children: children[0] }));
      return jsxs(type, Object.assign({}, props || {}, { children: children }));
    }

    // ------------------------------------------------------------------
    // 单例 store + subscribe
    // ------------------------------------------------------------------
    var store = {
      overlayOpen: false,
      gateway: null,
      gatewayLoading: false,
      error: "",
      busy: false,
      notice: "",
    };
    var listeners = new Set();
    function setState(patch) {
      Object.assign(store, patch);
      listeners.forEach(function (l) {
        l();
      });
    }
    function subscribe(l) {
      listeners.add(l);
      return function () {
        listeners.delete(l);
      };
    }
    function useStore() {
      var force = useState(0)[1];
      useEffect(function () {
        return subscribe(function () {
          force(function (x) {
            return x + 1;
          });
        });
      }, []);
      return store;
    }

    // ------------------------------------------------------------------
    // host API（同源回环，免 token）
    // ------------------------------------------------------------------
    function apiJson(path, opts) {
      return fetch(path, Object.assign({ cache: "no-store" }, opts || {})).then(function (r) {
        return r.json().catch(function () {
          return { error: "HTTP " + r.status };
        });
      });
    }
    function refreshGateway(silent) {
      if (!silent) setState({ gatewayLoading: true });
      return apiJson("/dsh-mini/api/gateway")
        .then(function (d) {
          setState({ gateway: d.gateway || null, gatewayLoading: false, error: d.error || "" });
          return d.gateway;
        })
        .catch(function (e) {
          setState({ gatewayLoading: false, error: String((e && e.message) || e) });
          return null;
        });
    }
    function postConfig(patch) {
      setState({ busy: true, error: "" });
      return apiJson("/dsh-mini/api/gateway/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
        .then(function (d) {
          setState({ gateway: d.gateway || null, busy: false, error: d.error || "", notice: d.ok ? "已保存" : "" });
        })
        .catch(function (e) {
          setState({ busy: false, error: String((e && e.message) || e) });
        });
    }
    function resetToken() {
      setState({ busy: true, error: "" });
      return apiJson("/dsh-mini/api/gateway/token/reset", { method: "POST" })
        .then(function (d) {
          setState({ busy: false, error: d.error || "", notice: d.ok ? "token 已重置（LAN 设备需重新扫码连接）" : "" });
          return refreshGateway();
        })
        .catch(function (e) {
          setState({ busy: false, error: String((e && e.message) || e) });
        });
    }

    // ------------------------------------------------------------------
    // 打开 DSH 设置页（点 settings 触发按钮；找不到则回退 aria-label 匹配）
    // ------------------------------------------------------------------
    function openSettingsPage() {
      try {
        var btn = document.querySelector("button.VOzbGW_trigger");
        if (btn) {
          btn.click();
          return true;
        }
        var all = Array.prototype.slice.call(document.querySelectorAll("button"));
        for (var i = 0; i < all.length; i++) {
          var label = (all[i].getAttribute("aria-label") || "") + " " + (all[i].textContent || "");
          if (/设置|Settings/i.test(label)) {
            all[i].click();
            return true;
          }
        }
      } catch (e) {
        console.warn("[dsh-mini] openSettingsPage failed: " + String((e && e.message) || e));
      }
      return false;
    }

    // ------------------------------------------------------------------
    // 二维码渲染（canvas）
    // ------------------------------------------------------------------
    function renderQr(text, canvas) {
      if (!canvas || !text) {
        beacon("qr-skip", "canvas=" + Boolean(canvas) + " text=" + Boolean(text));
        return;
      }
      try {
        var qr = qrcode(0, "M");
        qr.addData(text);
        qr.make();
        var n = qr.getModuleCount();
        var size = 232;
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = "#101014";
        var cell = size / n;
        for (var r = 0; r < n; r++) {
          for (var c = 0; c < n; c++) {
            if (qr.isDark(r, c)) {
              ctx.fillRect(Math.floor(c * cell), Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
            }
          }
        }
        beacon("qr-ok", "modules=" + n + " url=" + text.slice(0, 60));
      } catch (e) {
        beacon("qr-fail", String((e && e.message) || e));
        console.warn("[dsh-mini] QR render failed: " + String((e && e.message) || e));
      }
    }

    // ------------------------------------------------------------------
    // 二维码弹窗（body 根挂载，仿 side-session 浮窗做法）
    // ------------------------------------------------------------------
    function QrOverlay() {
      var s = useStore();
      var canvasRef = useRef(null);
      var gw = s.gateway || {};
      useEffect(
        function () {
          if (s.overlayOpen) refreshGateway();
        },
        [s.overlayOpen]
      );
      useEffect(
        function () {
          if (s.overlayOpen && gw.url && canvasRef.current) {
            beacon("qr-overlay", "url=" + gw.url.slice(0, 60));
            renderQr(gw.url, canvasRef.current);
          } else {
            beacon("qr-overlay-skip", "open=" + s.overlayOpen + " url=" + Boolean(gw.url) + " canvas=" + Boolean(canvasRef.current));
          }
        },
        [s.overlayOpen, gw.url]
      );
      var copyState = useState("");
      var setCopy = copyState[1];
      if (!s.overlayOpen) return null;
      return h(
        "div",
        {
          className: "dsm-mask",
          onClick: function () {
            setState({ overlayOpen: false });
          },
        },
        h(
          "div",
          { className: "dsm-dialog", onClick: function (e) { e.stopPropagation(); } },
          h("div", { className: "dsm-dialog-title" }, "手机连接 DSH Mini"),
          gw.lanEnabled
            ? h(
                "div",
                { className: "dsm-qr-wrap" },
                gw.reachable
                  ? h("canvas", { ref: canvasRef, className: "dsm-qr" })
                  : h(
                      "div",
                      { className: "dsm-warn" },
                      gw.bindWarn || "网关不可达：请检查 DSH web 绑定地址（需 0.0.0.0）。"
                    )
              )
            : h(
                "div",
                { className: "dsm-off" },
                h("div", { className: "dsm-off-title" }, "局域网网关未开启"),
                h("div", { className: "dsm-off-hint" }, "开启后此处将显示二维码，手机扫码即可连接。"),
                h(
                  "button",
                  {
                    type: "button",
                    className: "dsm-btn dsm-btn-primary",
                    onClick: function () {
                      setState({ overlayOpen: false });
                      openSettingsPage();
                    },
                  },
                  "前往设置开启网关"
                )
              ),
          gw.lanEnabled && gw.url
            ? h(
                "div",
                { className: "dsm-url-row" },
                h("input", { className: "dsm-url", readOnly: true, value: gw.url, onFocus: function (e) { e.target.select(); } }),
                h(
                  "button",
                  {
                    type: "button",
                    className: "dsm-btn",
                    onClick: function () {
                      try {
                        navigator.clipboard.writeText(gw.url).then(function () {
                          setCopy("已复制");
                          setTimeout(function () { setCopy(""); }, 1500);
                        });
                      } catch (e) {
                        /* ignore */
                      }
                    },
                  },
                  copyState[0] || "复制"
                )
              )
            : null,
          h(
            "div",
            { className: "dsm-status-row" },
            h("span", null, "主服务 " + (gw.host || "?") + ":" + (gw.port || "?")),
            gw.lanEnabled
              ? h(
                  "span",
                  null,
                  "网关 " +
                    (gw.gatewayListening
                      ? "0.0.0.0:" + (gw.gatewayPort != null ? gw.gatewayPort : "?")
                      : "未监听") +
                    (gw.lanIps && gw.lanIps.length ? " · LAN " + gw.lanIps.join(", ") : "")
                )
              : null,
            h("span", { className: gw.reachable ? "dsm-ok" : "dsm-bad" }, gw.reachable ? "手机可访问" : gw.lanEnabled ? "手机不可访问" : "仅本机")
          ),
          h("div", { className: "dsm-hint" }, "用手机系统相机扫码，或在 DSH Mini 应用内扫码连接（连接需同一 Wi-Fi）。"),
          h(
            "div",
            { className: "dsm-actions" },
            h(
              "button",
              {
                type: "button",
                className: "dsm-btn",
                onClick: function () {
                  setState({ overlayOpen: false });
                  openSettingsPage();
                },
              },
              "打开设置"
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsm-btn dsm-btn-primary",
                onClick: function () {
                  setState({ overlayOpen: false });
                },
              },
              "关闭"
            )
          )
        )
      );
    }

    // ------------------------------------------------------------------
    // 侧栏 footer 手机图标（sidebar.footer.action）
    // ------------------------------------------------------------------
    var footerRenderBeacon = false;
    var settingsRenderBeacon = false;
    function FooterIcon(props) {
      if (!footerRenderBeacon) {
        footerRenderBeacon = true;
        beacon("slot-footer-render", "FooterIcon rendered");
      }
      var s = useStore();
      var wide = !!(props && props.wide);
      return h(
        "button",
        {
          type: "button",
          className: "dsm-footer-icon",
          "data-rail": wide ? "0" : "1",
          title: "手机连接",
          "aria-haspopup": "dialog",
          onClick: function () {
            // 未配置（网关关闭）→ 跳设置页；已配置 → 弹二维码
            beacon("footer-click", "clicked");
            refreshGateway().then(function (gw) {
              beacon("footer-click", "gw=" + JSON.stringify({ ok: Boolean(gw), lan: gw && gw.lanEnabled, url: gw && gw.url ? gw.url.slice(0, 30) : null }));
              if (!gw) {
                setState({ overlayOpen: true });
              } else if (gw.lanEnabled !== true) {
                openSettingsPage();
              } else {
                setState({ overlayOpen: true });
              }
            });
          },
        },
        h(
          "svg",
          {
            width: wide ? "16" : "18",
            height: wide ? "16" : "18",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          },
          h("rect", { x: "5", y: "2", width: "14", height: "20", rx: "2", ry: "2" }),
          h("path", { d: "M12 18h.01" })
        ),
        wide ? h("span", { className: "dsm-footer-label" }, "手机连接") : null
      );
    }

    // ------------------------------------------------------------------
    // 设置页分节（settings.section）
    // ------------------------------------------------------------------
    function SettingsCard() {
      if (!settingsRenderBeacon) {
        settingsRenderBeacon = true;
        beacon("slot-settings-render", "SettingsCard rendered");
      }
      var s = useStore();
      var gw = s.gateway || {};
      var canvasRef = useRef(null);
      var maxDraftState = useState(gw.maxUploadMb != null ? String(gw.maxUploadMb) : "20");
      var maxDraft = maxDraftState[0];
      var setMaxDraft = maxDraftState[1];
      var portDraftState = useState(gw.gatewayPort != null ? String(gw.gatewayPort) : "46322");
      var portDraft = portDraftState[0];
      var setPortDraft = portDraftState[1];
      var showTokenState = useState(false);
      var showToken = showTokenState[0];
      var setShowToken = showTokenState[1];
      useEffect(function () {
        refreshGateway();
      }, []);
      useEffect(
        function () {
          if (gw.gatewayPort != null) setPortDraft(String(gw.gatewayPort));
        },
        [gw.gatewayPort]
      );
      useEffect(
        function () {
          if (gw.url && canvasRef.current) {
            beacon("qr-settings", "url=" + gw.url.slice(0, 60));
            renderQr(gw.url, canvasRef.current);
          } else {
            beacon("qr-settings-skip", "url=" + Boolean(gw.url) + " canvas=" + Boolean(canvasRef.current));
          }
        },
        [gw.url]
      );
      return h(
        "div",
        { className: "dsm-settings" },
        h(
          "div",
          { className: "dsm-set-row" },
          h("div", { className: "dsm-set-label" }, "局域网网关"),
          h(
            "label",
            { className: "dsm-switch" },
            h("input", {
              type: "checkbox",
              checked: gw.lanEnabled === true,
              disabled: s.busy,
              onChange: function (e) {
                postConfig({ lanEnabled: e.target.checked });
              },
            }),
            h("span", { className: "dsm-switch-slider" })
          ),
          h("div", { className: "dsm-set-hint" }, "开启后手机可通过局域网访问本机 DSH（网关独立监听 0.0.0.0，主服务绑定不变）。")
        ),
        h(
          "div",
          { className: "dsm-set-row" },
          h("div", { className: "dsm-set-label" }, "网关端口"),
          h(
            "input",
            {
              className: "dsm-set-input dsm-set-input-num",
              type: "number",
              min: "1024",
              max: "65535",
              value: portDraft,
              onChange: function (e) {
                setPortDraft(e.target.value);
              },
            }
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsm-btn",
              disabled: s.busy,
              onClick: function () {
                postConfig({ gatewayPort: Number(portDraft) });
              },
            },
            "应用"
          ),
          h(
            "div",
            { className: "dsm-set-hint" },
            "网关独立监听 0.0.0.0（默认 46322），仅转发 /dsh-mini；主服务 " +
              (gw.host || "?") + ":" + (gw.port || "?") +
              " 保持回环不变。改动后网关自动重启。"
          )
        ),
        h(
          "div",
          { className: "dsm-set-row" },
          h("div", { className: "dsm-set-label" }, "连接状态"),
          h(
            "div",
            { className: "dsm-set-value" },
            gw.gatewayListening
              ? "网关监听中 0.0.0.0:" + (gw.gatewayPort != null ? gw.gatewayPort : "?") + " · LAN IP: " + (gw.lanIps && gw.lanIps.length ? gw.lanIps.join(", ") : "未检测到")
              : "网关未监听"
          ),
          gw.bindWarn ? h("div", { className: "dsm-set-warn" }, gw.bindWarn) : null
        ),
        gw.lanEnabled
          ? h(
              "div",
              { className: "dsm-set-row" },
              h("div", { className: "dsm-set-label" }, "扫码连接"),
              h("canvas", { ref: canvasRef, className: "dsm-qr-sm" }),
              h(
                "div",
                { className: "dsm-set-hint" },
                "手机系统相机扫码，或 DSH Mini 应用内扫码。" + (gw.reachable ? "" : "（网关未就绪或未检测到局域网 IP，手机无法访问）")
              )
            )
          : null,
        h(
          "div",
          { className: "dsm-set-row" },
          h("div", { className: "dsm-set-label" }, "连接密钥"),
          h(
            "div",
            { className: "dsm-token-row" },
            h(
              "input",
              {
                className: "dsm-set-input",
                readOnly: true,
                type: showToken ? "text" : "password",
                value: gw.token || "",
                onFocus: function (e) {
                  e.target.select();
                },
              }
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsm-btn",
                onClick: function () {
                  setShowToken(!showToken);
                },
              },
              showToken ? "隐藏" : "显示"
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsm-btn",
                disabled: s.busy,
                onClick: function () {
                  resetToken();
                },
              },
              "重置"
            )
          ),
          h("div", { className: "dsm-set-hint" }, "重置后 LAN 设备需重新扫码；本机回环不受影响。")
        ),
        h(
          "div",
          { className: "dsm-set-row" },
          h("div", { className: "dsm-set-label" }, "上传限额 (MB)"),
          h(
            "input",
            {
              className: "dsm-set-input dsm-set-input-num",
              type: "number",
              min: "1",
              max: "100",
              value: maxDraft,
              onChange: function (e) {
                setMaxDraft(e.target.value);
              },
            }
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsm-btn",
              disabled: s.busy,
              onClick: function () {
                postConfig({ maxUploadMb: Number(maxDraft) });
              },
            },
            "应用"
          ),
          h("div", { className: "dsm-set-hint" }, "手机端附件上传的单文件上限（1–100 MB）。")
        ),
        h(
          "div",
          { className: "dsm-set-row" },
          h("div", { className: "dsm-set-label" }, "状态"),
          h(
            "button",
            {
              type: "button",
              className: "dsm-btn",
              disabled: s.gatewayLoading,
              onClick: function () {
                refreshGateway();
              },
            },
            "重新检测"
          ),
          h("div", { className: "dsm-set-hint" }, "版本 " + (gw.version || "?") + (s.notice ? " · " + s.notice : "") + (s.error ? " · 错误：" + s.error : ""))
        )
      );
    }

    // ------------------------------------------------------------------
    // 余额转发（Desktop 壳 → host 缓存 → 手机）
    // ------------------------------------------------------------------
    function setupBalanceForwarder() {
      if (typeof window === "undefined") return function () {};
      var forward = function (detail) {
        try {
          fetch("/dsh-mini/api/balance/report", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(detail || null),
            cache: "no-store",
          }).catch(function () {
            /* host not ready yet */
          });
        } catch (e) {
          /* ignore */
        }
      };
      var onBalance = function (e) {
        forward(e && e.detail);
      };
      window.addEventListener("dsh-balance-changed", onBalance);
      var poll = function () {
        try {
          if (window.dshDesktop && typeof window.dshDesktop.refreshBalance === "function") {
            window.dshDesktop.refreshBalance();
          }
        } catch (e) {
          /* ignore */
        }
      };
      var t = setInterval(poll, 60000);
      poll();
      return function () {
        window.removeEventListener("dsh-balance-changed", onBalance);
        clearInterval(t);
      };
    }

    // ------------------------------------------------------------------
    // CSS 注入（同 side-session 模式：style[data-plugin-css] 幂等）
    // ------------------------------------------------------------------
    var CSS_TAG = "@deepseek-ai/dsh-mini/client.css";
    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]")) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "@deepseek-ai/dsh-mini";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent =
        ".dsm-mask{position:fixed;inset:0;z-index:1200;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}" +
        ".dsm-dialog{width:min(420px,calc(100vw - 32px));background:var(--dsw-alias-bg-layer-2,#1b1b22);border-radius:20px;box-shadow:var(--dsw-shadow-lv3,0 16px 48px rgba(0,0,0,.4));padding:20px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,#f2f2f7)}" +
        ".dsm-dialog-title{font-size:16px;font-weight:600;line-height:24px}" +
        ".dsm-qr-wrap{display:flex;align-items:center;justify-content:center;padding:12px;background:#fff;border-radius:14px}" +
        ".dsm-qr{display:block;width:232px;height:232px}" +
        ".dsm-qr-sm{display:block;width:120px;height:120px;background:#fff;border-radius:10px}" +
        ".dsm-url-row{display:flex;gap:8px}" +
        ".dsm-url{flex:1;min-width:0;font-size:12px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-line,#333);background:transparent;color:inherit}" +
        ".dsm-status-row{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#9a9aa5)}" +
        ".dsm-ok{color:var(--dsw-alias-state-success-primary,#3fbf7f)}.dsm-bad{color:var(--dsw-alias-state-error-primary,#e5484d)}" +
        ".dsm-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#9a9aa5)}" +
        ".dsm-warn{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);padding:10px}" +
        ".dsm-off{display:flex;flex-direction:column;gap:6px;align-items:center;padding:16px 8px;text-align:center}" +
        ".dsm-off-title{font-size:14px;font-weight:600}.dsm-off-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#9a9aa5)}" +
        ".dsm-actions{display:flex;justify-content:flex-end;gap:8px}" +
        ".dsm-btn{font:inherit;font-size:13px;padding:7px 14px;border-radius:10px;border:1px solid var(--dsw-alias-line,#333);background:transparent;color:inherit;cursor:pointer}" +
        ".dsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}" +
        ".dsm-btn:disabled{opacity:.5;cursor:default}" +
        ".dsm-btn-primary{background:var(--dsw-alias-accent-primary,#4c7dff);border-color:transparent;color:#fff}" +
        ".dsm-footer-icon{box-sizing:border-box;flex:1 0 100%;width:calc(100% + 8px);height:34px;color:var(--dsw-alias-label-primary,#f2f2f7);background:transparent;border:none;border-radius:12px;margin:4px -4px;padding:6px 2px 6px 10px;font:inherit;font-size:14px;line-height:22px;display:flex;align-items:center;gap:8px;cursor:pointer;overflow:hidden}" +
        ".dsm-footer-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}" +
        ".dsm-footer-icon[data-rail='1']{border-radius:50%;justify-content:center;gap:0;flex:0 0 36px;width:36px;height:36px;margin:8px 0 10px;padding:0}" +
        ".dsm-footer-label{white-space:nowrap;overflow:hidden}" +
        ".dsm-settings{display:flex;flex-direction:column;gap:18px;font-size:14px;color:var(--dsw-alias-label-primary,#f2f2f7)}" +
        ".dsm-set-row{display:flex;flex-direction:column;gap:8px}" +
        ".dsm-set-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f7)}" +
        ".dsm-set-value{font-size:13px;color:var(--dsw-alias-label-secondary,#9a9aa5)}" +
        ".dsm-set-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#9a9aa5)}" +
        ".dsm-set-warn{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}" +
        ".dsm-set-input{font:inherit;font-size:13px;padding:7px 10px;border-radius:10px;border:1px solid var(--dsw-alias-line,#333);background:transparent;color:inherit;min-width:0}" +
        ".dsm-set-input-num{width:96px}" +
        ".dsm-token-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
        ".dsm-token-row .dsm-set-input{flex:1;min-width:160px}" +
        ".dsm-switch{position:relative;display:inline-block;width:40px;height:22px;flex:none}" +
        ".dsm-switch input{opacity:0;width:0;height:0}" +
        ".dsm-switch-slider{position:absolute;cursor:pointer;inset:0;background:var(--dsw-alias-line,#3a3a44);border-radius:22px;transition:.2s}" +
        ".dsm-switch-slider:before{content:'';position:absolute;height:16px;width:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}" +
        ".dsm-switch input:checked + .dsm-switch-slider{background:var(--dsw-alias-accent-primary,#4c7dff)}" +
        ".dsm-switch input:checked + .dsm-switch-slider:before{transform:translateX(18px)}" +
        "[class*='_footerActions']{flex-wrap:wrap}" +
        "[class*='_collapsed'] [class*='_footerActions']{width:36px;justify-content:flex-start}";
      document.head.appendChild(tag);
    }

    // ------------------------------------------------------------------
    // 挂载
    // ------------------------------------------------------------------
    var mounted = false;
    function mountOverlay() {
      if (mounted || typeof document === "undefined") return;
      mounted = true;
      var container = document.createElement("div");
      container.id = "dsh-mini-overlay-root";
      document.body.appendChild(container);
      try {
        beacon("overlay", "creating root");
        var root = reactDom.createRoot(container);
        beacon("overlay", "root created");
        root.render(h(QrOverlay));
        beacon("overlay", "render called");
      } catch (e) {
        var msg = String((e && e.message) || e);
        console.warn("[dsh-mini] overlay 挂载失败：" + msg);
        beacon("overlay", "ERR " + msg);
      }
    }

    function beacon(ev, msg) {
      try {
        fetch("/dsh-mini/api/client-beacon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ev: ev, msg: msg }),
          keepalive: true,
        }).catch(function () {});
      } catch (e) {
        /* diagnostic only */
      }
    }

    function apply(ctx) {
      beacon("apply", "client apply started");
      ensureCss();
      ctx.effect(function () {
        return setupBalanceForwarder();
      }, "dsh-mini: balance forwarder");
      ctx.effect(function () {
        mountOverlay();
      }, "dsh-mini: overlay mount");

      // 每 30s 静默刷新网关连接状态（二维码 / 可达性 / 端口改动即时生效）
      ctx.effect(function () {
        var timer = setInterval(function () {
          refreshGateway(true);
        }, 30000);
        return function () {
          clearInterval(timer);
        };
      }, "dsh-mini: gateway poll (30s)");

      // 左侧主栏 footer 手机图标（order 210 < side-session 220 → 渲染在其上方）
      ctx.effect(function () {
        try {
          const ret = ctx.slots.inject("sidebar.footer.action", function () {
            const dispose = ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-mini", order: 210, label: "手机连接" }, FooterIcon);
            beacon("slot-footer", "registered");
            return dispose;
          }, "dsh-mini");
          beacon("slot-footer", "inject returned");
          return ret;
        } catch (e) {
          const msg = String((e && e.message) || e);
          console.warn("[dsh-mini] sidebar.footer.action 槽不可用：" + msg);
          beacon("slot-footer", "ERR " + msg);
        }
      }, "dsh-mini: footer icon");

      // 设置页分节（settings.section list 槽）
      ctx.effect(function () {
        try {
          const ret = ctx.slots.inject("settings.section", function () {
            const dispose = ctx.slots.register({ name: "settings.section", id: "dsh-mini", order: 70, label: function () { return "DSH Mini 手机桥"; } }, SettingsCard);
            beacon("slot-settings", "registered");
            return dispose;
          }, "name");
          beacon("slot-settings", "inject returned");
          return ret;
        } catch (e) {
          const msg = String((e && e.message) || e);
          console.warn("[dsh-mini] settings.section 槽不可用：" + msg);
          beacon("slot-settings", "ERR " + msg);
        }
      }, "dsh-mini: settings section");
    }

    exports.name = "@deepseek-ai/dsh-mini";
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
