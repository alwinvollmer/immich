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
2. **Upscale from the detail view** — a button in the asset viewer instead of the
   `--waifu-upscale-x2/x4` tag + workflow + worker; progress shown like the upload
   panel (reuse it as a job progress indicator). The server calls the
   anime-upscaler itself as a job.
3. **Faces + Danbooru characters (discuss first)** — Immich face recognition is
   effectively off (`minFaces: 200000`, which also makes the nightly facial
   recognition job crash: "Invalid value for 'numResults': 200000") so it does
   not overwrite the characters the danbooru-tagger writes as People. Goal: both
   working together, and recognising new characters Immich does not know yet.
4. **Absorb the remaining worker glue** — Danbooru tagging as a server job instead
   of workflow-webhook → worker; then the immich-api-worker can go
   (desktop_tidy.py is already dead code).
5. **Mobile app (later)** — own APK via Obtainium: point /api/server/apk-links
   (server.service.ts) at this fork's releases.

Dev notes: locally, eslint's `tscompat/tscompat` rule crashes ("reading 'Class'")
even on pristine files -> lint with `--rule 'tscompat/tscompat: off'`; 20 failures
in `web/src/lib/utils/thumbnail-util.spec.ts` are a local locale issue (also on
pristine upstream). Server build needs `pnpm --filter @immich/plugin-sdk build`
first; server tests run via `pnpm test` (test/vitest.config.mjs).
