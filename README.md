# ACERVO public selection

A text-free grid containing only the videos marked public in the local ACERVO library.

Click a clip to play or stop it. Starting another clip stops the previous one.
Every published clip uses a non-destructive, offline car-consistent audio master;
the source archive is never modified.

Run `node scripts/sync-from-acervo.mjs` to refresh the page from ACERVO, then
`node scripts/check-site.mjs` to verify it before publishing.
