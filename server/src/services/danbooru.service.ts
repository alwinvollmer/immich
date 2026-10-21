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
const THRESHOLDS = process.env.IMMICH_DANBOORU_THRESHOLDS || '{}';
// cosine distance; mean of a character's 3 closest references (CCIP test: ~95 % correct, ~65 % assigned)
const MATCH_DISTANCE = Number(process.env.IMMICH_DANBOORU_MATCH_DISTANCE || 0.21);
// a head on an image whose characters pixai named only needs to be closer to one of them than this
const PAIR_DISTANCE = MATCH_DISTANCE * 2;
const CLUSTER_MIN = Number(process.env.IMMICH_DANBOORU_CLUSTER_MIN || 5);
const MAINTENANCE_MS = Number(process.env.IMMICH_DANBOORU_MAINTENANCE_HOURS || 12) * 3_600_000;

export const DANBOORU_MARKER_KEY = 'custom.danbooru';
const SENTINEL_TAG = 'danbooru';
const SERIES_PREFIX = '::series:';
const BATCH_SIZE = 20;
const IDLE_MS = 30_000;
const TAGGER_DOWN_MS = 60_000;

type TaggerHead = { box: [number, number, number, number]; score: number; ccip: number[] };
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
export type FaceRecord = { id: string; person: string | null; source: FaceSource; box: Box };
type Marker = {
  model: string;
  at: string;
  tagIds: string[];
  faceIds: string[];
  faces?: FaceRecord[];
  // boxes of faces the user deleted: never recreated
  removed?: Box[];
};
type IndexEntry = {
  assetId: string;
  ownerId: string;
  vector: Float32Array;
  person?: string | null;
  source?: FaceSource;
};
type Candidate = { id: string; ownerId: string; previewPath: string };
type FaceBox = { x1: number; y1: number; x2: number; y2: number };
type NewFace = { box: FaceBox; personGroupId: string | null; source: FaceSource; vector?: Float32Array };

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

/**
 * a face teaches the matching only when its person is trustworthy: named by pixai, set by hand
 * (also: its person differs from the one this service recorded), or a cluster the user named.
 * CCIP fallback matches never become references (they snowballed: ~730 heads ended up as Tifa).
 */
