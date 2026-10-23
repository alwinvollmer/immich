// custom: Danbooru tagging (pixai-tagger-v1.0 + CCIP faces)
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { SourceType } from 'src/enum.js';
import {
  DANBOORU_MARKER_KEY,
  DanbooruService,
  TaggerResult,
  cleanTagName,
  distanceToReferences,
  distinctHeads,
  personName,
} from 'src/services/danbooru.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const ownerId = 'owner-1';

// unit vectors along one axis (+ a small tilt), so cosine distances are easy to reason about
const axis = (index: number, tilt = 0) => {
  const values = Array.from({ length: 8 }, () => 0);
  values[index] = 1;
  values[(index + 1) % 8] = tilt;
  return values;
};
const vec = (values: number[]) => {
  const norm = Math.hypot(...values);
  return Float32Array.from(values, (value) => value / norm);
};

const head = (index: number, box = [10, 10, 110, 110], character?: Record<string, number>) => ({
  box: box as never,
  score: 0.9,
  ccip: axis(index),
  ...(character && { character }),
});

const characters = (names: Record<string, number>) => ({ ...result().tags, character: names });

const refs = (pair: Array<[string, number[][]]> = [], fallback: Array<[string, number[][]]> = []) => ({
  pair: new Map(pair.map(([person, list]) => [person, list.map((values) => vec(values))])),
  fallback: new Map(fallback.map(([person, list]) => [person, list.map((values) => vec(values))])),
});

const result = (overrides: Partial<TaggerResult> = {}): TaggerResult => ({
  model: 'pixai-tagger-v1.0',
  width: 1000,
  height: 800,
  tags: { general: { '1girl': 0.99, 'fate/stay_night_logo': 0.5 }, character: {}, copyright: {}, rating: {} },
  heads: [],
  ...overrides,
});

const wholeImageFace = (id: string, personGroupId: string) => ({
  id,
  personGroupId,
  sourceType: SourceType.Manual,
  imageWidth: 1000,
  imageHeight: 800,
  boundingBoxX1: 0,
  boundingBoxY1: 0,
  boundingBoxX2: 1000,
  boundingBoxY2: 800,
});

const loadIndex = async (
  sut: DanbooruService,
  files: Record<
    string,
    {
      assetId: string;
      faces: Record<string, number[]>;
      records?: Record<string, { person: string | null; source: string; confirmed?: boolean; size?: number }>;
    }
  >,
) => {
  vi.mocked(readdir).mockResolvedValue(Object.keys(files).map((name) => `${name}.json`) as never);
  vi.mocked(readFile).mockImplementation((path) =>
    Promise.resolve(JSON.stringify({ ...files[String(path).split('/').pop()!.replace('.json', '')], ownerId })),
  );
  await (sut as unknown as { loadIndex(): Promise<void> }).loadIndex();
};

