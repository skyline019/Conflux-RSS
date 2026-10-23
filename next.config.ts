import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Windows 经 3011 转发访问 WSL :3010 时，Host/Origin 为 127.0.0.1，需放行 HMR/dev 资源
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // YouTube iframe embeds require a usable Referer (error 153 if stripped).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }],
      },
    ];
  },
};

export default nextConfig;
