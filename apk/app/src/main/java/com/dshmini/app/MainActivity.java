// DSH Mini — Android WebView 壳（应用内扫码连接）
// 
// 职责：
//   1) 记住上次连接地址（SharedPreferences），有则直接加载手机端页面；
//   2) 无连接地址时加载内置 connect.html（assets），「📷 扫码连接」按钮触发
//      Native ScanActivity（CameraX 实时取景 + zxing 解码），识别后回调 JS；
//      连接页保留地址输入兜底（虚拟机/无相机场景）；
//   3) onShowFileChooser 透传系统相机/相册（手机端页面拍照附件靠它弹出系统相机）；
//   4) 系统相机扫桌面二维码（http + pathPrefix=/dsh-mini）可直启本应用；
//   5) 沉浸式状态栏/导航栏透明 + 浅色图标 + 亮屏 + 返回键回退。
package com.dshmini.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {

    private static final String PREFS = "dshmini";
    private static final String KEY_URL = "last_url";
    private static final int REQ_FILE = 4242;
    private static final int REQ_SCAN = 4243;
    private boolean scanPending = false;

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 允许 PC Chrome chrome://inspect 远程调试（调试期排障用；正式版可移除）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        // 沉浸式：透明状态栏/导航栏，内容延伸至边缘
        getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        View decor = getWindow().getDecorView();
        int vis = decor.getSystemUiVisibility();
        vis |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        // 深色背景下用浅色状态栏图标（关掉浅色图标 = 默认浅）
        vis &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        decor.setSystemUiVisibility(vis);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0D0D0D);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " DSHMiniApp/1.2.0");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false; // 全部在壳内加载
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = cb;
                try {
                    // 优先系统相机拍照（扫码/拍照上传），次选内容选择器
                    Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    if (camera.resolveActivity(getPackageManager()) != null) {
                        Intent chooser = params.createIntent();
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
                        startActivityForResult(chooser, REQ_FILE);
                        return true;
                    }
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        // 连接桥：connect.html 扫码/手动连接成功后回调 JS 接口
        web.addJavascriptInterface(new Bridge(), "DshMiniBridge");

        String url = resolveStartUrl(getIntent());
        if (url != null && !url.isEmpty()) {
            loadUrl(url);
        } else {
            web.loadUrl("file:///android_asset/connect.html");
        }
    }

    private String resolveStartUrl(Intent intent) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (intent != null && intent.getData() != null) {
            Uri u = intent.getData();
            String host = u.getHost();
            int port = u.getPort();
            String base = (port > 0 ? host + ":" + port : host) + "/dsh-mini/";
            String t = u.getQueryParameter("token");
            String url = "http://" + base + (t != null && !t.isEmpty() ? "?token=" + t : "");
            prefs.edit().putString(KEY_URL, url).apply();
            return url;
        }
        return prefs.getString(KEY_URL, "");
    }

    private void loadUrl(String url) {
        if (url == null || url.isEmpty()) return;
        web.loadUrl(url);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SCAN) {
            if (resultCode == RESULT_OK && data != null) {
                final String url = data.getStringExtra(ScanActivity.EXTRA_URL);
                if (url != null && !url.isEmpty()) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                String safe = url.replace("\\", "\\\\").replace("\"", "'");
                                web.evaluateJavascript(
                                    "window.__dshMiniScanCb && window.__dshMiniScanCb(\"" + safe + "\")", null);
                            } catch (Exception ignored) {}
                        }
                    });
                }
            }
            return;
        }
        if (requestCode != REQ_FILE) return;
        if (filePathCallback == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            } else if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                results = new Uri[n];
                for (int i = 0; i < n; i++) results[i] = data.getClipData().getItemAt(i).getUri();
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    private void launchScanIfPermitted() {
        if (checkSelfPermission(android.Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) {
            scanPending = false;
            try {
                startActivityForResult(new Intent(this, ScanActivity.class), REQ_SCAN);
            } catch (Exception ignored) {}
        } else {
            scanPending = true;
            requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_SCAN);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] perms, int[] res) {
        super.onRequestPermissionsResult(requestCode, perms, res);
        if (requestCode == REQ_SCAN && scanPending) {
            scanPending = false;
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) {
                try { startActivityForResult(new Intent(this, ScanActivity.class), REQ_SCAN); } catch (Exception ignored) {}
            } else {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try { web.evaluateJavascript(
                            "window.__dshMiniScanCb && window.__dshMiniScanCb(null,\"NO_CAMERA_PERMISSION\")", null);
                        } catch (Exception ignored) {}
                    }
                });
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        super.onDestroy();
    }

    private class Bridge {
        @android.webkit.JavascriptInterface
        public void connect(String url) {
            final String u = url;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    loadUrl(u);
                }
            });
        }

        @android.webkit.JavascriptInterface
        public void clear() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_URL).apply();
                    web.loadUrl("file:///android_asset/connect.html");
                }
            });
        }

        // 上次成功连接的地址（connect.html 打开时回填，便于虚拟机/换网后重连）
        @android.webkit.JavascriptInterface
        public String getLastUrl() {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, "");
        }

        // 状态栏高度 px（沉浸式安全区）：Android WebView 中 env(safe-area-inset-top) 恒为 0，
        // 由页面 JS 用此值设置 --dsh-safe-top，topbar/菜单才能避开刘海与状态栏。
        @android.webkit.JavascriptInterface
        public int getSafeTop() {
            int res = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (res > 0) {
                try { return getResources().getDimensionPixelSize(res); } catch (Exception e) { /* fallthrough */ }
            }
            return 0;
        }

        // 启动 Native 实时扫码（CameraX + zxing）。识别结果回调
        // window.__dshMiniScanCb(url) 或 (null, "NO_CAMERA_PERMISSION")。
        @android.webkit.JavascriptInterface
        public void startScan() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    launchScanIfPermitted();
                }
            });
        }

        // 原生侧连通自检：connect.html 是 file:// 页面，fetch 会被 CORS 拦截，
        // 这里用 HttpURLConnection 直连 /dsh-mini/api/health?token=…
        // 结果回调 window.__dshMiniTestCb(ok, code, err)。
        @android.webkit.JavascriptInterface
        public void testUrl(final String url) {
            // url 形如 http://IP:端口/dsh-mini/?token=…  →  拆出 query 再拼接 /api/health
            String path = url;
            String query = "";
            int qi = url.indexOf('?');
            if (qi >= 0) {
                query = url.substring(qi);
                path = url.substring(0, qi);
            }
            final String health = path.replace("/dsh-mini/", "/dsh-mini/api/") + "health" + query;
            new Thread(new Runnable() {
                @Override
                public void run() {
                    int code = 0;
                    String err = "";
                    try {
                        HttpURLConnection c = (HttpURLConnection) new URL(health).openConnection();
                        c.setConnectTimeout(4000);
                        c.setReadTimeout(4000);
                        c.setRequestMethod("GET");
                        code = c.getResponseCode();
                        c.disconnect();
                    } catch (Exception e) {
                        err = String.valueOf(e.getMessage());
                    }
                    final int fc = code;
                    final String fe = err;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                String safeErr = fe == null ? "" : fe.replace("\\", "\\\\").replace("\"", "'");
                                web.evaluateJavascript(
                                    "window.__dshMiniTestCb && window.__dshMiniTestCb(" +
                                    (fc == 200) + "," + fc + ",\"" + safeErr + "\")", null);
                            } catch (Exception x) {
                                // 忽略：连接页可能已切换
                            }
                        }
                    });
                }
            }).start();
        }
    }
}
