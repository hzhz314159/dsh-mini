// DSH Mini — Android WebView 壳（应用内扫码连接）
// 
// 职责：
//   1) 记住上次连接地址（SharedPreferences），有则直接加载手机端页面；
//   2) 无连接地址时加载内置 connect.html（assets），其内含「拍照扫码 + jsQR
//      解码 + 手动输入」连接流程——扫码完全在 Web 层完成，Android 侧零相机代码；
//   3) onShowFileChooser 透传系统相机/相册（connect.html 与手机端页面里的
//      <input type="file" capture> 都靠它弹出系统相机）；
//   4) 系统相机扫桌面二维码（http + pathPrefix=/dsh-mini）可直启本应用；
//   5) 保持亮屏 + 返回键导航 + 全屏沉浸。
package com.dshmini.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
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
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

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
