import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { ImmichWorker, JobName, SourceType } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { PersonService } from 'src/services/person.service.js';
import { updateLockedColumns } from 'src/utils/database.js';
import { upsertTags } from 'src/utils/tag.js';

/**
 * custom: Danbooru tagging with the anime tagger service (pixai-tagger-v1.0 + anime head
 * detection + CCIP character embeddings), replacing immich-api-worker.
 *
 * A loop in the microservices worker picks images whose `custom.danbooru` marker is missing or
 * names another model (so a new model remaps the whole library by itself), newest first, and
 * restricted like before to images in no album or in one of the configured albums.
 *
 * Per image:
 * - general tags → tags + the description; copyrights → `::series:<name>`; plus the `danbooru` tag.
 *   An image without a marker loses all its tags first (they all came from the old tagger);
 *   later runs only replace the tags listed in the marker.
 * - characters → People. A head box gets the character whose reference embeddings are closest;
 *   one head + one character pair directly; a character without a head gets a whole-image face
 *   (as before); a head without a pixai character is matched against all known characters
 *   (strict CCIP distance) or stays an unassigned face for clustering.
 * - CCIP embeddings are kept in files under `<media>/custom/ccip/` (not asset_metadata: that is
 *   synced to the mobile app); the person of a face is always read from the database, so edits
 *   in the UI (reassign, merge, rename) steer future matching.
 *
 * When there is nothing left to tag (and at most every IMMICH_DANBOORU_MAINTENANCE_HOURS), a
 * maintenance pass runs: unassigned heads are paired with the whole-image faces of their image
 * (characters seen for the first time on a multi-character image), then matched against all
 * characters again (references grow), and the rest is clustered (CCIP OPTICS) into unnamed people.
 *
 * People with a single image are hidden (a group image alone can name hundreds of characters):
 * once at startup for existing people, and every character the tagger creates starts hidden. They
 * are kept in `<media>/custom/danbooru-autohidden.json` and shown again as soon as they have two
 * images; people that are not on that list (hidden or shown by hand) are never touched.
 */
const ENABLED = process.env.IMMICH_DANBOORU_ENABLED === '1';
// The tagger is a plain-HTTP service on the Docker host. NOTE: `eslint --fix`
// (unicorn/prefer-https) silently turns this into https, which breaks it.
// eslint-disable-next-line unicorn/prefer-https
const TAGGER_URL = (process.env.IMMICH_TAGGER_URL || 'http://host.docker.internal:7860').replace(/\/+$/, '');
const ALBUM_NAMES = (process.env.IMMICH_DANBOORU_ALBUMS ?? 'Download,Reddit,9GAG,Desktop')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
// images in no album are tagged too (set to 0 to test on one album only)
const INCLUDE_UNSORTED = process.env.IMMICH_DANBOORU_INCLUDE_UNSORTED !== '0';
// phone camera photos get tags but never Danbooru faces (see danbooruCameraAsset in the asset repository)
const CAMERA_ALBUM = process.env.IMMICH_DANBOORU_CAMERA_ALBUM ?? 'Camera';
const THRESHOLDS = process.env.IMMICH_DANBOORU_THRESHOLDS || '{}';
// CCIP fallback for heads pixai did not name — only into people pixai does not know (groups, people
// made by hand), never into pixai characters. Calibrated 2026-10-22 on 6,967 pixai heads + 4,007 heads
// on images without a pixai character: mean of the 3 closest references <= 0.14, >= 0.06 ahead of the
// second-best person, >= 3 references, head >= 64 px -> ~40 % found, 0.7 % wrong, 0.9 % of non-characters
// assigned (the old 0.21 without a gap assigned 22 % of non-characters and snowballed).
const MATCH_DISTANCE = Number(process.env.IMMICH_DANBOORU_MATCH_DISTANCE ?? 0.14);
const FALLBACK_GAP = Number(process.env.IMMICH_DANBOORU_FALLBACK_GAP ?? 0.06);
const FALLBACK_MIN_REFS = Number(process.env.IMMICH_DANBOORU_FALLBACK_MIN_REFS ?? 3);
// heads smaller than this (short side, preview pixels) give unreliable CCIP vectors (crowds, background)
const MIN_HEAD = Number(process.env.IMMICH_DANBOORU_MIN_HEAD ?? 64);
// region pixai: pixai on head + upper body; a clear winner among the image's pixai characters
// (score and lead over the second) names the head (hand check 2026-10-22: right ~13 of 14 times
// where it disagreed with the old CCIP pairing)
const REGION_SCORE = Number(process.env.IMMICH_DANBOORU_REGION_SCORE ?? 0.27);
const REGION_GAP = Number(process.env.IMMICH_DANBOORU_REGION_GAP ?? 0.2);
// the head alone must show the character too: a box on someone else's head (a man above Neru, a glove
// above 2B) inherits the character from the body below in the region crop, but not in the head crop
const HEAD_SCORE = Number(process.env.IMMICH_DANBOORU_HEAD_SCORE ?? 0.1);
// a head on an image whose characters pixai named only needs to be closer to one of them than this
// (independent of the fallback: pixai already said the character is on the image)
const PAIR_DISTANCE = Number(process.env.IMMICH_DANBOORU_PAIR_DISTANCE || 0.42);
// every head already carries a region-confirmed character: a further character pixai names only weakly is
// mostly a look-alike or no one (sample 2026-10-23: ~22 of 30 below 0.6 false), so it gets no whole-image face
const EXTRA_SCORE = Number(process.env.IMMICH_DANBOORU_EXTRA_SCORE ?? 0.6);
const CLUSTER_MIN = Number(process.env.IMMICH_DANBOORU_CLUSTER_MIN || 5);
const MAINTENANCE_MS = Number(process.env.IMMICH_DANBOORU_MAINTENANCE_HOURS || 12) * 3_600_000;

export const DANBOORU_MARKER_KEY = 'custom.danbooru';
// a marker with this model re-runs only the face assignment: pixai names the characters again, the
// heads and CCIP vectors stored before are reused, and tags/description stay as they are
export const FACES_ONLY_MODEL = 'recheck-faces';
const SENTINEL_TAG = 'danbooru';
const SERIES_PREFIX = '::series:';
const BATCH_SIZE = 20;
const IDLE_MS = 30_000;
const TAGGER_DOWN_MS = 60_000;

