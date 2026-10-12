# Changelog

## 1.0.0 (2026-10-12)

- First release: the `<fogged-glass>` element. Fog with patchy density and warm bloom, finger
  strokes with a ridge of droplets, drops born at the low points of each stroke that run, merge
  and refract, uneven refog.
- Goals: find a target (`data-target`) or write a word (`data-goal="write"`), then `fogreveal`.
- `clearAll()`, `fogUp()`, `setGravity()`; pure `looksLikeWriting()` and `DropSim` exports.
- Works without float render targets: slow refog keeps its pace on 8-bit storage.
