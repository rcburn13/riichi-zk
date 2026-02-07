/* tslint:disable */
/* eslint-disable */

export function aggregate_public_keys(handles: any): number;

export function aggregate_reveal_tokens(handles: any): number;

export function deck_get_card(verified_handle: number, index: number): number;

export function free_apk(handle: number): void;

export function free_art(handle: number): void;

export function free_card(handle: number): void;

export function free_verified_deck(handle: number): void;

export function free_verified_pk(handle: number): void;

export function free_verified_token(handle: number): void;

export function keygen(context: string): any;

export function reveal_card(art_handle: number, card_handle: number): number;

export function reveal_token(sk_b64: string, pk_b64: string, card_handle: number, context: string): any;

export function shuffle_initial(apk_handle: number, context: string): any;

export function shuffle_next(apk_handle: number, prev_handle: number, context: string): any;

export function verify_initial_shuffle(apk_handle: number, deck_b64: string, proof_b64: string, context: string): number;

export function verify_public_key(pk_b64: string, proof_b64: string, context: string): number;

export function verify_reveal_token(vpk_handle: number, token_b64: string, proof_b64: string, card_handle: number, context: string): number;

export function verify_shuffle(apk_handle: number, prev_handle: number, deck_b64: string, proof_b64: string, context: string): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly aggregate_public_keys: (a: any) => [number, number, number];
    readonly aggregate_reveal_tokens: (a: any) => [number, number, number];
    readonly deck_get_card: (a: number, b: number) => [number, number, number];
    readonly free_apk: (a: number) => void;
    readonly free_art: (a: number) => void;
    readonly free_card: (a: number) => void;
    readonly free_verified_deck: (a: number) => void;
    readonly free_verified_pk: (a: number) => void;
    readonly free_verified_token: (a: number) => void;
    readonly keygen: (a: number, b: number) => [number, number, number];
    readonly reveal_card: (a: number, b: number) => [number, number, number];
    readonly reveal_token: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly shuffle_initial: (a: number, b: number, c: number) => [number, number, number];
    readonly shuffle_next: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly verify_initial_shuffle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly verify_public_key: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly verify_reveal_token: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly verify_shuffle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
