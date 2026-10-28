package app.conflux.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.util.ArrayList;
import java.util.List;

/**
 * Keeps process alive while WebView runs feed refresh; shows ongoing progress notification.
 */
public class RefreshForegroundService extends Service {
    public static final String CHANNEL_ID = "conflux_refresh";
    public static final String CHANNEL_DONE_ID = "conflux_refresh_done";
    public static final String CHANNEL_FAIL_ID = "conflux_refresh_fail";
    public static final String GROUP_KEY = "conflux_refresh";
    public static final int NOTIF_ID = 71001;
    public static final int NOTIF_DONE_ID = NOTIF_ID + 1;
    public static final String ACTION_START = "app.conflux.mobile.REFRESH_START";
    public static final String ACTION_STOP = "app.conflux.mobile.REFRESH_STOP";
    /** When true, wake MainActivity so WebView can run the refresh stream (WorkManager path). */
    public static final String EXTRA_KICK_JS = "kickJs";
    public static final String EXTRA_OPEN_TAB = "openTab";

    private static final int BRAND_ORANGE = Color.parseColor("#E85A1E");
    private static final int FAIL_RED = Color.parseColor("#C62828");

    private static RefreshForegroundService instance;

    public static RefreshForegroundService getInstance() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureChannel(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelfSafely();
            return START_NOT_STICKY;
        }

        Notification notification = buildProgressNotification(
            this, "汇阅", "正在后台刷新订阅…", null, 0, 0
        );
        if (Build.VERSION.SDK_INT >= 29) {
            ServiceCompat.startForeground(
                this,
                NOTIF_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(NOTIF_ID, notification);
        }

        boolean kickJs = intent != null && intent.getBooleanExtra(EXTRA_KICK_JS, false);
        if (kickJs) {
            kickWebViewForRefresh();
        }

        return START_STICKY;
    }

    private void kickWebViewForRefresh() {
        if (MainActivity.requestBackgroundRefreshIfAlive()) {
            return;
        }
        Intent launch = new Intent(this, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        launch.putExtra("backgroundRefresh", true);
        launch.putExtra("silent", true);
        try {
            startActivity(launch);
        } catch (Exception ignored) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(
                    NOTIF_ID,
                    buildProgressNotification(this, "汇阅 · 等待刷新", "点按通知或「继续」以继续后台抓取", "点按继续", 0, 0)
                );
            }
        }
    }

    public void updateProgress(String title, String text, String subText, int progress, int max) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(NOTIF_ID, buildProgressNotification(this, title, text, subText, progress, max));
    }

    public void showCompleted(String title, String text, int added, List<String> lines) {
        postDoneNotification(this, title, text, added, false, lines);
        stopSelfSafely();
    }

    public void showFailed(String text) {
        postDoneNotification(this, "汇阅 · 刷新失败", text, 0, true, null);
        stopSelfSafely();
    }

    /** Post done/fail even if the FGS instance is already gone. */
    public static void postDoneNotification(
        Context ctx,
        String title,
        String text,
        int added,
        boolean failed,
        List<String> lines
    ) {
        Context app = ctx.getApplicationContext();
        ensureChannel(app);
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(NOTIF_DONE_ID, buildResultNotification(app, title, text, failed ? 0 : Math.max(0, added), failed, lines));
    }

    private void stopSelfSafely() {
        try {
            stopForeground(STOP_FOREGROUND_DETACH);
        } catch (Exception ignored) { }
        stopSelf();
        instance = null;
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel progress = new NotificationChannel(
            CHANNEL_ID,
            "订阅后台刷新",
            NotificationManager.IMPORTANCE_LOW
        );
        progress.setDescription("后台抓取 RSS 时显示进度");
        progress.setShowBadge(false);
        nm.createNotificationChannel(progress);

        NotificationChannel done = new NotificationChannel(
            CHANNEL_DONE_ID,
            "订阅刷新结果",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        done.setDescription("后台刷新完成时提醒");
        done.setShowBadge(true);
        nm.createNotificationChannel(done);

        NotificationChannel fail = new NotificationChannel(
            CHANNEL_FAIL_ID,
            "订阅刷新失败",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        fail.setDescription("后台刷新失败时提醒");
        fail.setShowBadge(true);
        nm.createNotificationChannel(fail);
    }

    private static PendingIntent openAppIntent(Context ctx, boolean ongoing, boolean continueRefresh) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        if (ongoing || continueRefresh) {
            open.putExtra("backgroundRefresh", true);
            open.putExtra("silent", true);
        } else {
            open.putExtra(EXTRA_OPEN_TAB, "today");
        }
        int req = ongoing ? 1 : (continueRefresh ? 3 : 2);
        return PendingIntent.getActivity(
            ctx,
            req,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static PendingIntent stopIntent(Context ctx) {
        Intent stop = new Intent(ctx, RefreshForegroundService.class);
        stop.setAction(ACTION_STOP);
        return PendingIntent.getService(
            ctx,
            10,
            stop,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static Notification buildProgressNotification(
        Context ctx,
        String title,
        String text,
        String subText,
        int progress,
        int max
    ) {
        ensureChannel(ctx);
        boolean waitingTap = title != null && title.contains("等待");
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_refresh)
            .setColor(BRAND_ORANGE)
            .setContentIntent(openAppIntent(ctx, true, waitingTap))
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setGroup(GROUP_KEY)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .addAction(0, "停止", stopIntent(ctx));

        if (waitingTap) {
            b.addAction(0, "继续", openAppIntent(ctx, true, true));
        }
        if (subText != null && !subText.isEmpty()) {
            b.setSubText(subText);
        }
        if (max > 0) {
            b.setProgress(max, Math.min(progress, max), false);
            if (subText == null || subText.isEmpty()) {
                b.setSubText("源 " + Math.min(progress, max) + "/" + max);
            }
        } else {
            b.setProgress(0, 0, true);
        }
        if (text != null && text.length() > 40) {
            b.setStyle(new NotificationCompat.BigTextStyle().bigText(text));
        }
        return b.build();
    }

    private static Notification buildResultNotification(
        Context ctx,
        String title,
        String text,
        int badgeNumber,
        boolean failed,
        List<String> lines
    ) {
        ensureChannel(ctx);
        String channel = failed ? CHANNEL_FAIL_ID : CHANNEL_DONE_ID;
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_refresh)
            .setColor(failed ? FAIL_RED : BRAND_ORANGE)
            .setContentIntent(openAppIntent(ctx, false, false))
            .setOnlyAlertOnce(true)
            .setOngoing(false)
            .setAutoCancel(true)
            .setGroup(GROUP_KEY)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(failed ? NotificationCompat.CATEGORY_ERROR : NotificationCompat.CATEGORY_STATUS)
            .setProgress(0, 0, false);

        if (badgeNumber > 0) {
            b.setNumber(badgeNumber);
        }

        List<String> inbox = lines != null ? lines : new ArrayList<>();
        if (!inbox.isEmpty()) {
            NotificationCompat.InboxStyle style = new NotificationCompat.InboxStyle()
                .setBigContentTitle(title)
                .setSummaryText(text);
            int n = Math.min(6, inbox.size());
            for (int i = 0; i < n; i++) {
                style.addLine(inbox.get(i));
            }
            if (inbox.size() > n) {
                style.addLine("…另有 " + (inbox.size() - n) + " 条");
            }
            b.setStyle(style);
        } else {
            b.setStyle(new NotificationCompat.BigTextStyle().bigText(text));
        }
        return b.build();
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
