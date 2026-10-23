const BASE = process.env.CONFLUX_URL || "http://127.0.0.1:3011";

async function main() {
  const health = await fetch(`${BASE}/api/health`);
  console.log("health", await health.text());

  const mediaUrl =
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
  const proxy = `${BASE}/api/proxy/media?url=${encodeURIComponent(mediaUrl)}`;
  const t0 = Date.now();
  const r = await fetch(proxy, { headers: { Range: "bytes=0-64" }, redirect: "manual" });
  console.log(
    "proxy",
    r.status,
    `${Date.now() - t0}ms`,
    r.headers.get("content-type"),
    r.headers.get("content-range") || r.headers.get("location")?.slice(0, 60),
  );

  for (const url of [
    "https://www.dailymotion.com/video/x8abcdef",
    "https://soundcloud.com/forss/flickermood",
    "https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl",
    "https://www.xiaoyuzhoufm.com/episode/65a1b2c3d4e5f67890123456",
    "https://music.163.com/#/song?id=347230",
    "https://www.twitch.tv/videos/1234567890",
    "https://podcasts.apple.com/us/podcast/example/id123456789",
  ]) {
    const p = await fetch(`${BASE}/api/media/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const j = await p.json();
    console.log(
      "parse",
      url.split("/")[2],
      p.status,
      j.media?.provider,
      j.media?.kind,
      j.media?.embedUrl?.slice(0, 80) || j.error,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
