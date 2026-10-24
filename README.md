# ACERVO public selection

A text-free grid containing only the videos marked public in the local ACERVO library.

Click a clip to play or stop it. Starting another clip stops the previous one.
Every published clip uses a non-destructive, offline car-consistent audio master
made from its original archive file. A soft noise-floor expander, fixed programme
gain, compression, tighter momentary and short-term loudness control, tonal outlier
correction, channel repair, and a true-peak limiter are baked into 96 kbps AAC
without modifying the source archive.

The mastered soundtracks are published separately from the visual grid across
`jamminstein/acervo-public-audio` and `jamminstein/acervo-public-audio-2` so
every GitHub Pages artifact remains below 1 GB.

Run `node scripts/sync-from-acervo.mjs` to refresh the page from ACERVO, then
`node scripts/check-site.mjs` to verify it before publishing.


The handwritten menu and clip IDs share tiago.lol's pen style. The original
transport bar, seek waveform, and tile play/pause icons remain in place. The
drum machine floats independently over the video grid, without a bottom strip.

The little three-pad drum machine uses the same 48 samples as tiago.lol.
Play with J (kick), K (snare), and L (hat), or press the pads. The refresh
arrow chooses another kit. Drag its top handle or use the arrow keys while
the handle has focus to move it. Its separate, limited Web Audio path does
not route or process the archive soundtrack.