describe(DanbooruService.name, () => {
  let sut: DanbooruService;
  let mocks: ServiceMocks;
  let people: Map<string, string>;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(DanbooruService));
    people = new Map([
      ['megumin', 'p-megumin'],
      ['yunyun', 'p-yunyun'],
    ]);
    mocks.person.getDistinctNames.mockImplementation(() =>
      Promise.resolve([...people].map(([name, personGroupId]) => ({ name, personGroupId }))),
    );
    mocks.person.getByGroupId.mockImplementation(({ personGroupId }) => {
      const name = [...people].find(([, id]) => id === personGroupId)?.[0];
      return Promise.resolve(name ? ({ personGroupId, name, faceAssetId: 'face' } as never) : undefined);
    });
    let groups = 0;
    mocks.person.createGroup.mockImplementation(() => Promise.resolve({ id: `p-new-${++groups}` } as never));
    mocks.person.create.mockResolvedValue({} as never);
    mocks.person.getPeopleAssetCounts.mockResolvedValue([]);
    mocks.person.getDanbooruPixaiPeople.mockResolvedValue(new Set(['p-megumin', 'p-yunyun']));
    mocks.asset.getDanbooruCameraAssets.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('helpers', () => {
    it('averages the three closest references', () => {
      const refs = [vec(axis(0)), vec(axis(0, 0.1)), vec(axis(1)), vec(axis(2))];
      const distance = distanceToReferences(vec(axis(0)), refs);
      // two near-identical references and one orthogonal (distance 1)
      expect(distance).toBeGreaterThan(0.33);
      expect(distance).toBeLessThan(0.34);
    });

    it('keeps tag names flat and turns characters into readable names', () => {
      expect(cleanTagName('excalibur_(fate/stay_night)')).toBe('excalibur_(fate_stay_night)');
      expect(personName('raiden_shogun')).toBe('raiden shogun');
    });
  });

  describe('assignFaces', () => {
    it('pairs a single head with a single character, even without references', async () => {
      const faces = await sut.assignFaces(
        ownerId,
        result({ tags: characters({ megumin: 0.9 }), heads: [head(0)] }),
        refs(),
      );
      expect(faces).toEqual([
        expect.objectContaining({
          personGroupId: 'p-megumin',
          source: 'pixai',
          box: { x1: 10, y1: 10, x2: 110, y2: 110 },
        }),
      ]);
    });

    it('does not put the character on a lone head whose region does not show it (a glove taken for a head)', async () => {
      const faces = await sut.assignFaces(
        ownerId,
        result({ tags: characters({ megumin: 0.9 }), heads: [head(0, undefined, { yunyun: 0.02 })] }),
        refs(),
      );
      expect(faces.map(({ personGroupId, source }) => [personGroupId, source])).toEqual([
        ['p-megumin', 'whole'],
        [null, 'none'],
      ]);
    });

    it('gives a character without a head a whole-image face', async () => {
      const faces = await sut.assignFaces(ownerId, result({ tags: characters({ megumin: 0.9 }) }), refs());
      expect(faces).toEqual([
        { personGroupId: 'p-megumin', source: 'whole', box: { x1: 0, y1: 0, x2: 1000, y2: 800 } },
      ]);
    });

    it('lets a clear region winner decide on a multi-character image, over the references', async () => {
      // references would swap them; the regions clearly say otherwise
      const faces = await sut.assignFaces(
        ownerId,
        result({
          tags: characters({ megumin: 0.9, yunyun: 0.8 }),
          heads: [
            head(0, [0, 0, 100, 100], { megumin: 0.95, yunyun: 0.1 }),
            head(3, [200, 0, 300, 100], { yunyun: 0.9 }),
          ],
        }),
        refs([
          ['p-megumin', [axis(3), axis(3, 0.1)]],
          ['p-yunyun', [axis(0), axis(0, 0.1)]],
        ]),
      );
      expect(faces).toEqual([
        expect.objectContaining({ personGroupId: 'p-megumin', source: 'pixai', confirmed: true }),
        expect.objectContaining({ personGroupId: 'p-yunyun', source: 'pixai', confirmed: true }),
      ]);
    });

    it('pairs two heads with two characters by their references when the regions are unclear', async () => {
      const faces = await sut.assignFaces(
        ownerId,
        result({
          tags: characters({ megumin: 0.9, yunyun: 0.8 }),
          heads: [head(3, [0, 0, 100, 100]), head(0, [200, 200, 300, 300])],
        }),
        refs([
          ['p-megumin', [axis(0), axis(0, 0.1)]],
          ['p-yunyun', [axis(3), axis(3, 0.1)]],
        ]),
      );
      expect(faces).toEqual([
        expect.objectContaining({ personGroupId: 'p-yunyun', box: { x1: 0, y1: 0, x2: 100, y2: 100 } }),
        expect.objectContaining({ personGroupId: 'p-megumin', box: { x1: 200, y1: 200, x2: 300, y2: 300 } }),
      ]);
    });

    it('adds a head without a pixai character only to a group pixai does not know', async () => {
      const faces = await sut.assignFaces(
        ownerId,
        result({ heads: [head(0), head(5, [300, 300, 400, 400])] }),
        refs(
          [['p-megumin', [axis(5), axis(5, 0.01), axis(5, 0.02)]]],
          [['p-hsin', [axis(0), axis(0, 0.01), axis(0, 0.02)]]],
        ),
      );
      // the second head is as close to Megumin, but pixai characters never get fallback faces
      expect(faces.map(({ personGroupId, source }) => [personGroupId, source])).toEqual([
        ['p-hsin', 'ccip'],
        [null, 'none'],
      ]);
    });

    it('needs a clear gap, enough references and a big enough head for the fallback', async () => {
      const close = refs(
        [['p-megumin', [axis(0, 0.03), axis(0, 0.04), axis(0, 0.05)]]],
        [['p-hsin', [axis(0), axis(0, 0.01), axis(0, 0.02)]]],
      );
      const ambiguous = await sut.assignFaces(ownerId, result({ heads: [head(0)] }), close);
      const tooFew = await sut.assignFaces(ownerId, result({ heads: [head(0)] }), refs([], [['p-hsin', [axis(0)]]]));
      const tiny = await sut.assignFaces(
        ownerId,
        result({ heads: [head(0, [0, 0, 40, 40])] }),
        refs([], [['p-hsin', [axis(0), axis(0, 0.01), axis(0, 0.02)]]]),
      );
      expect([ambiguous[0].personGroupId, tooFew[0].personGroupId, tiny[0].personGroupId]).toEqual([null, null, null]);
    });

    it('does not put a character on a head that only its region shows (the man above Neru)', async () => {
      const man = { ...head(0, [864, 682, 960, 805], { megumin: 0.997 }), head: {} };
      const faces = await sut.assignFaces(
        ownerId,
        result({ tags: characters({ megumin: 0.99 }), heads: [man] }),
        refs(),
      );
      expect(faces.map(({ personGroupId, source }) => [personGroupId, source])).toEqual([
        ['p-megumin', 'whole'],
        [null, 'none'],
      ]);
    });

    it('confirms a region winner that the head alone shows too', async () => {
      const real = { ...head(0, [266, 553, 470, 752], { megumin: 0.98 }), head: { megumin: 0.49 } };
      const faces = await sut.assignFaces(
        ownerId,
        result({ tags: characters({ megumin: 0.99 }), heads: [real] }),
        refs(),
      );
      expect(faces).toEqual([
        expect.objectContaining({ personGroupId: 'p-megumin', source: 'pixai', confirmed: true }),
      ]);
    });

    it('keeps one head of a head the detector found twice', async () => {
      expect(
        distinctHeads([
          { box: [420, 0, 1116, 607], score: 0.8 },
          { box: [395, 0, 1430, 611], score: 0.9 },
          { box: [1500, 0, 1600, 100], score: 0.7 },
        ]),
      ).toEqual([1, 2]);
      const faces = await sut.assignFaces(
        ownerId,
        result({
          tags: characters({ megumin: 0.9 }),
          heads: [head(0, [420, 0, 1116, 607], { megumin: 0.99 }), head(0, [395, 0, 1430, 611], { megumin: 0.99 })],
        }),
        refs([], [['p-hsin', [axis(0), axis(0, 0.01), axis(0, 0.02)]]]),
      );
      expect(faces.map(({ personGroupId, source }) => [personGroupId, source])).toEqual([['p-megumin', 'pixai']]);
    });

    it('never puts a head into a group when its region clearly shows a pixai character', async () => {
      const faces = await sut.assignFaces(
        ownerId,
        result({ heads: [head(0, undefined, { 'keqing_(genshin_impact)': 0.95 })] }),
        refs([], [['p-group', [axis(0), axis(0, 0.01), axis(0, 0.02)]]]),
      );
      expect(faces.map(({ personGroupId, source }) => [personGroupId, source])).toEqual([[null, 'none']]);
    });

    it('creates a person for a character seen for the first time', async () => {
      const faces = await sut.assignFaces(
        ownerId,
        result({ tags: characters({ 'hiyuki_(wuthering_waves)': 0.95 }) }),
        refs(),
      );
      expect(mocks.person.create).toHaveBeenCalledWith({
        ownerId,
        personGroupId: 'p-new-1',
        name: 'hiyuki (wuthering waves)',
        isHidden: true,
      });
      expect(faces[0].personGroupId).toBe('p-new-1');
    });
  });

  describe('processAsset', () => {
    const candidate = { id: 'asset-1', ownerId, previewPath: '/data/thumbs/preview.webp' };

    beforeEach(() => {
      mocks.storage.readFile.mockResolvedValue(Buffer.from('preview'));
      let tagIds = 0;
      mocks.tag.upsertValue.mockImplementation(({ value }) => Promise.resolve({ id: `t-${++tagIds}`, value } as never));
      mocks.tag.replaceAssetTags.mockResolvedValue([] as never);
      mocks.asset.getForUpdateTags.mockResolvedValue({ tags: [{ value: '1girl' }] } as never);
      mocks.person.getFacePersons.mockResolvedValue([]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          Response.json(
            result({
              tags: {
                general: { '1girl': 0.99 },
                character: { megumin: 0.95 },
                copyright: { 'kono_subarashii_sekai_ni_shukufuku_wo!': 0.9 },
                rating: {},
              },
              heads: [{ box: [100, 50, 300, 250], score: 0.9, ccip: axis(0) }],
            }),
          ),
        ),
      );
    });

    it('replaces all tags and the old whole-image faces of an image tagged by the old worker', async () => {
      mocks.asset.getMetadataByKey.mockResolvedValue(undefined as never);
      mocks.person.getFaces.mockResolvedValue([
        {
          id: 'legacy',
          personGroupId: 'p-megumin',
          sourceType: SourceType.Manual,
          imageWidth: 2000,
          imageHeight: 1600,
          boundingBoxX1: 1,
          boundingBoxY1: 1,
          boundingBoxX2: 2000,
          boundingBoxY2: 1600,
        },
        {
          id: 'human',
          personGroupId: 'p-someone',
          sourceType: SourceType.MachineLearning,
          imageWidth: 2000,
          imageHeight: 1600,
          boundingBoxX1: 10,
          boundingBoxY1: 10,
          boundingBoxX2: 90,
          boundingBoxY2: 90,
        },
      ] as never);

      await sut.processAsset(candidate);

      expect(mocks.tag.getAssetTagIds).not.toHaveBeenCalled();
      expect(mocks.tag.replaceAssetTags).toHaveBeenCalledWith('asset-1', ['t-1', 't-2', 't-3']);
      expect(mocks.tag.upsertValue).toHaveBeenCalledWith(
        expect.objectContaining({ value: '::series:kono_subarashii_sekai_ni_shukufuku_wo!' }),
      );
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({ exif: expect.objectContaining({ assetId: 'asset-1', description: '1girl' }) }),
      );
      expect(mocks.person.deleteAssetFace).toHaveBeenCalledExactlyOnceWith('legacy');
      expect(mocks.person.createAssetFace).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'asset-1',
          personGroupId: 'p-megumin',
          boundingBoxX1: 100,
          boundingBoxY2: 250,
          imageWidth: 1000,
          sourceType: SourceType.Manual,
        }),
      );
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-1', [
        {
          key: DANBOORU_MARKER_KEY,
          value: expect.objectContaining({
            model: 'pixai-tagger-v1.0',
            tagIds: ['t-1', 't-2', 't-3'],
            faces: [expect.objectContaining({ person: 'p-megumin', source: 'pixai', box: [100, 50, 300, 250] })],
            removed: [],
          }),
        },
      ]);
    });

    it('keeps tags added by hand when re-tagging an image it tagged before', async () => {
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: { model: 'old', at: '', tagIds: ['t-old'], faceIds: ['f-old'] },
      } as never);
      mocks.tag.getAssetTagIds.mockResolvedValue(['t-old', 't-mine']);
      mocks.person.getFaces.mockResolvedValue([]);

      await sut.processAsset(candidate);

      expect(mocks.tag.replaceAssetTags).toHaveBeenCalledWith('asset-1', ['t-mine', 't-1', 't-2', 't-3']);
    });

    it('keeps a face the user reassigned and does not create a second face on that head', async () => {
      const box = [100, 50, 300, 250];
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: {
          model: 'old',
          at: '',
          tagIds: [],
          faceIds: ['f-1'],
          faces: [{ id: 'f-1', person: 'p-megumin', source: 'pixai', box }],
        },
      } as never);
      mocks.tag.getAssetTagIds.mockResolvedValue([]);
      mocks.person.getFaces.mockResolvedValue([
        {
          id: 'f-1',
          personGroupId: 'p-yunyun',
          sourceType: SourceType.Manual,
          imageWidth: 1000,
          imageHeight: 800,
          boundingBoxX1: 100,
          boundingBoxY1: 50,
          boundingBoxX2: 300,
          boundingBoxY2: 250,
        },
      ] as never);

      await sut.processAsset(candidate);

      expect(mocks.person.deleteAssetFace).not.toHaveBeenCalled();
      expect(mocks.person.createAssetFace).not.toHaveBeenCalled();
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-1', [
        {
          key: DANBOORU_MARKER_KEY,
          value: expect.objectContaining({ faces: [{ id: 'f-1', person: 'p-yunyun', source: 'manual', box }] }),
        },
      ]);
    });

    it('re-runs only the faces, reusing the stored heads, for a faces-only marker', async () => {
      await loadIndex(sut, { stored: { assetId: 'asset-1', faces: { 'old-head': axis(0) } } });
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: { model: 'recheck-faces', at: '', tagIds: ['t-old'], faceIds: ['old-head'] },
      } as never);
      mocks.person.getFaces.mockResolvedValue([
        {
          id: 'old-head',
          personGroupId: 'p-tifa',
          sourceType: SourceType.Manual,
          imageWidth: 1000,
          imageHeight: 800,
          boundingBoxX1: 10,
          boundingBoxY1: 20,
          boundingBoxX2: 110,
          boundingBoxY2: 120,
        },
      ] as never);
      const fetchMock = vi.mocked(fetch);

      await sut.processAsset(candidate);

      const form = fetchMock.mock.calls.at(-1)![1]!.body as FormData;
      expect(form.get('heads')).toBe('0');
      expect(mocks.tag.replaceAssetTags).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.person.deleteAssetFace).toHaveBeenCalledWith('old-head');
      expect(mocks.person.createAssetFace).toHaveBeenCalledWith(
        expect.objectContaining({ personGroupId: 'p-megumin', boundingBoxX1: 10, boundingBoxY2: 120 }),
      );
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-1', [
        {
          key: DANBOORU_MARKER_KEY,
          value: expect.objectContaining({ model: 'pixai-tagger-v1.0', tagIds: ['t-old'] }),
        },
      ]);
    });

    // custom: phone camera photos get tags, never Danbooru faces
    it('tags a camera photo without creating faces and removes the faces it made before', async () => {
      const box = [100, 50, 300, 250];
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: {
          model: 'old',
          at: '',
          tagIds: [],
          faceIds: ['f-1'],
          faces: [{ id: 'f-1', person: 'p-yunyun', source: 'pixai', box }],
        },
      } as never);
      mocks.tag.getAssetTagIds.mockResolvedValue([]);
      mocks.person.getFaces.mockResolvedValue([
        {
          id: 'f-1',
          personGroupId: 'p-megumin',
          sourceType: SourceType.Manual,
          imageWidth: 1000,
          imageHeight: 800,
          boundingBoxX1: 100,
          boundingBoxY1: 50,
          boundingBoxX2: 300,
          boundingBoxY2: 250,
        },
      ] as never);

      await sut.processAsset({ ...candidate, camera: true });

      expect(mocks.tag.replaceAssetTags).toHaveBeenCalledWith('asset-1', ['t-1', 't-2', 't-3']);
      expect(mocks.person.deleteAssetFace).toHaveBeenCalledExactlyOnceWith('f-1');
      expect(mocks.person.createAssetFace).not.toHaveBeenCalled();
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-1', [
        { key: DANBOORU_MARKER_KEY, value: expect.objectContaining({ faces: [], faceIds: [] }) },
      ]);
    });

    it('does not recreate a face the user deleted', async () => {
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: {
          model: 'old',
          at: '',
          tagIds: [],
          faceIds: ['f-1'],
          faces: [{ id: 'f-1', person: 'p-megumin', source: 'pixai', box: [100, 50, 300, 250] }],
        },
      } as never);
      mocks.tag.getAssetTagIds.mockResolvedValue([]);
      mocks.person.getFaces.mockResolvedValue([]);

      await sut.processAsset(candidate);

      expect(mocks.person.createAssetFace).not.toHaveBeenCalled();
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-1', [
        {
          key: DANBOORU_MARKER_KEY,
          value: expect.objectContaining({ faces: [], removed: [[100, 50, 300, 250]] }),
        },
      ]);
    });
  });

  describe('maintenance', () => {
    // custom: a camera photo that joined the camera album after tagging
    it('removes the Danbooru faces of camera photos', async () => {
      mocks.asset.getDanbooruCameraAssets.mockResolvedValue([{ id: 'asset-1', ownerId }]);
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: {
          model: 'pixai-tagger-v1.0',
          at: '',
          tagIds: ['t-1'],
          faceIds: ['f-1'],
          faces: [{ id: 'f-1', person: 'p-megumin', source: 'pixai', box: [100, 50, 300, 250] }],
        },
      } as never);
      mocks.person.getFaces.mockResolvedValue([
        {
          id: 'f-1',
          personGroupId: 'p-megumin',
          sourceType: SourceType.Manual,
          imageWidth: 1000,
          imageHeight: 800,
          boundingBoxX1: 100,
          boundingBoxY1: 50,
          boundingBoxX2: 300,
          boundingBoxY2: 250,
        },
      ] as never);
      mocks.person.getFacePersons.mockResolvedValue([]);

      await sut.maintenance();

      expect(mocks.asset.getDanbooruCameraAssets).toHaveBeenCalledWith('Camera');
      expect(mocks.person.deleteAssetFace).toHaveBeenCalledExactlyOnceWith('f-1');
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('asset-1', [
        {
          key: DANBOORU_MARKER_KEY,
          value: expect.objectContaining({ model: 'pixai-tagger-v1.0', tagIds: ['t-1'], faces: [], faceIds: [] }),
        },
      ]);
    });

    it('pairs unassigned heads with the characters pixai named on the image', async () => {
      await loadIndex(sut, {
        refs: {
          assetId: 'refs',
          faces: { r1: axis(0), r2: axis(0, 0.05), r3: axis(3), r4: axis(3, 0.05) },
          records: {
            r1: { person: 'p-megumin', source: 'pixai', confirmed: true },
            r2: { person: 'p-megumin', source: 'pixai', confirmed: true },
            r3: { person: 'p-yunyun', source: 'pixai', confirmed: true },
            r4: { person: 'p-yunyun', source: 'pixai', confirmed: true },
          },
        },
        multi: { assetId: 'multi', faces: { h1: axis(3, 0.02), h2: axis(0, 0.02) } },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'r1', personGroupId: 'p-megumin', ownerId, name: 'p-megumin' },
        { id: 'r2', personGroupId: 'p-megumin', ownerId, name: 'p-megumin' },
        { id: 'r3', personGroupId: 'p-yunyun', ownerId, name: 'p-yunyun' },
        { id: 'r4', personGroupId: 'p-yunyun', ownerId, name: 'p-yunyun' },
        { id: 'h1', personGroupId: null, ownerId, name: null },
        { id: 'h2', personGroupId: null, ownerId, name: null },
      ]);
      mocks.person.getFaces.mockResolvedValue([
        wholeImageFace('w-megumin', 'p-megumin'),
        wholeImageFace('w-yunyun', 'p-yunyun'),
      ] as never);

      await sut.maintenance();

      expect(mocks.person.reassignFace).toHaveBeenCalledWith('h1', 'p-yunyun');
      expect(mocks.person.reassignFace).toHaveBeenCalledWith('h2', 'p-megumin');
      expect(mocks.person.deleteAssetFace).toHaveBeenCalledWith('w-megumin');
      expect(mocks.person.deleteAssetFace).toHaveBeenCalledWith('w-yunyun');
    });

    it('adds a lone head to a group later and clusters the unknown ones into an unnamed person', async () => {
      const unknown = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`u${i}`, axis(6, i * 0.01)]));
      await loadIndex(sut, {
        refs: {
          assetId: 'refs',
          faces: { r1: axis(0), r2: axis(0, 0.01), r3: axis(0, 0.02) },
          records: {
            r1: { person: 'p-hsin', source: 'cluster' },
            r2: { person: 'p-hsin', source: 'cluster' },
            r3: { person: 'p-hsin', source: 'cluster' },
          },
        },
        lone: {
          assetId: 'lone',
          faces: { h1: axis(0, 0.015) },
          records: { h1: { person: null, source: 'none', size: 100 } },
        },
        unknown: { assetId: 'unknown', faces: unknown },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'r1', personGroupId: 'p-hsin', ownerId, name: 'Hsin' },
        { id: 'r2', personGroupId: 'p-hsin', ownerId, name: 'Hsin' },
        { id: 'r3', personGroupId: 'p-hsin', ownerId, name: 'Hsin' },
        { id: 'h1', personGroupId: null, ownerId, name: null },
        ...Object.keys(unknown).map((id) => ({ id, personGroupId: null, ownerId, name: null })),
      ]);
      mocks.person.getFaces.mockResolvedValue([]);
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ labels: [0, 0, 0, 0, 0] }));
      vi.stubGlobal('fetch', fetchMock);

      await sut.maintenance();

      expect(mocks.person.reassignFace).toHaveBeenCalledWith('h1', 'p-hsin');
      expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/v2\/cluster$/), expect.anything());
      expect(mocks.person.create).toHaveBeenCalledWith({ ownerId, personGroupId: 'p-new-1', name: '' });
      for (const id of Object.keys(unknown)) {
        expect(mocks.person.reassignFace).toHaveBeenCalledWith(id, 'p-new-1');
      }
    });
  });

  describe('pairing', () => {
    it('moves a head out of an unnamed cluster when pixai named its character on the image', async () => {
      await loadIndex(sut, {
        refs: {
          assetId: 'refs',
          faces: { r1: axis(0), r2: axis(0, 0.05) },
          records: {
            r1: { person: 'p-megumin', source: 'pixai', confirmed: true },
            r2: { person: 'p-megumin', source: 'pixai', confirmed: true },
          },
        },
        multi: {
          assetId: 'multi',
          faces: { h1: axis(0, 0.02) },
          records: { h1: { person: 'p-cluster', source: 'cluster' } },
        },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'r1', personGroupId: 'p-megumin', ownerId, name: 'megumin' },
        { id: 'r2', personGroupId: 'p-megumin', ownerId, name: 'megumin' },
        { id: 'h1', personGroupId: 'p-cluster', ownerId, name: '' },
      ]);
      mocks.person.getFaces.mockImplementation((assetId) =>
        Promise.resolve((assetId === 'multi' ? [wholeImageFace('w-megumin', 'p-megumin')] : []) as never),
      );

      await sut.maintenance();

      expect(mocks.person.reassignFace).toHaveBeenCalledExactlyOnceWith('h1', 'p-megumin');
      expect(mocks.person.deleteAssetFace).toHaveBeenCalledWith('w-megumin');
    });
  });

  describe('region pairing in maintenance', () => {
    it('puts a whole-image character on the free head whose region shows it, without references', async () => {
      await loadIndex(sut, {
        multi: {
          assetId: 'multi',
          faces: { h1: axis(0), h2: axis(3) },
          records: {
            h1: { person: null, source: 'none', size: 120, regions: { yunyun: 0.9 } } as never,
            h2: { person: null, source: 'none', size: 120, regions: { megumin: 0.92, yunyun: 0.05 } } as never,
          },
        },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'h1', personGroupId: null, ownerId, name: null },
        { id: 'h2', personGroupId: null, ownerId, name: null },
      ]);
      mocks.person.getFaces.mockResolvedValue([
        { ...wholeImageFace('w-megumin', 'p-megumin'), person: { name: 'megumin' } },
        { ...wholeImageFace('w-yunyun', 'p-yunyun'), person: { name: 'yunyun' } },
      ] as never);
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: {
          model: 'pixai-tagger-v1.0',
          at: '',
          tagIds: [],
          faceIds: ['h1', 'h2', 'w-megumin', 'w-yunyun'],
          faces: [
            { id: 'h1', person: null, source: 'none', box: [0, 0, 120, 120] },
            { id: 'h2', person: null, source: 'none', box: [200, 0, 320, 120] },
            { id: 'w-megumin', person: 'p-megumin', source: 'whole', box: [0, 0, 1000, 800] },
            { id: 'w-yunyun', person: 'p-yunyun', source: 'whole', box: [0, 0, 1000, 800] },
          ],
        },
      } as never);

      await sut.maintenance();

      expect(mocks.person.reassignFace).toHaveBeenCalledWith('h1', 'p-yunyun');
      expect(mocks.person.reassignFace).toHaveBeenCalledWith('h2', 'p-megumin');
      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('multi', [
        expect.objectContaining({
          value: expect.objectContaining({
            faces: [
              { id: 'h1', person: 'p-yunyun', source: 'pixai', confirmed: true, box: [0, 0, 120, 120] },
              { id: 'h2', person: 'p-megumin', source: 'pixai', confirmed: true, box: [200, 0, 320, 120] },
            ],
          }),
        }),
      ]);
    });
  });

  describe('interrupted maintenance', () => {
    it('records the pairing even when the clustering fails', async () => {
      const unknown = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`u${i}`, axis(6, i * 0.01)]));
      await loadIndex(sut, {
        refs: {
          assetId: 'refs',
          faces: { r1: axis(0), r2: axis(0, 0.05) },
          records: {
            r1: { person: 'p-megumin', source: 'pixai', confirmed: true },
            r2: { person: 'p-megumin', source: 'pixai', confirmed: true },
          },
        },
        multi: { assetId: 'multi', faces: { h1: axis(0, 0.02) } },
        unknown: { assetId: 'unknown', faces: unknown },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'r1', personGroupId: 'p-megumin', ownerId, name: 'megumin' },
        { id: 'r2', personGroupId: 'p-megumin', ownerId, name: 'megumin' },
        { id: 'h1', personGroupId: null, ownerId, name: null },
        ...Object.keys(unknown).map((id) => ({ id, personGroupId: null, ownerId, name: null })),
      ]);
      mocks.person.getFaces.mockImplementation((assetId) =>
        Promise.resolve((assetId === 'multi' ? [wholeImageFace('w-megumin', 'p-megumin')] : []) as never),
      );
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: {
          model: 'pixai-tagger-v1.0',
          at: '',
          tagIds: [],
          faceIds: ['h1', 'w-megumin'],
          faces: [
            { id: 'h1', person: null, source: 'none', box: [1, 1, 9, 9] },
            { id: 'w-megumin', person: 'p-megumin', source: 'whole', box: [0, 0, 1000, 800] },
          ],
        },
      } as never);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      await expect(sut.maintenance()).rejects.toThrow('fetch failed');

      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('multi', [
        expect.objectContaining({
          value: expect.objectContaining({
            faces: [{ id: 'h1', person: 'p-megumin', source: 'pixai', box: [1, 1, 9, 9] }],
          }),
        }),
      ]);
    });

    it('records pairings an interrupted pass did not write', async () => {
      await loadIndex(sut, {
        multi: { assetId: 'multi', faces: { h1: axis(0) }, records: { h1: { person: null, source: 'none' } as never } },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'h1', personGroupId: 'p-megumin', ownerId, name: 'megumin' },
      ]);
      mocks.person.getFaces.mockResolvedValue([]);
      mocks.asset.getMetadataByKey.mockResolvedValue({
        value: {
          model: 'pixai-tagger-v1.0',
          at: '',
          tagIds: [],
          faceIds: ['h1', 'w-gone'],
          faces: [
            { id: 'h1', person: null, source: 'none', box: [1, 1, 9, 9] },
            { id: 'w-gone', person: 'p-megumin', source: 'whole', box: [0, 0, 1000, 800] },
          ],
        },
      } as never);

      await sut.maintenance();

      expect(mocks.asset.upsertMetadata).toHaveBeenCalledWith('multi', [
        expect.objectContaining({
          value: expect.objectContaining({
            faceIds: ['h1'],
            faces: [{ id: 'h1', person: 'p-megumin', source: 'pixai', box: [1, 1, 9, 9] }],
          }),
        }),
      ]);
    });
  });

  describe('references', () => {
    it('never learns from CCIP fallback matches', async () => {
      await loadIndex(sut, {
        refs: {
          assetId: 'refs',
          faces: { c1: axis(0), c2: axis(0, 0.05) },
          records: { c1: { person: 'p-megumin', source: 'ccip' }, c2: { person: 'p-megumin', source: 'ccip' } },
        },
        lone: { assetId: 'lone', faces: { h1: axis(0, 0.02) } },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'c1', personGroupId: 'p-megumin', ownerId, name: 'megumin' },
        { id: 'c2', personGroupId: 'p-megumin', ownerId, name: 'megumin' },
        { id: 'h1', personGroupId: null, ownerId, name: null },
      ]);
      mocks.person.getFaces.mockResolvedValue([]);

      await sut.maintenance();

      expect(mocks.person.reassignFace).not.toHaveBeenCalled();
    });

    it('learns from faces the user moved to a person made by hand', async () => {
      await loadIndex(sut, {
        refs: {
          assetId: 'refs',
          faces: { c1: axis(0), c2: axis(0, 0.01), c3: axis(0, 0.02) },
          records: {
            c1: { person: 'p-tifa', source: 'ccip' },
            c2: { person: 'p-tifa', source: 'ccip' },
            c3: { person: 'p-tifa', source: 'ccip' },
          },
        },
        lone: {
          assetId: 'lone',
          faces: { h1: axis(0, 0.015) },
          records: { h1: { person: null, source: 'none', size: 100 } },
        },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'c1', personGroupId: 'p-mine', ownerId, name: 'mine' },
        { id: 'c2', personGroupId: 'p-mine', ownerId, name: 'mine' },
        { id: 'c3', personGroupId: 'p-mine', ownerId, name: 'mine' },
        { id: 'h1', personGroupId: null, ownerId, name: null },
      ]);
      mocks.person.getFaces.mockResolvedValue([]);

      await sut.maintenance();

      expect(mocks.person.reassignFace).toHaveBeenCalledWith('h1', 'p-mine');
    });

    it('neither matches nor clusters heads whose region clearly shows a pixai character', async () => {
      const keqing = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, axis(6, i * 0.01)]));
      await loadIndex(sut, {
        refs: {
          assetId: 'refs',
          faces: { r1: axis(6), r2: axis(6, 0.01), r3: axis(6, 0.02) },
          records: {
            r1: { person: 'p-group', source: 'cluster' },
            r2: { person: 'p-group', source: 'cluster' },
            r3: { person: 'p-group', source: 'cluster' },
          },
        },
        keqing: {
          assetId: 'keqing',
          faces: keqing,
          records: Object.fromEntries(
            Object.keys(keqing).map((id) => [
              id,
              { person: null, source: 'none', size: 120, regions: { keqing: 0.9 } },
            ]),
          ) as never,
        },
      });
      mocks.person.getFacePersons.mockResolvedValue([
        { id: 'r1', personGroupId: 'p-group', ownerId, name: '' },
        { id: 'r2', personGroupId: 'p-group', ownerId, name: '' },
        { id: 'r3', personGroupId: 'p-group', ownerId, name: '' },
        ...Object.keys(keqing).map((id) => ({ id, personGroupId: null, ownerId, name: null })),
      ]);
      mocks.person.getFaces.mockResolvedValue([]);
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ labels: [0, 0, 0, 0, 0] }));
      vi.stubGlobal('fetch', fetchMock);

      await sut.maintenance();

      expect(mocks.person.reassignFace).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('deletes unnamed people without faces', async () => {
      mocks.person.getPeopleAssetCounts.mockResolvedValue([
        { personGroupId: 'p-empty-cluster', ownerId, isHidden: false, assets: 0, name: '' },
        { personGroupId: 'p-empty-named', ownerId, isHidden: false, assets: 0, name: 'megumin' },
      ]);

      await sut.maintenance();

      expect(mocks.person.delete).toHaveBeenCalledExactlyOnceWith(['p-empty-cluster'], ownerId);
    });
  });

  describe('auto-hide', () => {
    it('hides every visible person with a single image on the first start', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
      mocks.person.getPeopleAssetCounts.mockResolvedValue([
        { personGroupId: 'p-one', ownerId, isHidden: false, assets: 1, name: 'p-one' },
        { personGroupId: 'p-two', ownerId, isHidden: false, assets: 2, name: 'p-two' },
        { personGroupId: 'p-hidden-by-user', ownerId, isHidden: true, assets: 1, name: 'p-hidden-by-user' },
      ]);

      await sut.loadAutoHidden();

      expect(mocks.person.update).toHaveBeenCalledExactlyOnceWith({ ownerId, personGroupId: 'p-one', isHidden: true });
      expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
        expect.stringMatching(/danbooru-autohidden\.json$/),
        JSON.stringify({ ids: ['p-one'] }),
      );
    });

    it('shows auto-hidden people again once they have two images', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ids: ['p-one', 'p-two', 'p-gone'] }) as never);
      await sut.loadAutoHidden();
      mocks.person.getPeopleAssetCounts.mockResolvedValue([
        { personGroupId: 'p-one', ownerId, isHidden: true, assets: 1, name: 'p-one' },
        { personGroupId: 'p-two', ownerId, isHidden: true, assets: 2, name: 'p-two' },
      ]);

      await sut.revealAutoHidden();

      expect(mocks.person.getPeopleAssetCounts).toHaveBeenCalledWith(['p-one', 'p-two', 'p-gone']);
      expect(mocks.person.update).toHaveBeenCalledExactlyOnceWith({ ownerId, personGroupId: 'p-two', isHidden: false });
      expect(vi.mocked(writeFile)).toHaveBeenLastCalledWith(expect.anything(), JSON.stringify({ ids: ['p-one'] }));
    });
  });
});