type TaggerHead = {
  box: [number, number, number, number];
  score?: number;
  ccip?: number[];
  // pixai's character scores on the head region and on the head alone (regions=1)
  character?: Record<string, number>;
  head?: Record<string, number>;
};
export type TaggerResult = {
  model: string;
  width: number;
  height: number;
  tags: Record<'general' | 'character' | 'copyright' | 'rating', Record<string, number>>;
  heads: TaggerHead[];
};
type Box = [number, number, number, number];
/**
 * where a face's person came from: pixai named the character (`pixai`: on a head, `whole`: no head
 * found, whole-image face), CCIP fallback match (`ccip`), clustering (`cluster`), changed by hand in
 * Immich (`manual`), or no person (`none`)
 */
export type FaceSource = 'pixai' | 'whole' | 'ccip' | 'cluster' | 'manual' | 'none';
export type FaceRecord = {
  id: string;
  person: string | null;
  source: FaceSource;
  box: Box;
  // region pixai saw the person's character on this head
  confirmed?: boolean;
};
type Marker = {
  model: string;
  at: string;
  tagIds: string[];
  faceIds: string[];
  faces?: FaceRecord[];
  // boxes of faces the user deleted: never recreated
  removed?: Box[];
  // pixai's characters on the whole image with their scores
  characters?: Record<string, number>;
};
type IndexEntry = {
  assetId: string;
  ownerId: string;
  vector: Float32Array;
  person?: string | null;
  source?: FaceSource;
  confirmed?: boolean;
  regions?: Record<string, number>;
  headScores?: Record<string, number>;
  size?: number;
};
type Candidate = { id: string; ownerId: string; previewPath: string; camera?: boolean };
type FaceBox = { x1: number; y1: number; x2: number; y2: number };
type NewFace = {
  box: FaceBox;
  personGroupId: string | null;
  source: FaceSource;
  vector?: Float32Array;
  confirmed?: boolean;
  regions?: Record<string, number>;
  headScores?: Record<string, number>;
};
type FaceChange = { person: string; source: FaceSource; confirmed?: boolean };
/** CCIP references: for pairing heads with pixai characters, and for the fallback into other people */
export type References = { pair: Map<string, Float32Array[]>; fallback: Map<string, Float32Array[]> };

const normalize = (values: number[]) => {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= norm;
  }
  return vector;
};

const cosineDistance = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return 1 - dot;
};

/** mean distance to the 3 closest references (fewer when the character has fewer) */
export const distanceToReferences = (vector: Float32Array, references: Float32Array[]) => {
  const distances = references.map((reference) => cosineDistance(vector, reference)).sort((a, b) => a - b);
  const closest = distances.slice(0, 3);
  return closest.reduce((sum, value) => sum + value, 0) / closest.length;
};

export const cleanTagName = (name: string) => name.replaceAll('/', '_');
export const personName = (tag: string) => tag.replaceAll('_', ' ');

const toBox = ({ x1, y1, x2, y2 }: FaceBox): Box => [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];

const overlap = (a: Box, b: Box) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (box: Box) => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
  const union = area(a) + area(b) - w * h;
  return union > 0 ? (w * h) / union : 0;
};

const boxSize = (box: Box | FaceBox) =>
  Array.isArray(box) ? Math.min(box[2] - box[0], box[3] - box[1]) : Math.min(box.x2 - box.x1, box.y2 - box.y1);

const tagKey = (name: string) => name.replaceAll('_', ' ').toLowerCase();

/** the head detector sometimes finds one head twice: overlapping boxes, or one mostly inside the other */
const sameHead = (a: Box, b: Box) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (box: Box) => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
  const smaller = Math.min(area(a), area(b));
  return overlap(a, b) > 0.5 || (smaller > 0 && (w * h) / smaller > 0.8);
};

/** indexes of the heads to keep: the first of each set of duplicates (best detection score first) */
export const distinctHeads = (heads: Array<{ box: Box; score?: number }>) => {
  const order = heads
    .keys()
    .toArray()
    .sort((a, b) => (heads[b].score ?? 0) - (heads[a].score ?? 0));
  const kept: number[] = [];
  for (const i of order) {
    if (kept.every((j) => !sameHead(heads[i].box, heads[j].box))) {
      kept.push(i);
    }
  }
  return kept.sort((a, b) => a - b);
};

/** the head region clearly shows a character pixai knows: it belongs to no group of unknown characters */
const regionClaimed = (regions: Record<string, number> | undefined) =>
  Object.values(regions ?? {}).some((score) => score >= REGION_SCORE);

/** best and second-best region score among these character names (lower case, spaces) */
const regionRanking = (regions: Record<string, number> | undefined, names: string[]) => {
  const scores = new Map(Object.entries(regions ?? {}).map(([tag, score]) => [tagKey(tag), score]));
  const ranked = names.map((name) => ({ name, score: scores.get(name) ?? 0 })).sort((a, b) => b.score - a.score);
  return { best: ranked[0], second: ranked[1]?.score ?? 0 };
};

/** the head alone shows this character (unknown when the tagger did not score heads) */
const headShows = (headScores: Record<string, number> | undefined, name: string) =>
  !headScores || regionRanking(headScores, [name]).best.score >= HEAD_SCORE;

/** a clear region winner that the head alone confirms: score and lead over the second-best character */
const regionWinner = (
  regions: Record<string, number> | undefined,
  names: string[],
  headScores?: Record<string, number>,
) => {
  if (!regions || names.length === 0) {
    return;
  }
  const { best, second } = regionRanking(regions, names);
  return best.score >= REGION_SCORE && best.score - second >= REGION_GAP && headShows(headScores, best.name)
    ? best
    : undefined;
};

/**
 * a face teaches the pairing with pixai characters only when its person is trustworthy: a head region
 * pixai confirmed, set by hand (also: its person differs from the one this service recorded), or a
 * group the user named. CCIP fallback matches never teach anything (they snowballed: ~730 heads became
 * Tifa), and neither do unconfirmed pixai heads (a glove as "2B", "Mikasa" on Sasha's head).
 */
