"use client";
import React from "react";
import { Loader2 } from "lucide-react";

export function toast(message: string, type: "success" | "error" | "info" = "success") {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("conflux-toast", { detail: { message, type, id: Date.now() + Math.random() } }));
  }
}

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`anim-spin-slow ${className}`} />;
}

export function Badge({ children, color = "#9a917c", bg }: { children: React.ReactNode; color?: string; bg?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium leading-4 whitespace-nowrap"
      style={{ color, background: bg || `${color}18`, border: `1px solid ${color}30` }}
    >
      {children}
    </span>
  );
}

export function SourceAvatar({ title, color, size = 22 }: { title: string; color: string; size?: number }) {
  const ch = (title || "?").replace(/^(The|A)\s+/i, "").charAt(0);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[6px] font-bold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.52 }}
    >
      {ch}
    </span>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="anim-fadeIn flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#efe8d8] text-[#b3a682]">{icon}</div>
      <div className="font-serif text-[17px] font-bold text-[#4c4433]">{title}</div>
      {hint && <p className="mt-1.5 max-w-sm text-[13px] leading-5 text-[#9a917c]">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, width = "max-w-lg" }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode; width?: string;
}) {
  if (!open) return null;
  return (
    <div className="anim-fadeIn fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 backdrop-blur-[2px] p-4 pt-[7vh]" onClick={onClose}>
      <div className={`anim-fadeUp w-full ${width} rounded-2xl bg-[#fffdf8] shadow-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[#eee6d2] px-5 py-3.5">
          <div className="font-serif text-[16px] font-bold">{title}</div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full text-[#9a917c] hover:bg-[#f3eddd] hover:text-ink text-lg leading-none">×</button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export const inputCls = "w-full rounded-lg border border-[#ddd3ba] bg-white px-3 py-2 text-[13.5px] outline-none transition placeholder:text-[#bdb295] focus:border-[#e85a1e] focus:ring-2 focus:ring-[#e85a1e]/15";
export const labelCls = "mb-1 block text-[12px] font-medium text-[#6d6450]";
export const btnPrimary = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#e85a1e] px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-[#d14e15] disabled:cursor-not-allowed disabled:opacity-50";
export const btnGhost = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#ddd3ba] bg-white px-3.5 py-2 text-[13px] font-medium text-[#4c4433] transition hover:border-[#c9bc97] hover:bg-[#faf5e8] disabled:opacity-50";
export const btnDanger = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#c0392b] px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-[#a93226] disabled:opacity-50";

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-5.5 w-10 shrink-0 rounded-full transition-colors ${checked ? "bg-[#e85a1e]" : "bg-[#d8cfb4]"}`}
      style={{ height: 22 }}
    >
      <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-[3px]"}`} />
    </button>
  );
}
