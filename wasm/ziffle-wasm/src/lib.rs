use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};
use serde_wasm_bindgen as swb;
use wasm_bindgen::prelude::*;
use ziffle::{
    AggregatePublicKey, AggregateRevealToken, MaskedCard, MaskedDeck, OwnershipProof, RevealToken,
    RevealTokenProof, Shuffle, ShuffleProof, Verified,
};

const DECK_SIZE: usize = 136;

static VERIFIED_PKS: Lazy<Mutex<HashMap<u32, Verified<ziffle::PublicKey>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static VERIFIED_DECKS: Lazy<Mutex<HashMap<u32, Verified<MaskedDeck<DECK_SIZE>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static VERIFIED_TOKENS: Lazy<Mutex<HashMap<u32, Verified<RevealToken>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static APKS: Lazy<Mutex<HashMap<u32, AggregatePublicKey>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CARDS: Lazy<Mutex<HashMap<u32, MaskedCard>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static ARTS: Lazy<Mutex<HashMap<u32, AggregateRevealToken>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize, Deserialize)]
struct KeygenOut {
    sk: String,
    pk: String,
    proof: String,
}

#[derive(Serialize, Deserialize)]
struct ShuffleOut {
    deck: String,
    proof: String,
}

#[derive(Serialize, Deserialize)]
struct RevealOut {
    token: String,
    proof: String,
}

