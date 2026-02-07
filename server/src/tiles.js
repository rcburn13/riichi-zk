export const TILE_NAMES = [
  "1m","2m","3m","4m","5m","6m","7m","8m","9m",
  "1p","2p","3p","4p","5p","6p","7p","8p","9p",
  "1s","2s","3s","4s","5s","6s","7s","8s","9s",
  "E","S","W","N","P","F","C"
];

export function typeToName(type) {
  return TILE_NAMES[type] || "?";
}

export function nameToType(name) {
  const idx = TILE_NAMES.indexOf(name);
  return idx === -1 ? null : idx;
}