export const isReference = (entry: IndexEntry, person: { personGroupId: string | null; name: string | null }) => {
  if (!person.personGroupId || (entry.size !== undefined && entry.size < MIN_HEAD)) {
    return false;
  }
  if (entry.person !== undefined && entry.person !== person.personGroupId) {
    return true;
  }
  if (entry.source === 'manual') {
    return true;
  }
  if (entry.source === 'pixai') {
    return entry.confirmed === true;
  }
  return entry.source === 'cluster' && !!person.name;
};

/** a face teaches the fallback into people pixai does not know: their group and hand-made faces */
export const isFallbackReference = (
  entry: IndexEntry,
  person: { personGroupId: string | null },
  pixaiPeople: Set<string>,
) => {
  if (!person.personGroupId || pixaiPeople.has(person.personGroupId)) {
    return false;
  }
  if (entry.size !== undefined && entry.size < MIN_HEAD) {
    return false;
  }
  const changedByHand = entry.person !== undefined && entry.person !== person.personGroupId;
  return changedByHand || entry.source === 'cluster' || entry.source === 'manual';
};

/**
 * the fallback for a head pixai did not name: the closest person among the fallback targets, if it is
 * close enough, clearly ahead of every other known person, has enough references and the head is big
 */
export const fallbackMatch = (vector: Float32Array, size: number, references: References, exclude: Set<string>) => {
  if (MATCH_DISTANCE <= 0 || size < MIN_HEAD) {
    return;
  }
  let best: { person: string; distance: number } | undefined;
  let second = Infinity;
  const consider = (person: string, refs: Float32Array[], target: boolean) => {
    if (exclude.has(person) || refs.length === 0) {
      return;
    }
    const distance = distanceToReferences(vector, refs);
    if (target && refs.length >= FALLBACK_MIN_REFS && (!best || distance < best.distance)) {
      if (best) {
        second = Math.min(second, best.distance);
      }
      best = { person, distance };
    } else {
      second = Math.min(second, distance);
    }
  };
  for (const [person, refs] of references.fallback) {
    consider(person, refs, true);
  }
  for (const [person, refs] of references.pair) {
    if (!references.fallback.has(person)) {
      consider(person, refs, false);
    }
  }
  if (!best || best.distance > MATCH_DISTANCE || second - best.distance < FALLBACK_GAP) {
    return;
  }
  return best;
};