#[wasm_bindgen]
pub fn keygen(context: &str) -> Result<JsValue, JsValue> {
    let mut rng = fresh_rng()?;
    let shuffle = Shuffle::<DECK_SIZE>::default();
    let (sk, pk, proof) = shuffle.keygen(&mut rng, context.as_bytes());
    let out = KeygenOut {
        sk: to_b64(&sk)?,
        pk: to_b64(&pk)?,
        proof: to_b64(&proof)?,
    };
    swb::to_value(&out).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn verify_public_key(pk_b64: &str, proof_b64: &str, context: &str) -> Result<u32, JsValue> {
    let pk: ziffle::PublicKey = from_b64(pk_b64)?;
    let proof: OwnershipProof = from_b64(proof_b64)?;
    let verified = proof
        .verify(pk, context.as_bytes())
        .ok_or_else(|| js_err("Invalid ownership proof"))?;
    Ok(store_verified_pk(verified))
}

#[wasm_bindgen]
pub fn aggregate_public_keys(handles: JsValue) -> Result<u32, JsValue> {
    let ids: Vec<u32> = swb::from_value(handles).map_err(to_js_err)?;
    let map = VERIFIED_PKS.lock().map_err(to_js_err)?;
    let mut pks = Vec::new();
    for id in ids {
        let v = map.get(&id).ok_or_else(|| js_err("Missing verified public key"))?;
        pks.push(v.clone());
    }
    let apk = AggregatePublicKey::new(&pks);
    Ok(store_apk(apk))
}

#[wasm_bindgen]
pub fn shuffle_initial(apk_handle: u32, context: &str) -> Result<JsValue, JsValue> {
    let apk = get_apk(apk_handle)?;
    let mut rng = fresh_rng()?;
    let shuffle = Shuffle::<DECK_SIZE>::default();
    let (deck, proof) = shuffle.shuffle_initial_deck(&mut rng, apk, context.as_bytes());
    let out = ShuffleOut {
        deck: to_b64(&deck)?,
        proof: to_b64(&proof)?,
    };
    swb::to_value(&out).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn verify_initial_shuffle(
    apk_handle: u32,
    deck_b64: &str,
    proof_b64: &str,
    context: &str,
) -> Result<u32, JsValue> {
    let apk = get_apk(apk_handle)?;
    let deck: MaskedDeck<DECK_SIZE> = from_b64(deck_b64)?;
    let proof: ShuffleProof<DECK_SIZE> = from_b64(proof_b64)?;
    let shuffle = Shuffle::<DECK_SIZE>::default();
    let verified = shuffle
        .verify_initial_shuffle(apk, deck, proof, context.as_bytes())
        .ok_or_else(|| js_err("Invalid initial shuffle proof"))?;
    Ok(store_verified_deck(verified))
}

#[wasm_bindgen]
pub fn shuffle_next(
    apk_handle: u32,
    prev_handle: u32,
    context: &str,
) -> Result<JsValue, JsValue> {
    let apk = get_apk(apk_handle)?;
    let prev = get_verified_deck(prev_handle)?;
    let mut rng = fresh_rng()?;
    let shuffle = Shuffle::<DECK_SIZE>::default();
    let (deck, proof) = shuffle.shuffle_deck(&mut rng, apk, &prev, context.as_bytes());
    let out = ShuffleOut {
        deck: to_b64(&deck)?,
        proof: to_b64(&proof)?,
    };
    swb::to_value(&out).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn verify_shuffle(
    apk_handle: u32,
    prev_handle: u32,
    deck_b64: &str,
    proof_b64: &str,
    context: &str,
) -> Result<u32, JsValue> {
    let apk = get_apk(apk_handle)?;
    let prev = get_verified_deck(prev_handle)?;
    let deck: MaskedDeck<DECK_SIZE> = from_b64(deck_b64)?;
    let proof: ShuffleProof<DECK_SIZE> = from_b64(proof_b64)?;
    let shuffle = Shuffle::<DECK_SIZE>::default();
    let verified = shuffle
        .verify_shuffle(apk, &prev, deck, proof, context.as_bytes())
        .ok_or_else(|| js_err("Invalid shuffle proof"))?;
    Ok(store_verified_deck(verified))
}

#[wasm_bindgen]
pub fn deck_get_card(verified_handle: u32, index: u32) -> Result<u32, JsValue> {
    let deck = get_verified_deck(verified_handle)?;
    let card = deck
        .get(index as usize)
        .ok_or_else(|| js_err("Card index out of range"))?;
    Ok(store_card(card))
}

#[wasm_bindgen]
pub fn reveal_token(sk_b64: &str, pk_b64: &str, card_handle: u32, context: &str) -> Result<JsValue, JsValue> {
    let sk: ziffle::SecretKey = from_b64(sk_b64)?;
    let pk: ziffle::PublicKey = from_b64(pk_b64)?;
    let card = get_card(card_handle)?;
    let mut rng = fresh_rng()?;
    let (token, proof) = card.reveal_token(&mut rng, &sk, pk, context.as_bytes());
    let out = RevealOut {
        token: to_b64(&token)?,
        proof: to_b64(&proof)?,
    };
    swb::to_value(&out).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn verify_reveal_token(
    vpk_handle: u32,
    token_b64: &str,
    proof_b64: &str,
    card_handle: u32,
    context: &str,
) -> Result<u32, JsValue> {
    let vpk = get_verified_pk(vpk_handle)?;
    let token: RevealToken = from_b64(token_b64)?;
    let proof: RevealTokenProof = from_b64(proof_b64)?;
    let card = get_card(card_handle)?;
    let verified = proof
        .verify(vpk, token, card, context.as_bytes())
        .ok_or_else(|| js_err("Invalid reveal token proof"))?;
    Ok(store_verified_token(verified))
}

#[wasm_bindgen]
pub fn aggregate_reveal_tokens(handles: JsValue) -> Result<u32, JsValue> {
    let ids: Vec<u32> = swb::from_value(handles).map_err(to_js_err)?;
    let map = VERIFIED_TOKENS.lock().map_err(to_js_err)?;
    let mut tokens = Vec::new();
    for id in ids {
        let v = map.get(&id).ok_or_else(|| js_err("Missing verified reveal token"))?;
        tokens.push(v.clone());
    }
    let art = AggregateRevealToken::new(&tokens);
    Ok(store_art(art))
}

#[wasm_bindgen]
pub fn reveal_card(art_handle: u32, card_handle: u32) -> Result<u32, JsValue> {
    let art = get_art(art_handle)?;
    let card = get_card(card_handle)?;
    let shuffle = Shuffle::<DECK_SIZE>::default();
    let idx = shuffle
        .reveal_card(art, card)
        .ok_or_else(|| js_err("Reveal failed"))?;
    Ok(idx as u32)
}

#[wasm_bindgen]
pub fn free_verified_pk(handle: u32) {
    if let Ok(mut map) = VERIFIED_PKS.lock() {
        map.remove(&handle);
    }
}

#[wasm_bindgen]
pub fn free_verified_deck(handle: u32) {
    if let Ok(mut map) = VERIFIED_DECKS.lock() {
        map.remove(&handle);
    }
}

#[wasm_bindgen]
pub fn free_verified_token(handle: u32) {
    if let Ok(mut map) = VERIFIED_TOKENS.lock() {
        map.remove(&handle);
    }
}

#[wasm_bindgen]
pub fn free_apk(handle: u32) {
    if let Ok(mut map) = APKS.lock() {
        map.remove(&handle);
    }
}

#[wasm_bindgen]
pub fn free_card(handle: u32) {
    if let Ok(mut map) = CARDS.lock() {
        map.remove(&handle);
    }
}

#[wasm_bindgen]
pub fn free_art(handle: u32) {
    if let Ok(mut map) = ARTS.lock() {
        map.remove(&handle);
    }
}

fn fresh_rng() -> Result<rand::rngs::StdRng, JsValue> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(to_js_err)?;
    Ok(rand::rngs::StdRng::from_seed(seed))
}

fn to_b64<T: CanonicalSerialize>(value: &T) -> Result<String, JsValue> {
    let mut buf = Vec::new();
    value.serialize_compressed(&mut buf).map_err(to_js_err)?;
    Ok(B64.encode(buf))
}

fn from_b64<T: CanonicalDeserialize>(s: &str) -> Result<T, JsValue> {
    let bytes = B64.decode(s).map_err(to_js_err)?;
    T::deserialize_compressed(&*bytes).map_err(to_js_err)
}

fn store_verified_pk(vpk: Verified<ziffle::PublicKey>) -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut map) = VERIFIED_PKS.lock() {
        map.insert(id, vpk);
    }
    id
}

fn store_verified_deck(vdeck: Verified<MaskedDeck<DECK_SIZE>>) -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut map) = VERIFIED_DECKS.lock() {
        map.insert(id, vdeck);
    }
    id
}

