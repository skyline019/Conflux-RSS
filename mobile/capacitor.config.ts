import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.conflux.mobile",
  appName: "汇阅",
  webDir: "dist",
  android: {
    allowMixedContent: false,
    backgroundColor: "#f6f3ec",
  },
  plugins: {
    CapacitorHttp: { enabled: true },
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#f6f3ec",
      showSpinner: false,
      launchFadeOutDuration: 200,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#f6f3ec",
    },
    LocalNotifications: {
      smallIcon: "ic_launcher",
      iconColor: "#e85a1e",
    },
  },
};

export default config;
