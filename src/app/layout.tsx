import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "汇阅 Conflux · 智能 RSS 聚合阅读器",
  description: "全文抓取 · 规则过滤 · 多级去重 · 事件聚类 · AI 总结与多源对比 · 永久归档",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        {/* Keep Referer for YouTube / Bilibili embeds (avoids player error 153). */}
        <meta name="referrer" content="strict-origin-when-cross-origin" />
      </head>
      <body>{children}</body>
    </html>
  );
}