@Injectable()
export class DanbooruService extends BaseService {
  private stopped = false;
  private running?: Promise<void>;
  private failed = new Set<string>();
  private index = new Map<string, IndexEntry>();
  private names = new Map<string, Map<string, string>>();
  private lastMaintenance = 0;
  private autoHidden = new Set<string>();
  private pixaiPeople = new Set<string>();

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    if (!ENABLED) {
      return;
    }
    await this.loadIndex();
    await this.loadAutoHidden();
    this.logger.log(`Danbooru tagging on: ${TAGGER_URL}, ${this.scope()}, ${this.index.size} indexed faces`);
    this.running = this.loop();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopped = true;
    await this.running;
  }

  private scope() {
    if (ALBUM_NAMES.length === 0) {
      return 'all images';
    }
    return `albums [${ALBUM_NAMES.join(', ')}]${INCLUDE_UNSORTED ? ' + images in no album' : ''}`;
  }

  private get indexFolder() {
    return join(StorageCore.getMediaLocation(), 'custom', 'ccip');
  }

  private get autoHiddenFile() {
    return join(StorageCore.getMediaLocation(), 'custom', 'danbooru-autohidden.json');
  }

  /** the people this service hid; on the first start, hide every visible person with one image */
  async loadAutoHidden() {
    try {
      const { ids } = JSON.parse(await readFile(this.autoHiddenFile, 'utf8')) as { ids: string[] };
      this.autoHidden = new Set(ids);
      return;
    } catch {
      // first start: no list yet
    }
    const people = await this.personRepository.getPeopleAssetCounts();
    for (const { personGroupId, ownerId, isHidden, assets } of people) {
      if (isHidden || assets !== 1) {
        continue;
      }

      await this.personRepository.update({ ownerId, personGroupId, isHidden: true });
      this.autoHidden.add(personGroupId);
    }
    await this.saveAutoHidden();
    this.logger.log(`Danbooru: hid ${this.autoHidden.size} people with a single image`);
  }

  private async saveAutoHidden() {
    await mkdir(join(StorageCore.getMediaLocation(), 'custom'), { recursive: true });
    await writeFile(this.autoHiddenFile, JSON.stringify({ ids: [...this.autoHidden] }));
  }

  /** show auto-hidden people again once they have two images (deleted people leave the list) */
  async revealAutoHidden() {
    if (this.autoHidden.size === 0) {
      return;
    }
    const people = await this.personRepository.getPeopleAssetCounts([...this.autoHidden]);
    const existing = new Set(people.map(({ personGroupId }) => personGroupId));
    let changed = false;
    for (const id of this.autoHidden) {
      if (existing.has(id)) {
        continue;
      }

      this.autoHidden.delete(id);
      changed = true;
    }
    for (const { personGroupId, ownerId, isHidden, assets } of people) {
      if (assets < 2) {
        continue;
      }
      if (isHidden) {
        await this.personRepository.update({ ownerId, personGroupId, isHidden: false });
      }
      this.autoHidden.delete(personGroupId);
      changed = true;
    }
    if (changed) {
      await this.saveAutoHidden();
    }
  }

  private async loadIndex() {
    await mkdir(this.indexFolder, { recursive: true });
    for (const file of await readdir(this.indexFolder)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const { assetId, ownerId, faces, records } = JSON.parse(
          await readFile(join(this.indexFolder, file), 'utf8'),
        ) as {
          assetId: string;
          ownerId: string;
          faces: Record<string, number[]>;
          records?: Record<
            string,
            {
              person: string | null;
              source: FaceSource;
              confirmed?: boolean;
              regions?: Record<string, number>;
              headScores?: Record<string, number>;
              size?: number;
            }
          >;
        };
        for (const [faceId, values] of Object.entries(faces)) {
          const record = records?.[faceId];
          this.index.set(faceId, { assetId, ownerId, vector: normalize(values), ...record });
        }
      } catch (error) {
        this.logger.warn(`Skipping unreadable CCIP file ${file}: ${error}`);
      }
    }
  }

  private async loop() {
    let done = 0;
    while (!this.stopped) {
      let candidates: Candidate[];
      try {
        const model = await this.taggerModel();
        const rows = await this.assetRepository.getDanbooruCandidates({
          model,
          albumNames: ALBUM_NAMES,
          includeUnsorted: INCLUDE_UNSORTED,
          cameraAlbum: CAMERA_ALBUM,
          limit: BATCH_SIZE + this.failed.size,
        });
        candidates = rows.filter(({ id }) => !this.failed.has(id));
        if (candidates.length > 0) {
          this.pixaiPeople = await this.personRepository.getDanbooruPixaiPeople();
        }
      } catch (error) {
        this.logger.warn(`Danbooru tagging paused, tagger unavailable: ${this.describe(error)}`);
        await this.pause(TAGGER_DOWN_MS);
        continue;
      }

      if (candidates.length === 0) {
        if (Date.now() - this.lastMaintenance >= MAINTENANCE_MS) {
          this.lastMaintenance = Date.now();
          try {
            await this.maintenance();
          } catch (error) {
            this.logger.error(`Danbooru maintenance failed: ${this.describe(error)}`);
          }
        }
        await this.pause(IDLE_MS);
        continue;
      }

      for (const candidate of candidates.slice(0, BATCH_SIZE)) {
        if (this.stopped) {
          break;
        }
        try {
          await this.processAsset(candidate);
          done++;
          if (done % 50 === 0) {
            this.logger.log(`Danbooru tagging: ${done} images done since start`);
          }
        } catch (error) {
          this.logger.error(`Danbooru tagging of ${candidate.id} failed: ${this.describe(error)}`);
          if (error instanceof TypeError) {
            // fetch() failed: the tagger went away mid-batch — retry the image later
            await this.pause(TAGGER_DOWN_MS);
            break;
          }
          this.failed.add(candidate.id);
        }
      }
      await this.revealAutoHidden().catch((error) =>
        this.logger.error(`Danbooru auto-hide check failed: ${this.describe(error)}`),
      );
    }
  }

  private async pause(ms: number) {
    const step = 1000;
    for (let waited = 0; waited < ms && !this.stopped; waited += step) {
      await sleep(step);
    }
  }

  private describe(error: unknown) {
    // fetch() hides the network error in `cause` ("fetch failed")
    const cause = error instanceof Error && error.cause ? `: ${String(error.cause)}` : '';
    return `${error instanceof Error ? error.message : String(error)}${cause}`;
  }

  private async taggerModel(): Promise<string> {
    const response = await fetch(`${TAGGER_URL}/v2/info`);
    const info = (await response.json()) as { model: string; ready: boolean };
    if (!response.ok || !info.ready) {
      throw new Error(`tagger not ready (HTTP ${response.status})`);
    }
    return info.model;
  }

  private async analyze(image: Buffer, boxes?: Box[]): Promise<TaggerResult> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(image)]), 'preview');
    form.append('thresholds', THRESHOLDS);
    // boxes given (faces-only re-run): reuse those heads instead of detecting them again
    form.append('heads', boxes ? '0' : '1');
    form.append('boxes', JSON.stringify(boxes ?? []));
    form.append('regions', '1');
    const response = await fetch(`${TAGGER_URL}/v2/analyze`, { method: 'POST', body: form });
    if (!response.ok) {
      throw new Error(`tagger HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as TaggerResult;
  }

  async processAsset({ id: assetId, ownerId, previewPath, camera }: Candidate) {
    const previousRow = await this.assetRepository.getMetadataByKey(assetId, DANBOORU_MARKER_KEY);
    const previous = previousRow?.value as Marker | undefined;
    const facesOnly = previous?.model === FACES_ONLY_MODEL;

    const stored = facesOnly ? await this.storedHeads(assetId, ownerId) : undefined;
    const image = await this.storageRepository.readFile(previewPath);
    const result = await this.analyze(
      image,
      stored?.map(({ box }) => box),
    );
    if (stored) {
      // the tagger returns the given boxes in order, with their region scores
      result.heads = stored.map((head, i) => ({
        ...head,
        character: result.heads[i]?.character,
        head: result.heads[i]?.head,
      }));
    }

    const tagIds = facesOnly ? previous.tagIds : await this.applyTags(assetId, ownerId, result, previous);
    const { faces, removed } = await this.applyFaces(assetId, ownerId, camera ? null : result, previous);

    const marker: Marker = {
      model: result.model,
      at: new Date().toISOString(),
      tagIds,
      faceIds: faces.map(({ id }) => id),
      faces,
      removed,
      characters: result.tags.character,
    };
    await this.assetRepository.upsertMetadata(assetId, [{ key: DANBOORU_MARKER_KEY, value: marker }]);
    this.logger.debug(
      `Danbooru ${assetId}: ${tagIds.length} tags, characters [${Object.keys(result.tags.character).join(', ')}], ` +
        `${result.heads.length} heads`,
    );
  }

  /** heads detected in an earlier run (box + CCIP vector), reused by a faces-only re-run */
  private async storedHeads(assetId: string, ownerId: string): Promise<TaggerHead[]> {
    const faces = await this.personRepository.getFaces(assetId, { viewingUserId: ownerId });
    return faces.flatMap((face) => {
      const entry = this.index.get(face.id);
      if (!entry) {
        return [];
      }
      const box: Box = [face.boundingBoxX1, face.boundingBoxY1, face.boundingBoxX2, face.boundingBoxY2];
      return [{ box, score: 1, ccip: [...entry.vector] }];
    });
  }

  private async applyTags(assetId: string, ownerId: string, result: TaggerResult, previous?: Marker) {
    const general = Object.keys(result.tags.general).map((name) => cleanTagName(name));
    const series = Object.keys(result.tags.copyright).map((name) => `${SERIES_PREFIX}${cleanTagName(name)}`);
    const tags = await upsertTags(this.tagRepository, { userId: ownerId, tags: [...general, ...series, SENTINEL_TAG] });
    const newIds = tags.map(({ id }) => id);

    // no marker: every tag on the image came from the old tagger (verified 2026-10-20) → replace all
    let keep: string[] = [];
    if (previous) {
      const old = new Set(previous.tagIds);
      const current = await this.tagRepository.getAssetTagIds(assetId);
      keep = current.filter((id) => !old.has(id));
    }
    await this.tagRepository.replaceAssetTags(assetId, [...new Set([...keep, ...newIds])]);

    const { tags: values } = await this.assetRepository.getForUpdateTags(assetId);
    await this.assetRepository.upsertExif({
      exif: updateLockedColumns({
        assetId,
        description: general.join(', '),
        tags: values.map(({ value }) => value),
      }),
      lockedPropertiesBehavior: 'append',
    });
    await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id: assetId } });
    return newIds;
  }

  /** replace our faces on an image with new ones from `result`; `null` (camera photo) only removes ours */
  private async applyFaces(assetId: string, ownerId: string, result: TaggerResult | null, previous?: Marker) {
    const records = new Map((previous?.faces ?? []).map((record) => [record.id, record]));
    const oldFormat = new Set(previous?.faceIds);
    const existing = await this.personRepository.getFaces(assetId, { viewingUserId: ownerId });
    const existingIds = new Set(existing.map(({ id }) => id));
    const affected = new Set<string>();

    // faces of ours the user deleted are not recreated
    const removed: Box[] = [...(previous?.removed ?? [])];
    for (const record of records.values()) {
      if (!existingIds.has(record.id)) {
        removed.push(record.box);
      }
    }

    // keep what the user changed by hand; replace the rest of ours and the old worker's whole-image boxes
    const kept: FaceRecord[] = [];
    for (const face of existing) {
      const record = records.get(face.id);
      const person = face.personGroupId ?? null;
      if (result && record && (record.source === 'manual' || record.person !== person)) {
        kept.push({ ...record, person, source: 'manual' });
        const entry = this.index.get(face.id);
        if (entry) {
          Object.assign(entry, { person, source: 'manual' });
        }
        continue;
      }
      const wholeImage =
        face.boundingBoxX1 <= 1 &&
        face.boundingBoxY1 <= 1 &&
        face.boundingBoxX2 >= face.imageWidth - 1 &&
        face.boundingBoxY2 >= face.imageHeight - 1;
      const ours = !!record || oldFormat.has(face.id) || (face.sourceType === SourceType.Manual && wholeImage);
      if (!ours) {
        continue;
      }
      if (person) {
        affected.add(person);
      }
      await this.personRepository.deleteAssetFace(face.id);
      this.index.delete(face.id);
    }
    if (!result) {
      await this.saveAssetIndex(assetId, ownerId);
      await this.refreshFeaturePhotos(ownerId, affected);
      return { faces: kept, removed };
    }

    const references = await this.referencesFor(ownerId);
    const keptPeople = new Set(kept.map(({ person }) => person).filter(Boolean));
    const blocked = [...kept.map(({ box }) => box), ...removed];
    const assigned = await this.assignFaces(ownerId, result, references);
    const faces = assigned.filter(
      (face) =>
        !(face.personGroupId && keptPeople.has(face.personGroupId)) &&
        blocked.every((box) => overlap(box, toBox(face.box)) <= 0.5),
    );

    const created: FaceRecord[] = [];
    for (const face of faces) {
      const id = randomUUID();
      const box = toBox(face.box);
      await this.personRepository.createAssetFace({
        id,
        assetId,
        personGroupId: face.personGroupId,
        imageWidth: result.width,
        imageHeight: result.height,
        boundingBoxX1: box[0],
        boundingBoxY1: box[1],
        boundingBoxX2: box[2],
        boundingBoxY2: box[3],
        sourceType: SourceType.Manual,
      });
      created.push({
        id,
        person: face.personGroupId,
        source: face.source,
        box,
        ...(face.confirmed && { confirmed: true }),
      });
      if (face.personGroupId) {
        affected.add(face.personGroupId);
      }
      if (face.vector) {
        this.index.set(id, {
          assetId,
          ownerId,
          vector: face.vector,
          person: face.personGroupId,
          source: face.source,
          confirmed: face.confirmed,
          regions: face.regions,
          headScores: face.headScores,
          size: boxSize(box),
        });
      }
    }
    await this.saveAssetIndex(assetId, ownerId);
    await this.refreshFeaturePhotos(ownerId, affected);
    return { faces: [...kept, ...created], removed };
  }

  /** CCIP references of this owner: for pairing with pixai characters, and for the fallback */
  private async referencesFor(ownerId: string): Promise<References> {
    const faceIds = [...this.index].filter(([, entry]) => entry.ownerId === ownerId).map(([id]) => id);
    const references: References = { pair: new Map(), fallback: new Map() };
    const add = (map: Map<string, Float32Array[]>, person: string, vector: Float32Array) =>
      map.set(person, [...(map.get(person) ?? []), vector]);
    for (const row of await this.personRepository.getFacePersons(faceIds)) {
      const entry = this.index.get(row.id);
      if (!entry || !row.personGroupId) {
        continue;
      }
      if (isReference(entry, row)) {
        add(references.pair, row.personGroupId, entry.vector);
      }
      if (isFallbackReference(entry, row, this.pixaiPeople)) {
        add(references.fallback, row.personGroupId, entry.vector);
      }
    }
    return references;
  }

  async assignFaces(ownerId: string, result: TaggerResult, references: References) {
    const whole: FaceBox = { x1: 0, y1: 0, x2: result.width, y2: result.height };
    const heads = distinctHeads(result.heads)
      .map((i) => result.heads[i])
      .map((head) => ({
        box: { x1: head.box[0], y1: head.box[1], x2: head.box[2], y2: head.box[3] },
        vector: head.ccip ? normalize(head.ccip) : undefined,
        regions: head.character,
        headScores: head.head,
      }));
    // sequential on purpose: personFor may create a person and caches the names
    const tags = Object.keys(result.tags.character);
    const characters = await Array.fromAsync(tags, (name) => this.personFor(ownerId, personName(name)));
    const nameOf = new Map(characters.map((person, i) => [person, tagKey(tags[i])]));
    const scoreOf = new Map(characters.map((person, i) => [person, result.tags.character[tags[i]]]));
    for (const person of characters) {
      this.pixaiPeople.add(person);
    }

    const faces: NewFace[] = [];
    const freeHeads = new Set(heads.keys());
    const freeCharacters = new Set(characters);
    const take = (head: number, person: string, confirmed: boolean) => {
      faces.push({ ...heads[head], personGroupId: person, source: 'pixai', confirmed });
      freeHeads.delete(head);
      freeCharacters.delete(person);
    };
    const regionScore = (head: number, person: string) =>
      regionRanking(heads[head].regions, [nameOf.get(person)!]).best.score;

    // 1. region pixai: heads whose region clearly shows one of the image's characters
    const winners = [...freeHeads]
      .map((head) => ({
        head,
        win: regionWinner(
          heads[head].regions,
          characters.map((c) => nameOf.get(c)!),
          heads[head].headScores,
        ),
      }))
      .filter(({ win }) => win)
      .sort((a, b) => b.win!.score - a.win!.score);
    for (const { head, win } of winners) {
      const person = characters.find((c) => nameOf.get(c) === win!.name)!;
      if (freeHeads.has(head) && freeCharacters.has(person)) {
        take(head, person, true);
      }
    }

    // 2. the rest: closest trusted references (heads whose region contradicts are skipped)
    const pairs: Array<{ head: number; person: string; distance: number }> = [];
    for (const head of freeHeads) {
      const { vector } = heads[head];
      for (const person of freeCharacters) {
        const refs = references.pair.get(person);
        if (vector && refs?.length) {
          pairs.push({ head, person, distance: distanceToReferences(vector, refs) });
        }
      }
    }
    pairs.sort((a, b) => a.distance - b.distance);
    const headOk = (head: number, person: string) => headShows(heads[head].headScores, nameOf.get(person)!);
    for (const { head, person, distance } of pairs) {
      if (distance <= PAIR_DISTANCE && freeHeads.has(head) && freeCharacters.has(person) && headOk(head, person)) {
        take(head, person, regionScore(head, person) >= REGION_SCORE);
      }
    }

    // 3. one head and one character left (e.g. a character seen for the first time): pair them,
    //    unless the region does not show the character at all (a glove taken for a head)
    if (freeHeads.size === 1 && freeCharacters.size === 1) {
      const [head] = freeHeads;
      const [person] = freeCharacters;
      const score = regionScore(head, person);
      if ((!heads[head].regions || score >= 0.1) && headOk(head, person)) {
        take(head, person, score >= REGION_SCORE);
      }
    }

    // 4. characters without a head: whole-image face (only clear ones when every head is confirmed)
    const allConfirmed = heads.length > 0 && freeHeads.size === 0 && faces.every(({ confirmed }) => confirmed);
    for (const person of freeCharacters) {
      if (allConfirmed && scoreOf.get(person)! < EXTRA_SCORE) {
        continue;
      }
      faces.push({ box: whole, personGroupId: person, source: 'whole' });
    }

    // 5. heads without a pixai character: the fallback into people pixai does not know, else unassigned
    const used = new Set(faces.map(({ personGroupId }) => personGroupId).filter(Boolean) as string[]);
    for (const head of freeHeads) {
      const { vector, box, regions } = heads[head];
      const best =
        vector && !regionClaimed(regions) ? fallbackMatch(vector, boxSize(box), references, used) : undefined;
      if (best) {
        used.add(best.person);
      }
      faces.push({ ...heads[head], personGroupId: best?.person ?? null, source: best ? 'ccip' : 'none' });
    }
    return faces;
  }

  async maintenance() {
    this.pixaiPeople = await this.personRepository.getDanbooruPixaiPeople();
    await this.revealAutoHidden();
    await this.stripCameraFaces();
    await this.deleteEmptyClusters();
    const owners = new Set(this.index.values().map(({ ownerId }) => ownerId));
    for (const ownerId of owners) {
      const stats = await this.maintainOwner(ownerId);
      this.logger.log(
        `Danbooru maintenance: ${stats.paired} heads paired with their image's characters, ` +
          `${stats.matched} matched later, ${stats.clustered} grouped into ${stats.clusters} new unnamed people, ` +
          `${stats.left} still unassigned`,
      );
    }
  }

  /** camera photos that joined the camera album after tagging lose their Danbooru faces */
  private async stripCameraFaces() {
    const assets = await this.assetRepository.getDanbooruCameraAssets(CAMERA_ALBUM);
    for (const { id: assetId, ownerId } of assets) {
      const row = await this.assetRepository.getMetadataByKey(assetId, DANBOORU_MARKER_KEY);
      const marker = row?.value as Marker;
      const { faces, removed } = await this.applyFaces(assetId, ownerId, null, marker);
      await this.assetRepository.upsertMetadata(assetId, [
        { key: DANBOORU_MARKER_KEY, value: { ...marker, faces, faceIds: faces.map(({ id }) => id), removed } },
      ]);
    }
    if (assets.length > 0) {
      this.logger.log(`Danbooru maintenance: removed the faces of ${assets.length} camera photos`);
    }
  }

  private async maintainOwner(ownerId: string) {
    const stats = { paired: 0, matched: 0, clustered: 0, clusters: 0, left: 0 };
    const faceIds = [...this.index].filter(([, entry]) => entry.ownerId === ownerId).map(([id]) => id);
    const rows = await this.personRepository.getFacePersons(faceIds);
    const references = await this.referencesFor(ownerId);
    const unassigned = new Map<string, string[]>();
    // heads in an unnamed cluster may still be paired: a character pixai named on the image wins
    const clustered = new Set<string>();
    for (const row of rows) {
      const entry = this.index.get(row.id)!;
      const unnamedCluster = !!row.personGroupId && !row.name && entry.source === 'cluster';
      if (row.personGroupId && !unnamedCluster) {
        continue;
      }

      unassigned.set(entry.assetId, [...(unassigned.get(entry.assetId) ?? []), row.id]);
      if (unnamedCluster) {
        clustered.add(row.id);
      }
    }
    await this.repairLostPairings(ownerId, rows);
    // face changes per image, written to its marker and CCIP file (null = face deleted)
    const changes = new Map<string, Map<string, FaceChange | null>>();
    const change = (faceId: string, value: FaceChange | null, assetId?: string) => {
      const asset = assetId ?? this.index.get(faceId)!.assetId;
      changes.set(asset, (changes.get(asset) ?? new Map()).set(faceId, value));
    };

    const affected = new Set<string>();
    const remaining: string[] = [];
    for (const [assetId, heads] of unassigned) {
      const faces = await this.personRepository.getFaces(assetId, { viewingUserId: ownerId });
      const present = new Set(faces.map(({ personGroupId }) => personGroupId).filter(Boolean));
      const wholeImage = faces.filter(
        (face) =>
          face.sourceType === SourceType.Manual &&
          face.personGroupId &&
          face.boundingBoxX1 <= 1 &&
          face.boundingBoxY1 <= 1 &&
          face.boundingBoxX2 >= face.imageWidth - 1 &&
          face.boundingBoxY2 >= face.imageHeight - 1,
      );

      // 1. heads ↔ the characters pixai named on this image (their whole-image faces):
      //    a clear region winner first, then the closest trusted references
      const freeHeads = new Set(heads);
      const usedFaces = new Set<string>();
      const pairWith = async (head: string, face: (typeof wholeImage)[number], confirmed: boolean) => {
        await this.personRepository.reassignFace(head, face.personGroupId!);
        await this.personRepository.deleteAssetFace(face.id);
        change(head, { person: face.personGroupId!, source: 'pixai', ...(confirmed && { confirmed }) });
        change(face.id, null, assetId);
        affected.add(face.personGroupId!);
        freeHeads.delete(head);
        usedFaces.add(face.id);
        stats.paired++;
      };
      const wholeName = (face: (typeof wholeImage)[number]) => (face.person?.name ?? '').toLowerCase();
      const names = wholeImage.map((face) => wholeName(face));
      for (const head of heads) {
        const entry = this.index.get(head)!;
        const win = regionWinner(entry.regions, names, entry.headScores);
        const face = win && wholeImage.find((candidate) => wholeName(candidate) === win.name);
        if (face && freeHeads.has(head) && !usedFaces.has(face.id)) {
          await pairWith(head, face, true);
        }
      }
      const pairs: Array<{ head: string; face: (typeof wholeImage)[number]; distance: number }> = [];
      for (const head of freeHeads) {
        for (const face of wholeImage) {
          const refs = references.pair.get(face.personGroupId!);
          if (!refs?.length || usedFaces.has(face.id)) {
            continue;
          }
          const distance = distanceToReferences(this.index.get(head)!.vector, refs);
          if (distance <= PAIR_DISTANCE) {
            pairs.push({ head, face, distance });
          }
        }
      }
      pairs.sort((a, b) => a.distance - b.distance);
      for (const { head, face } of pairs) {
        const entry = this.index.get(head)!;
        if (!freeHeads.has(head) || usedFaces.has(face.id) || !headShows(entry.headScores, wholeName(face))) {
          continue;
        }

        const score = regionRanking(entry.regions, [wholeName(face)]).best.score;
        await pairWith(head, face, score >= REGION_SCORE);
      }

      // 2. the rest: the fallback into people pixai does not know (clustered heads stay put)
      for (const head of freeHeads) {
        if (clustered.has(head)) {
          continue;
        }
        const entry = this.index.get(head)!;
        if (regionClaimed(entry.regions)) {
          continue;
        }
        // size unknown (CCIP file from before head sizes were stored): no fallback until the next re-run
        const best = fallbackMatch(entry.vector, entry.size ?? 0, references, present as Set<string>);
        if (best) {
          await this.personRepository.reassignFace(head, best.person);
          change(head, { person: best.person, source: 'ccip' });
          present.add(best.person);
          affected.add(best.person);
          stats.matched++;
        } else {
          remaining.push(head);
        }
      }
    }

    // record pairing/matching now: the clustering below talks to the tagger and can fail
    for (const [assetId, faceChanges] of changes) {
      await this.recordChanges(assetId, ownerId, faceChanges);
    }
    changes.clear();

    // 3. cluster what is left into unnamed people (new characters to name)
    try {
      await this.clusterRemaining(ownerId, remaining, change, affected, stats);
    } finally {
      stats.left = remaining.length - stats.clustered;
      for (const [assetId, faceChanges] of changes) {
        await this.recordChanges(assetId, ownerId, faceChanges);
      }
      await this.refreshFeaturePhotos(ownerId, affected);
    }
    return stats;
  }

  private async clusterRemaining(
    ownerId: string,
    remaining: string[],
    change: (faceId: string, value: FaceChange) => void,
    affected: Set<string>,
    stats: { clustered: number; clusters: number },
  ) {
    if (!(remaining.length >= CLUSTER_MIN)) {
      return;
    }

    const response = await fetch(`${TAGGER_URL}/v2/cluster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeddings: remaining.map((id) => [...this.index.get(id)!.vector]),
        min_samples: CLUSTER_MIN,
      }),
    });
    if (!response.ok) {
      throw new Error(`tagger cluster HTTP ${response.status}: ${await response.text()}`);
    }
    const { labels } = (await response.json()) as { labels: number[] };
    const clusters = new Map<number, string[]>();
    for (const [i, label] of labels.entries()) {
      if (label >= 0) {
        clusters.set(label, [...(clusters.get(label) ?? []), remaining[i]]);
      }
    }
    for (const members of clusters.values()) {
      const group = await this.personRepository.createGroup(ownerId);
      await this.personRepository.create({ ownerId, personGroupId: group.id, name: '' });
      for (const id of members) {
        await this.personRepository.reassignFace(id, group.id);
        change(id, { person: group.id, source: 'cluster' });
      }
      affected.add(group.id);
      stats.clusters++;
      stats.clustered += members.length;
    }
  }

  /**
   * a pairing whose marker update was lost (a maintenance pass that failed afterwards, 2026-10-21):
   * a head recorded without a person now belongs to a character whose whole-image face on the same
   * image is gone. Record it as pixai, and forget the whole-image face (the user did not delete it).
   */
  private async repairLostPairings(ownerId: string, rows: Array<{ id: string; personGroupId: string | null }>) {
    const suspects = new Map<string, Array<{ id: string; person: string }>>();
    for (const { id, personGroupId } of rows) {
      const entry = this.index.get(id);
      if (!entry || !personGroupId || entry.person || (entry.source && entry.source !== 'none')) {
        continue;
      }
      suspects.set(entry.assetId, [...(suspects.get(entry.assetId) ?? []), { id, person: personGroupId }]);
    }

    let repaired = 0;
    for (const [assetId, heads] of suspects) {
      const row = await this.assetRepository.getMetadataByKey(assetId, DANBOORU_MARKER_KEY);
      const marker = row?.value as Marker | undefined;
      if (!marker?.faces) {
        continue;
      }
      const faces = await this.personRepository.getFaces(assetId, { viewingUserId: ownerId });
      const existing = new Set(faces.map(({ id }) => id));
      const faceChanges = new Map<string, FaceChange | null>();
      for (const head of heads) {
        const whole = marker.faces.find(
          (record) =>
            record.source === 'whole' &&
            record.person === head.person &&
            !existing.has(record.id) &&
            !faceChanges.has(record.id),
        );
        if (!whole) {
          continue;
        }
        faceChanges.set(head.id, { person: head.person, source: 'pixai' });
        faceChanges.set(whole.id, null);
        repaired++;
      }
      if (faceChanges.size > 0) {
        await this.recordChanges(assetId, ownerId, faceChanges);
      }
    }
    if (repaired > 0) {
      this.logger.log(`Danbooru maintenance: recorded ${repaired} pairings an interrupted pass had not written`);
    }
  }

  /** apply maintenance changes to an image's marker and CCIP file (null = the face was deleted) */
  private async recordChanges(assetId: string, ownerId: string, faceChanges: Map<string, FaceChange | null>) {
    for (const [faceId, value] of faceChanges) {
      const entry = this.index.get(faceId);
      if (entry && value) {
        Object.assign(entry, value);
      }
    }
    await this.saveAssetIndex(assetId, ownerId);

    const row = await this.assetRepository.getMetadataByKey(assetId, DANBOORU_MARKER_KEY);
    const marker = row?.value as Marker | undefined;
    if (!marker?.faces) {
      return;
    }
    const faces = marker.faces
      .filter(({ id }) => faceChanges.get(id) !== null)
      .map((record) => ({ ...record, ...faceChanges.get(record.id) }));
    await this.assetRepository.upsertMetadata(assetId, [
      { key: DANBOORU_MARKER_KEY, value: { ...marker, faces, faceIds: faces.map(({ id }) => id) } },
    ]);
  }

  /** unnamed people (clusters) that lost all their faces, e.g. after a remap */
  private async deleteEmptyClusters() {
    const people = await this.personRepository.getPeopleAssetCounts();
    const empty = new Map<string, string[]>();
    for (const { personGroupId, ownerId, name, assets } of people) {
      if (assets === 0 && !name) {
        empty.set(ownerId, [...(empty.get(ownerId) ?? []), personGroupId]);
      }
    }
    for (const [ownerId, ids] of empty) {
      await this.personRepository.delete(ids, ownerId);
      this.logger.log(`Danbooru maintenance: deleted ${ids.length} empty unnamed people`);
    }
  }

  /** person (group id) with this exact name, created when missing */
  private async personFor(ownerId: string, name: string): Promise<string> {
    let names = this.names.get(ownerId);
    if (!names) {
      const people = await this.personRepository.getDistinctNames(ownerId, { withHidden: true });
      names = new Map(people.map((person) => [person.name.toLowerCase(), person.personGroupId]));
      this.names.set(ownerId, names);
    }
    const key = name.toLowerCase();
    const known = names.get(key);
    if (known) {
      const person = await this.personRepository.getByGroupId({ ownerId, personGroupId: known });
      if (person && person.name.toLowerCase() === key) {
        return known;
      }
      // renamed or deleted in the meantime: reload the names once
      this.names.delete(ownerId);
      return this.personFor(ownerId, name);
    }
    const group = await this.personRepository.createGroup(ownerId);
    // hidden until a second image shows the character (see revealAutoHidden)
    await this.personRepository.create({ ownerId, personGroupId: group.id, name, isHidden: true });
    this.autoHidden.add(group.id);
    await this.saveAutoHidden();
    names.set(key, group.id);
    return group.id;
  }

  private async refreshFeaturePhotos(ownerId: string, personGroupIds: Set<string>) {
    const missing = [];
    for (const personGroupId of personGroupIds) {
      const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
      if (person && !person.faceAssetId) {
        missing.push({ ownerId, personGroupId });
      }
    }
    if (missing.length > 0) {
      await BaseService.create(PersonService, this).createNewFeaturePhoto(missing);
    }
  }

  /** the CCIP file of an image: its indexed faces with vector, person and source */
  private async saveAssetIndex(assetId: string, ownerId: string) {
    const path = join(this.indexFolder, `${assetId}.json`);
    const entries = [...this.index].filter(([, entry]) => entry.assetId === assetId);
    if (entries.length === 0) {
      await rm(path, { force: true });
      return;
    }
    const faces: Record<string, number[]> = {};
    const records: Record<string, Omit<IndexEntry, 'assetId' | 'ownerId' | 'vector'>> = {};
    for (const [id, entry] of entries) {
      faces[id] = Array.from(entry.vector, (value) => Math.round(value * 1e6) / 1e6);
      records[id] = {
        person: entry.person ?? null,
        source: entry.source ?? 'none',
        ...(entry.confirmed && { confirmed: true }),
        ...(entry.regions && { regions: entry.regions }),
        ...(entry.headScores && { headScores: entry.headScores }),
        ...(entry.size !== undefined && { size: entry.size }),
      };
    }
    await mkdir(this.indexFolder, { recursive: true });
    await writeFile(path, JSON.stringify({ assetId, ownerId, faces, records }));
  }
}
