// DSH Mini — 实时扫码 Activity
//
// CameraX 后置相机预览 + zxing 解码 QR_CODE，识别到含 /dsh-mini 的 http(s) URL 后
// setResult 回 MainActivity，由其自动连通性自检并加载手机端页面。
// 纯 AOSP API + 开源 zxing，免 GMS（华为机可用）。
package com.dshmini.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.util.Size;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.LifecycleRegistry;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.multi.qrcode.QRCodeMultiReader;

import java.nio.ByteBuffer;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

public class ScanActivity extends Activity implements LifecycleOwner {

    private static final String TAG = "DshMiniScan";
    static final String EXTRA_URL = "url";
    private static final int REQ_CAMERA = 9001;

    private final LifecycleRegistry lifecycleRegistry = new LifecycleRegistry(this);

    @NonNull
    @Override
    public Lifecycle getLifecycle() {
        return lifecycleRegistry;
    }

    private PreviewView previewView;
    private FrameLayout root;
    private View overlayView;
    private TextView hint;
    private final Executor analyzerExecutor = Executors.newSingleThreadExecutor();
    private volatile boolean decoded = false;
    private ListenableFuture<ProcessCameraProvider> cameraProviderFuture;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE);
        // 沉浸全屏（透明状态栏/导航栏，深色背景）
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        View decor = getWindow().getDecorView();
        int vis = decor.getSystemUiVisibility();
        vis |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        decor.setSystemUiVisibility(vis);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        previewView = new PreviewView(this);
        previewView.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(previewView);

        // 取景框 + 提示叠加层
        overlayView = new View(this) {
            final Paint framePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            final Paint dimPaint = new Paint();
            final Paint dotPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

            @Override
            protected void onDraw(Canvas c) {
                int W = getWidth(), H = getHeight(), side = Math.min(W, H) * 5 / 8;
                int left = (W - side) / 2, top = (H - side) / 2 - dp(48);
                int right = left + side, bottom = top + side;
                dimPaint.setColor(0x99000000);
                c.drawRect(0, 0, W, top, dimPaint);
                c.drawRect(0, bottom, W, H, dimPaint);
                c.drawRect(0, top, left, bottom, dimPaint);
                c.drawRect(right, top, W, bottom, dimPaint);
                // 玻璃质取景框：半透明白 + 描边 + 角标
                framePaint.setStyle(Paint.Style.STROKE);
                framePaint.setStrokeWidth(dp(2));
                framePaint.setColor(0x55FFFFFF);
                c.drawRoundRect(left, top, right, bottom, dp(18), dp(18), framePaint);
                int cl = dp(28);
                float sw = dp(4);
                framePaint.setStyle(Paint.Style.STROKE);
                framePaint.setColor(0xFFE8EEFF);
                framePaint.setStrokeWidth(sw);
                float r = dp(14);
                // 四角
                c.drawLine(left, top, left + cl, top, framePaint);
                c.drawLine(left, top, left, top + cl, framePaint);
                c.drawLine(right, top, right - cl, top, framePaint);
                c.drawLine(right, top, right, top + cl, framePaint);
                c.drawLine(left, bottom, left + cl, bottom, framePaint);
                c.drawLine(left, bottom, left, bottom - cl, framePaint);
                c.drawLine(right, bottom, right - cl, bottom, framePaint);
                c.drawLine(right, bottom, right, bottom - cl, framePaint);
                // 扫描线（呼吸感）
                long t = System.currentTimeMillis() % 1800;
                float prog = t / 1800f;
                float scanY = top + (bottom - top) * (prog < 0.5f ? prog * 2f : (1f - prog) * 2f);
                dotPaint.setColor(0xCC5EB4FF);
                dotPaint.setStrokeWidth(dp(1.5f));
                c.drawLine(left + dp(8), scanY, right - dp(8), scanY, dotPaint);
                invalidate();
            }
        };
        overlayView.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(overlayView);

        setContentView(root);

        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_CAMERA);
        } else {
            startCamera();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START);
    }

    @Override
    protected void onStop() {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_STOP);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY);
        super.onDestroy();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @SuppressLint("RestrictedApi")
    private void startCamera() {
        cameraProviderFuture = ProcessCameraProvider.getInstance(this);
        cameraProviderFuture.addListener(new Runnable() {
            @Override
            public void run() {
                try {
                    ProcessCameraProvider provider = cameraProviderFuture.get();
                    CameraSelector selector = new CameraSelector.Builder()
                            .requireLensFacing(CameraSelector.LENS_FACING_BACK).build();
                    Preview preview = new Preview.Builder().build();
                    preview.setSurfaceProvider(previewView.getSurfaceProvider());
                    ImageAnalysis analysis = new ImageAnalysis.Builder()
                            .setTargetResolution(new Size(1080, 1920))
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build();
                    analysis.setAnalyzer(analyzerExecutor, new QrAnalyzer());
                    provider.unbindAll();
                    provider.bindToLifecycle(ScanActivity.this, selector, preview, analysis);
                } catch (Exception e) {
                    Log.e(TAG, "startCamera failed", e);
                    lastHint("相机初始化失败：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
                }
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void onDecoded(final String url) {
        if (decoded) return;
        decoded = true;
        try {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                v.vibrate(VibrationEffect.createOneShot(80, 120));
            }
        } catch (Exception ignored) {}
        Intent data = new Intent();
        data.putExtra(EXTRA_URL, url);
        setResult(RESULT_OK, data);
        finish();
    }

    private void lastHint(final String msg) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (hint == null) {
                    hint = new TextView(ScanActivity.this);
                    hint.setTextColor(0xFFFF8F8F);
                    hint.setPadding(dp(16), dp(16) + dp(24), dp(16), dp(16));
                    hint.setTextSize(13);
                    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                            FrameLayout.LayoutParams.MATCH_PARENT,
                            FrameLayout.LayoutParams.WRAP_CONTENT);
                    lp.topMargin = dp(48);
                    root.addView(hint, lp);
                }
                hint.setText(msg);
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] perms, @NonNull int[] res) {
        super.onRequestPermissionsResult(requestCode, perms, res);
        if (requestCode == REQ_CAMERA) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) {
                startCamera();
            } else {
                lastHint("已拒绝相机权限，请在系统设置中授权后重试");
            }
        }
    }

    // zxing 解码分析器：ImageProxy(YUV_420_888) → PlanarYUVLuminanceSource → QRCode 解码
    private class QrAnalyzer implements ImageAnalysis.Analyzer {
        private final QRCodeMultiReader reader = new QRCodeMultiReader();
        private final Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);

        QrAnalyzer() {
            hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(com.google.zxing.BarcodeFormat.QR_CODE));
            hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        }

        @SuppressLint("UnsafeOptInUsageError")
        @Override
        public void analyze(@NonNull ImageProxy image) {
            try {
                if (image.getFormat() != android.graphics.ImageFormat.YUV_420_888) { image.close(); return; }
                int w = image.getWidth(), h = image.getHeight();
                ImageProxy.PlaneProxy yPlane = image.getPlanes()[0];
                ByteBuffer yBuf = yPlane.getBuffer();
                int rowStride = yPlane.getRowStride();
                int pixelStride = yPlane.getPixelStride(); // Y 平面通常 1
                // 取 Y（亮度）通道填到连续写 buffer；处理 rowStride/padding。
                byte[] data = new byte[w * h * pixelStride];
                yBuf.rewind();
                if (rowStride == w && pixelStride == 1) {
                    yBuf.get(data, 0, Math.min(w * h, yBuf.remaining()));
                } else {
                    int rowBytes = w * pixelStride;
                    byte[] row = new byte[Math.max(rowStride, rowBytes)];
                    for (int r = 0; r < h; r++) {
                        int pos = r * rowStride;
                        if (pos + rowStride <= yBuf.limit()) {
                            yBuf.position(pos);
                            yBuf.get(row, 0, rowStride);
                            System.arraycopy(row, 0, data, r * rowBytes, rowBytes);
                        }
                    }
                }
                int dataW = w, dataH = h;
                PlanarYUVLuminanceSource source =
                        new PlanarYUVLuminanceSource(data, dataW, dataH, 0, 0, dataW, dataH, false);
                BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
                Result[] results = reader.decodeMultiple(bitmap, hints);
                if (results != null) {
                    for (Result r : results) {
                        String t = r.getText();
                        // v3 网关二维码为根路径 http://<IP>:<port>/?token=...（不含 /dsh-mini 前缀），
                        // 因此只校验 http(s)，具体连通性由 JS 端 testUrl 自检兜底
                        if (t != null && (t.startsWith("http://") || t.startsWith("https://"))) {
                            onDecoded(t);
                            break;
                        }
                    }
                }
            } catch (Exception ignored) {
            } finally {
                image.close();
            }
        }
    }
}