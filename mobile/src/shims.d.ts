declare module "sql.js" {
  export type SqlValue = string | number | null | Uint8Array;
  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }
  export interface Statement {
    bind(params?: SqlValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    free(): void;
  }
  export interface Database {
    run(sql: string, params?: SqlValue[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }
  export interface InitOptions {
    locateFile?: (file: string) => string;
  }
  export default function initSqlJs(config?: InitOptions): Promise<SqlJsStatic>;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "../../desktop/media.mjs" {
  export function leadImage(...args: unknown[]): string | null;
  export function pickRssImage(...args: unknown[]): string | null;
  export function prependMissingVideos(...args: unknown[]): string;
  export function rewriteDocument(...args: unknown[]): Document | string;
  export function rssVideoUrls(...args: unknown[]): string[];
}

declare module "../../desktop/catalog.mjs" {
  export const CATALOG: Array<Record<string, unknown>>;
  export const CATALOG_REV: string | number;
}