fn store_verified_token(vtoken: Verified<RevealToken>) -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut map) = VERIFIED_TOKENS.lock() {
        map.insert(id, vtoken);
    }
    id
}

fn store_apk(apk: AggregatePublicKey) -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut map) = APKS.lock() {
        map.insert(id, apk);
    }
    id
}

fn store_card(card: MaskedCard) -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut map) = CARDS.lock() {
        map.insert(id, card);
    }
    id
}

fn store_art(art: AggregateRevealToken) -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut map) = ARTS.lock() {
        map.insert(id, art);
    }
    id
}

fn get_verified_deck(handle: u32) -> Result<Verified<MaskedDeck<DECK_SIZE>>, JsValue> {
    let map = VERIFIED_DECKS.lock().map_err(to_js_err)?;
    map.get(&handle)
        .cloned()
        .ok_or_else(|| js_err("Missing verified deck"))
}

fn get_verified_pk(handle: u32) -> Result<Verified<ziffle::PublicKey>, JsValue> {
    let map = VERIFIED_PKS.lock().map_err(to_js_err)?;
    map.get(&handle)
        .cloned()
        .ok_or_else(|| js_err("Missing verified public key"))
}

fn get_apk(handle: u32) -> Result<AggregatePublicKey, JsValue> {
    let map = APKS.lock().map_err(to_js_err)?;
    map.get(&handle)
        .copied()
        .ok_or_else(|| js_err("Missing aggregate public key"))
}

fn get_card(handle: u32) -> Result<MaskedCard, JsValue> {
    let map = CARDS.lock().map_err(to_js_err)?;
    map.get(&handle)
        .copied()
        .ok_or_else(|| js_err("Missing masked card"))
}

fn get_art(handle: u32) -> Result<AggregateRevealToken, JsValue> {
    let map = ARTS.lock().map_err(to_js_err)?;
    map.get(&handle)
        .copied()
        .ok_or_else(|| js_err("Missing aggregate reveal token"))
}

fn to_js_err<E: std::fmt::Display>(err: E) -> JsValue {
    js_err(&err.to_string())
}

fn js_err(msg: &str) -> JsValue {
    JsValue::from_str(msg)
}
