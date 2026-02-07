/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const aggregate_public_keys: (a: any) => [number, number, number];
export const aggregate_reveal_tokens: (a: any) => [number, number, number];
export const deck_get_card: (a: number, b: number) => [number, number, number];
export const free_apk: (a: number) => void;
export const free_art: (a: number) => void;
export const free_card: (a: number) => void;
export const free_verified_deck: (a: number) => void;
export const free_verified_pk: (a: number) => void;
export const free_verified_token: (a: number) => void;
export const keygen: (a: number, b: number) => [number, number, number];
export const reveal_card: (a: number, b: number) => [number, number, number];
export const reveal_token: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
export const shuffle_initial: (a: number, b: number, c: number) => [number, number, number];
export const shuffle_next: (a: number, b: number, c: number, d: number) => [number, number, number];
export const verify_initial_shuffle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
export const verify_public_key: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const verify_reveal_token: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
export const verify_shuffle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
