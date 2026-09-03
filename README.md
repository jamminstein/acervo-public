# ACERVO public selection

A text-free grid containing only the videos marked public in the local ACERVO library.

Click a clip to play or stop it. Starting another clip stops the previous one.
Every published clip uses a non-destructive, offline car-consistent audio master
made from its original archive file. A soft noise-floor expander, fixed programme
gain, compression, tonal outlier correction, channel repair, and true-peak limiter
are baked into 96 kbps AAC without modifying the source archive.

The mastered soundtracks are published separately from the visual grid at
`jamminstein/acervo-public-audio` so both GitHub Pages artifacts remain below 1 GB.

Run `node scripts/sync-from-acervo.mjs` to refresh the page from ACERVO, then
`node scripts/check-site.mjs` to verify it before publishing.
