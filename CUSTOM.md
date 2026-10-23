# Custom Immich server (fork)

Branch `custom` = an upstream release tag + our commits. Only the server image
(server + web) is customised; machine-learning stays stock. No database schema
changes unless unavoidable, so going back to stock Immich always works.

- Repo: https://github.com/alwinvollmer/immich (public fork), upstream remote `upstream`
- Image: `ghcr.io/alwinvollmer/immich-server` (private), tags `<release>-custom-<sha>` and `custom`
- Built by `.github/workflows/custom-server.yml` on every push to `custom` (amd64 only).
  All upstream workflows are disabled in the fork (`gh workflow list --all -R alwinvollmer/immich`).
- Runs on nieke: `C:\docker\immich` (compose); pull auth lives in `C:\docker\immich\.docker\config.json`
  (no credsStore: the Windows credential helper fails over SSH).

## Our commits

    git log --oneline $(git describe --tags --abbrev=0)..custom

## Update to a new upstream release

    git fetch upstream --tags
    git merge vX.Y.Z            # resolve conflicts in our commits
    git push                    # builds the image
    # DB backup first: POST /api/jobs {"name":"backup-database"}
    # nieke: docker --config C:\docker\immich\.docker pull ghcr.io/alwinvollmer/immich-server:<tag>
    #        cd C:\docker\immich && docker compose up -d

Keep the machine-learning image on the SAME release as the merged tag.

## Back to stock

Point `immich-server` in `C:\docker\immich\docker-compose.yml` back to
`ghcr.io/immich-app/immich-server:${IMMICH_VERSION}` with a version >= the merged tag,
then `docker compose up -d`.

## Roadmap / todo

Done (2026-10-20): own image + pipeline; Photos album filter (default Camera);
drop files on an album (sidebar / Photos chip) to upload into it; Ctrl+V asks for
an optional album; 5 albums in the sidebar; archiving workaround removed.

1. ~~**Server-side stack rule**~~ DONE 2026-10-20 (c391e4e + 4e0b2cb; worker stack-tidy off, stack-copy unused, 92 originals restored into their stacks, copies trashed) — stack originals can never be added to albums
   (album add-assets skips non-primary stack members), stack bar regardless of
   member visibility, stacks on the Archive page. Then drop the worker's
   stack-tidy and the stack-copy/trash design.
2. ~~**Upscale from the detail view**~~ DONE 2026-10-20 (e7d93c6, 1b6dfed: viewer menu Upscale ×2/×4, UpscalePanel; anime-upscaler job API with tile progress; tag workflow, --waifu-upscale tags and worker upscale removed) — a button in the asset viewer instead of the
   `--waifu-upscale-x2/x4` tag + workflow + worker; progress shown like the upload
   panel (reuse it as a job progress indicator). The server calls the
   anime-upscaler itself as a job.
3. ~~**Faces + Danbooru characters**~~ + 4. ~~**Danbooru tagging in the server**~~ DONE 2026-10-21
   (fe3b12c, c8e4677): `DanbooruService` tags with pixai-tagger-v1.0 (cutoff May 2026, 8,308
   characters; v0.9 stopped mid-2024) through the booru-tagger v2 service (`custom/booru-tagger`),
   with real head boxes and CCIP character embeddings (fallback matching for characters pixai
   misses, OPTICS clustering of unknown heads into unnamed people, a maintenance pass that pairs
   heads of multi-character images later). A marker per image (`custom.danbooru` in asset_metadata)
   names the model, so a new model remaps the library by itself. Immich's own face detection runs
   only on camera photos (`IMMICH_FACES_CAMERA_ONLY=1`, EXIF make). 19 People renamed to the new
   Danbooru names. Forced remap of all 11,375 images on the GPU tagger (maintenance: 258 heads
   paired, 695 matched later, 50 new unnamed people). immich-api-worker + its workflow removed;
   3,359 Immich ML junk faces on non-camera images deleted, `minFaces` back to 3; 296 empty
   People deleted; 1,032 People with one image hidden until a second image arrives (3c797b0).
   Fallback snowball (Tifa on ~900 images) repaired 2026-10-21: face sources recorded, references only
   from trusted faces, faces-only re-run of all images (8b61d66..9bf538a). Region pixai + calibrated fallback only into
   groups (8d6117d, 3bc8f1d), faces-only re-run of all images 2026-10-22: 7,084 region-confirmed heads.
   Head-crop check + duplicate heads + costume variants (376514d, 62aa38a), re-run of 6,640 images
   2026-10-22/23: 6,974 confirmed heads, 2,043 whole, 92 ccip, 394 cluster, 4,956 none. Camera photos
   get no Danbooru faces; `name_(costume)` variants merge into the bare name (0fb835d, 208 variant People deleted).
   **TODO:** weak extra characters become whole-image faces. 26860c73 has 3 heads, all region-confirmed
   (Yelan, Ganyu, Hu Tao), plus a 4th whole-image face for Shenhe at pixai 0.43 → 4 faces for 3 people.
   Idea: no whole-image face for a low-score character (< ~0.6?) when every head already carries a
   confirmed character; check how often that rule would drop a real character first.
5. **Mobile app (later)** — own APK via Obtainium: point /api/server/apk-links
   (server.service.ts) at this fork's releases.

Dev notes: locally, eslint's `tscompat/tscompat` rule crashes ("reading 'Class'")
even on pristine files -> lint with `--rule 'tscompat/tscompat: off'`; 20 failures
in `web/src/lib/utils/thumbnail-util.spec.ts` are a local locale issue (also on
pristine upstream). Server build needs `pnpm --filter @immich/plugin-sdk build`
first; server tests run via `pnpm test` (test/vitest.config.mjs).
