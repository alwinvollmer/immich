// custom: upscaling via the anime-upscaler job API
import { BadRequestException } from '@nestjs/common';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { UpscaleJobState } from 'src/dtos/upscale.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { UpscaleService } from 'src/services/upscale.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('original')),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

const makeAsset = (overrides: Record<string, unknown> = {}) =>
  ({
    id: newUuid(),
    ownerId: authStub.admin.user.id,
    type: AssetType.Image,
    originalPath: '/data/upload/original.jpg',
    originalFileName: 'original.jpg',
    fileCreatedAt: new Date('2026-01-01T00:00:00Z'),
    fileModifiedAt: new Date('2026-01-01T00:00:00Z'),
    isFavorite: true,
    visibility: AssetVisibility.Timeline,
    exifInfo: { description: 'desc', latitude: 1, longitude: 2, dateTimeOriginal: null, timeZone: null, rating: null },
    tags: [{ id: 'tag-1' }],
    ...overrides,
  }) as never;

const json = (body: unknown) => Response.json(body, { status: 200 });

describe(UpscaleService.name, () => {
  let sut: UpscaleService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(UpscaleService));
    mocks.access.asset.checkOwnerAccess.mockImplementation((_, ids) => Promise.resolve(new Set(ids)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects videos', async () => {
    const asset = makeAsset({ type: AssetType.Video });
    mocks.asset.getById.mockResolvedValue(asset);
    await expect(
      sut.create(authStub.admin, { assetId: (asset as { id: string }).id, scale: 2 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects formats the upscaler cannot read', async () => {
    const asset = makeAsset({ originalPath: '/data/upload/original.heic' });
    mocks.asset.getById.mockResolvedValue(asset);
    await expect(
      sut.create(authStub.admin, { assetId: (asset as { id: string }).id, scale: 2 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('upscales, saves the result, copies tags and stacks it on top of the original', async () => {
    const asset = makeAsset();
    const { id: assetId } = asset as { id: string };
    const newAssetId = newUuid();
    mocks.asset.getById.mockResolvedValue(asset);
    mocks.stack.create.mockResolvedValue({ id: 'stack-1' } as never);
    vi.spyOn(AssetMediaService.prototype, 'uploadAsset').mockResolvedValue({
      id: newAssetId,
      status: AssetMediaStatus.CREATED,
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ id: 'u1' }))
      .mockResolvedValueOnce(json({ state: 'running', tilesDone: 1, tilesTotal: 2, progress: 0.5, position: null }))
      .mockResolvedValueOnce(json({ state: 'done', tilesDone: 2, tilesTotal: 2, progress: 1, position: null }))
      .mockResolvedValueOnce(new Response(Buffer.from('upscaled'), { status: 200 }))
      .mockResolvedValueOnce(json({ state: 'deleted' }));
    vi.stubGlobal('fetch', fetchMock);

    const job = await sut.create(authStub.admin, { assetId, scale: 4 });
    expect(job).toMatchObject({ assetId, scale: 4, state: UpscaleJobState.Queued });

    await vi.waitFor(() =>
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith(
        'on_upscale_update',
        authStub.admin.user.id,
        expect.objectContaining({ id: job.id, state: UpscaleJobState.Done, newAssetId }),
      ),
    );

    expect(mocks.websocket.clientSend).toHaveBeenCalledWith(
      'on_upscale_update',
      authStub.admin.user.id,
      expect.objectContaining({ state: UpscaleJobState.Running, tilesDone: 1, tilesTotal: 2 }),
    );
    // the upscaler is plain HTTP: keep `eslint --fix` (unicorn/prefer-https) away from these
    /* eslint-disable unicorn/prefer-https */
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      'POST http://host.docker.internal:7085/jobs',
      'GET http://host.docker.internal:7085/jobs/u1',
      'GET http://host.docker.internal:7085/jobs/u1',
      'GET http://host.docker.internal:7085/jobs/u1/result',
      'DELETE http://host.docker.internal:7085/jobs/u1',
    ]);
    /* eslint-enable unicorn/prefer-https */
    expect(mocks.tag.upsertAssetIds).toHaveBeenCalledWith([{ tagId: 'tag-1', assetId: newAssetId }]);
    expect(mocks.asset.upsertExif).toHaveBeenCalled();
    expect(mocks.stack.create).toHaveBeenCalledWith({ ownerId: authStub.admin.user.id }, [newAssetId, assetId]);
    expect(mocks.event.emit).toHaveBeenCalledWith('StackCreate', {
      stackId: 'stack-1',
      userId: authStub.admin.user.id,
    });
    expect(sut.getJobs(authStub.admin)).toEqual([expect.objectContaining({ id: job.id, state: UpscaleJobState.Done })]);
  });

  it('reports an upscaler failure as an error state', async () => {
    const asset = makeAsset();
    mocks.asset.getById.mockResolvedValue(asset);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ id: 'u2' }))
        .mockResolvedValueOnce(
          json({ state: 'error', tilesDone: 0, tilesTotal: 0, progress: 0, position: null, error: 'boom' }),
        )
        .mockResolvedValue(json({})),
    );

    const job = await sut.create(authStub.admin, { assetId: (asset as { id: string }).id, scale: 2 });

    await vi.waitFor(() =>
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith(
        'on_upscale_update',
        authStub.admin.user.id,
        expect.objectContaining({ id: job.id, state: UpscaleJobState.Error, error: 'boom' }),
      ),
    );
    expect(mocks.stack.create).not.toHaveBeenCalled();
  });
});
