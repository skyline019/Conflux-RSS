package app.conflux.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Keeps process alive while WebView runs feed refresh; shows ongoing progress notification.
 */
public class RefreshForegroundService extends Service {
    public static final String CHANNEL_ID = "conflux_refresh";
    public static final int NOTIF_ID = 71001;
    public static final String ACTION_START = "app.conflux.mobile.REFRESH_START";
    public static final String ACTION_STOP = "app.conflux.mobile.REFRESH_STOP";
    /** When true, wake MainActivity so WebView can run the refresh stream (WorkManager path). */
    public static final String EXTRA_KICK_JS = "kickJs";

    private static RefreshForegroundService instance;

    public static RefreshForegroundService getInstance() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelfSafely();
            return START_NOT_STICKY;
        }

        Notification notification = buildNotification("汇阅", "正在后台刷新订阅…", 0, 0, true);
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

        // Only kick WebView when WorkManager set EXTRA_KICK_JS — JS startProgress must not re-dispatch
        boolean kickJs = intent != null && intent.getBooleanExtra(EXTRA_KICK_JS, false);
        if (kickJs) {
            kickWebViewForRefresh();
        }

        return START_STICKY;
    }

    /**
     * Prefer soft dispatch if MainActivity/WebView already alive (no launch flash).
     * Else try startActivity; if OEM blocks it, ongoing notification tap still carries backgroundRefresh.
     */
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
            // Android 10+ background activity limits — user can tap the ongoing notification
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIF_ID, buildNotification("汇阅 · 等待刷新", "点按通知以继续后台抓取", 0, 0, true));
            }
        }
    }

    public void updateProgress(String title, String text, int progress, int max) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(NOTIF_ID, buildNotification(title, text, progress, max, true));
    }

    public void showCompleted(String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIF_ID + 1, buildNotification(title, text, 0, 0, false));
        }
        stopSelfSafely();
    }

    public void showFailed(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIF_ID + 1, buildNotification("汇阅 · 刷新失败", text, 0, 0, false));
        }
        stopSelfSafely();
    }

    private void stopSelfSafely() {
        try {
            stopForeground(STOP_FOREGROUND_DETACH);
        } catch (Exception ignored) { }
        stopSelf();
        instance = null;
    }

    public static final String CHANNEL_DONE_ID = "conflux_refresh_done";

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
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
        done.setDescription("后台刷新完成或失败时提醒");
        nm.createNotificationChannel(done);
    }

    private Notification buildNotification(String title, String text, int progress, int max, boolean ongoing) {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        // Fallback when startActivity from FGS is blocked: tapping continues the JS refresh path
        if (ongoing) {
            open.putExtra("backgroundRefresh", true);
            open.putExtra("silent", true);
        }
        PendingIntent pi = PendingIntent.getActivity(
            this,
            ongoing ? 1 : 2,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String channel = ongoing ? CHANNEL_ID : CHANNEL_DONE_ID;
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, channel)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pi)
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
            .setPriority(ongoing ? NotificationCompat.PRIORITY_LOW : NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(ongoing ? NotificationCompat.CATEGORY_PROGRESS : NotificationCompat.CATEGORY_STATUS);

        if (ongoing && max > 0) {
            b.setProgress(max, Math.min(progress, max), false);
        } else if (ongoing) {
            b.setProgress(0, 0, true);
        } else {
            b.setProgress(0, 0, false);
            b.setAutoCancel(true);
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
