declare module "*catalog.mjs" {
  // Loosely typed: catalog rows vary by feed; callers narrow as needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const CATALOG: any[];
  export const CATALOG_REV: string | number;
}

declare module "*media.mjs" {
  export function leadImage(...args: unknown[]): string | null;
  export function pickRssImage(...args: unknown[]): string | null;
  export function prependMissingVideos(...args: unknown[]): string;
  export function rewriteDocument(...args: unknown[]): Document | string;
  export function rssVideoUrls(...args: unknown[]): string[];
}
