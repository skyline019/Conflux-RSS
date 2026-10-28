"use client";
import React from "react";
import { Sun, Inbox, Layers, Settings } from "lucide-react";
import type { View } from "@/components/Sidebar";

export type MobileTab = "today" | "read" | "events" | "settings";

/** Content row height; page pb / toast bottom must match. */
export const MOBILE_TAB_HEIGHT = 52;

const TABS: { id: MobileTab; label: string; icon: React.ReactNode; view: View }[] = [
  { id: "today", label: "今日", icon: <Sun size={20} />, view: "today" },
  { id: "read", label: "阅读", icon: <Inbox size={20} />, view: "read" },
  { id: "events", label: "事件", icon: <Layers size={20} />, view: "events" },
  { id: "settings", label: "设置", icon: <Settings size={20} />, view: "settings" },
];

export function viewToMobileTab(view: View): MobileTab {
  if (view === "today") return "today";
  if (view === "events") return "events";
  if (view === "settings") return "settings";
  if (view === "rules" || view === "archive" || view === "stats") return "read";
  return "read";
}

export default function MobileTabBar({
  active,
  onTab,
  unreadHint,
  eventHint,
}: {
  active: MobileTab;
  onTab: (tab: MobileTab) => void;
  unreadHint?: number;
  eventHint?: number;
}) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-[55] border-t border-[#e3dccb] bg-[#faf7ef] backdrop-blur-md lg:hidden dark:border-[#3a3428] dark:bg-[#161410]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="主导航"
    >
      <div
        className="mx-auto flex max-w-lg items-stretch justify-around px-1"
        style={{ height: MOBILE_TAB_HEIGHT }}
      >
        {TABS.map((t) => {
          const on = active === t.id;
          const badge =
            t.id === "today" && unreadHint && unreadHint > 0
              ? unreadHint > 99 ? "99+" : String(unreadHint)
              : t.id === "events" && eventHint && eventHint > 0
                ? eventHint > 99 ? "99+" : String(eventHint)
                : null;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTab(t.id)}
              className={`relative flex min-h-[44px] min-w-[64px] flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-semibold transition ${
                on ? "text-[#e85a1e]" : "text-[#9a917c] dark:text-[#a99f83]"
              }`}
              aria-current={on ? "page" : undefined}
            >
              <span className={`relative ${on ? "scale-105" : ""}`}>
                {t.icon}
                {badge && (
                  <span className="absolute -right-2.5 -top-1.5 min-w-[14px] rounded-full bg-[#e85a1e] px-1 text-center text-[9px] font-bold leading-[14px] text-white">
                    {badge}
                  </span>
                )}
              </span>
              {t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