export const isReference = (entry: IndexEntry, person: { personGroupId: string | null; name: string | null }) => {
  if (!person.personGroupId) {
    return false;
  }
  if (entry.person !== undefined && entry.person !== person.personGroupId) {
    return true;
  }
  if (entry.source === 'pixai' || entry.source === 'manual') {
    return true;
  }
  return entry.source === 'cluster' && !!person.name;
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
          records?: Record<string, { person: string | null; source: FaceSource }>;
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
          limit: BATCH_SIZE + this.failed.size,
        });
        candidates = rows.filter(({ id }) => !this.failed.has(id));
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

  private async analyze(image: Buffer): Promise<TaggerResult> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(image)]), 'preview');
    form.append('thresholds', THRESHOLDS);
    const response = await fetch(`${TAGGER_URL}/v2/analyze`, { method: 'POST', body: form });
    if (!response.ok) {
      throw new Error(`tagger HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as TaggerResult;
  }

  async processAsset({ id: assetId, ownerId, previewPath }: Candidate) {
    const result = await this.analyze(await this.storageRepository.readFile(previewPath));
    const previousRow = await this.assetRepository.getMetadataByKey(assetId, DANBOORU_MARKER_KEY);
    const previous = previousRow?.value as Marker | undefined;

    const tagIds = await this.applyTags(assetId, ownerId, result, previous);
    const { faces, removed } = await this.applyFaces(assetId, ownerId, result, previous);

    const marker: Marker = {
      model: result.model,
      at: new Date().toISOString(),
      tagIds,
      faceIds: faces.map(({ id }) => id),
      faces,
      removed,
    };
    await this.assetRepository.upsertMetadata(assetId, [{ key: DANBOORU_MARKER_KEY, value: marker }]);
    this.logger.debug(
      `Danbooru ${assetId}: ${tagIds.length} tags, characters [${Object.keys(result.tags.character).join(', ')}], ` +
        `${result.heads.length} heads`,
    );
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

  private async applyFaces(assetId: string, ownerId: string, result: TaggerResult, previous?: Marker) {
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
      if (record && (record.source === 'manual' || record.person !== person)) {
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
      created.push({ id, person: face.personGroupId, source: face.source, box });
      if (face.personGroupId) {
        affected.add(face.personGroupId);
      }
      if (face.vector) {
        this.index.set(id, { assetId, ownerId, vector: face.vector, person: face.personGroupId, source: face.source });
      }
    }
    await this.saveAssetIndex(assetId, ownerId);
    await this.refreshFeaturePhotos(ownerId, affected);
    return { faces: [...kept, ...created], removed };
  }

  /** CCIP references per person of this owner: only faces whose person can be trusted (isReference) */
  private async referencesFor(ownerId: string) {
    const faceIds = [...this.index].filter(([, entry]) => entry.ownerId === ownerId).map(([id]) => id);
    const references = new Map<string, Float32Array[]>();
    for (const row of await this.personRepository.getFacePersons(faceIds)) {
      const entry = this.index.get(row.id);
      if (!entry || !isReference(entry, row)) {
        continue;
      }
      const list = references.get(row.personGroupId!) ?? [];
      list.push(entry.vector);
      references.set(row.personGroupId!, list);
    }
    return references;
  }

  async assignFaces(ownerId: string, result: TaggerResult, references: Map<string, Float32Array[]>) {
    const whole: FaceBox = { x1: 0, y1: 0, x2: result.width, y2: result.height };
    const heads = result.heads.map((head) => ({
      box: { x1: head.box[0], y1: head.box[1], x2: head.box[2], y2: head.box[3] },
      vector: normalize(head.ccip),
    }));
    // sequential on purpose: personFor may create a person and caches the names
    const characters = await Array.fromAsync(Object.keys(result.tags.character), (name) =>
      this.personFor(ownerId, personName(name)),
    );

    const faces: NewFace[] = [];
    const freeHeads = new Set(heads.keys());
    const freeCharacters = new Set(characters);

    // pixai characters → heads, closest reference distance first
    const pairs: Array<{ head: number; person: string; distance: number }> = [];
    for (const [head, { vector }] of heads.entries()) {
      for (const person of characters) {
        const refs = references.get(person);
        if (refs?.length) {
          pairs.push({ head, person, distance: distanceToReferences(vector, refs) });
        }
      }
    }
    pairs.sort((a, b) => a.distance - b.distance);
    for (const { head, person } of pairs) {
      if (!(freeHeads.has(head) && freeCharacters.has(person))) {
        continue;
      }

      faces.push({ ...heads[head], personGroupId: person, source: 'pixai' });
      freeHeads.delete(head);
      freeCharacters.delete(person);
    }
    // one head and one character left (e.g. a character seen for the first time): pair them
    if (freeHeads.size === 1 && freeCharacters.size === 1) {
      const [head] = freeHeads;
      const [person] = freeCharacters;
      faces.push({ ...heads[head], personGroupId: person, source: 'pixai' });
      freeHeads.clear();
      freeCharacters.clear();
    }
    // characters without a head: whole-image face, as the old worker did
    for (const person of freeCharacters) {
      faces.push({ box: whole, personGroupId: person, source: 'whole' });
    }
    // heads without a pixai character: strict match against all known characters, else unassigned
    const used = new Set(faces.map(({ personGroupId }) => personGroupId));
    for (const head of freeHeads) {
      let best: { person: string; distance: number } | undefined;
      for (const [person, refs] of references) {
        if (used.has(person) || refs.length < 2) {
          continue;
        }
        const distance = distanceToReferences(heads[head].vector, refs);
        if (distance <= MATCH_DISTANCE && (!best || distance < best.distance)) {
          best = { person, distance };
        }
      }
      if (best) {
        used.add(best.person);
      }
      faces.push({ ...heads[head], personGroupId: best?.person ?? null, source: best ? 'ccip' : 'none' });
    }
    return faces;
  }

  async maintenance() {
    await this.revealAutoHidden();
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

  private async maintainOwner(ownerId: string) {
    const stats = { paired: 0, matched: 0, clustered: 0, clusters: 0, left: 0 };
    const faceIds = [...this.index].filter(([, entry]) => entry.ownerId === ownerId).map(([id]) => id);
    const rows = await this.personRepository.getFacePersons(faceIds);
    const references = new Map<string, Float32Array[]>();
    const unassigned = new Map<string, string[]>();
    for (const row of rows) {
      const entry = this.index.get(row.id)!;
      if (!row.personGroupId) {
        unassigned.set(entry.assetId, [...(unassigned.get(entry.assetId) ?? []), row.id]);
      } else if (isReference(entry, row)) {
        references.set(row.personGroupId, [...(references.get(row.personGroupId) ?? []), entry.vector]);
      }
    }
    // face changes per image, written to its marker and CCIP file at the end (null = face deleted)
    const changes = new Map<string, Map<string, { person: string; source: FaceSource } | null>>();
    const change = (faceId: string, value: { person: string; source: FaceSource } | null, assetId?: string) => {
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

      // 1. heads ↔ the characters pixai named on this image (their whole-image faces)
      const pairs: Array<{ head: string; face: (typeof wholeImage)[number]; distance: number }> = [];
      for (const head of heads) {
        for (const face of wholeImage) {
          const refs = references.get(face.personGroupId!);
          if (!refs?.length) {
            continue;
          }
          const distance = distanceToReferences(this.index.get(head)!.vector, refs);
          if (distance <= PAIR_DISTANCE) {
            pairs.push({ head, face, distance });
          }
        }
      }
      pairs.sort((a, b) => a.distance - b.distance);
      const freeHeads = new Set(heads);
      const usedFaces = new Set<string>();
      for (const { head, face } of pairs) {
        if (!freeHeads.has(head) || usedFaces.has(face.id)) {
          continue;
        }

        await this.personRepository.reassignFace(head, face.personGroupId!);
        await this.personRepository.deleteAssetFace(face.id);
        change(head, { person: face.personGroupId!, source: 'pixai' });
        change(face.id, null, assetId);
        affected.add(face.personGroupId!);
        freeHeads.delete(head);
        usedFaces.add(face.id);
        stats.paired++;
      }

      // 2. the rest: strict match against all characters not yet on this image
      for (const head of freeHeads) {
        let best: { person: string; distance: number } | undefined;
        for (const [person, refs] of references) {
          if (present.has(person) || refs.length < 2) {
            continue;
          }
          const distance = distanceToReferences(this.index.get(head)!.vector, refs);
          if (distance <= MATCH_DISTANCE && (!best || distance < best.distance)) {
            best = { person, distance };
          }
        }
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

    // 3. cluster what is left into unnamed people (new characters to name)
    if (remaining.length >= CLUSTER_MIN) {
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
    stats.left = remaining.length - stats.clustered;
    for (const [assetId, faceChanges] of changes) {
      await this.recordChanges(assetId, ownerId, faceChanges);
    }
    await this.refreshFeaturePhotos(ownerId, affected);
    return stats;
  }

  /** apply maintenance changes to an image's marker and CCIP file (null = the face was deleted) */
  private async recordChanges(
    assetId: string,
    ownerId: string,
    faceChanges: Map<string, { person: string; source: FaceSource } | null>,
  ) {
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
    const records: Record<string, { person: string | null; source: FaceSource }> = {};
    for (const [id, entry] of entries) {
      faces[id] = Array.from(entry.vector, (value) => Math.round(value * 1e6) / 1e6);
      records[id] = { person: entry.person ?? null, source: entry.source ?? 'none' };
    }
    await mkdir(this.indexFolder, { recursive: true });
    await writeFile(path, JSON.stringify({ assetId, ownerId, faces, records }));
  }
}
