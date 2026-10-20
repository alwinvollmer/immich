// custom: stack album rule
import { StackAlbumService } from 'src/services/stack-album.service.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(StackAlbumService.name, () => {
  let sut: StackAlbumService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StackAlbumService));
  });

  it('gives the cover the albums of the other members and removes the members from all albums', async () => {
    const [stackId, cover, member1, member2] = [newUuid(), newUuid(), newUuid(), newUuid()];
    mocks.stack.getAlbumRuleInfo.mockResolvedValue({ primaryAssetId: cover, memberIds: [member1, member2] });

    await sut.onStackCreate({ stackId, userId: newUuid() });

    expect(mocks.album.copyAlbums).toHaveBeenCalledWith({ sourceAssetId: member1, targetAssetId: cover });
    expect(mocks.album.copyAlbums).toHaveBeenCalledWith({ sourceAssetId: member2, targetAssetId: cover });
    expect(mocks.album.removeAssetsFromAll).toHaveBeenCalledWith([member1, member2]);
    expect(mocks.album.updateThumbnails).toHaveBeenCalled();
  });

  it('applies the rule when the cover changes', async () => {
    const [stackId, cover, member] = [newUuid(), newUuid(), newUuid()];
    mocks.stack.getAlbumRuleInfo.mockResolvedValue({ primaryAssetId: cover, memberIds: [member] });

    await sut.onStackUpdate({ stackId, userId: newUuid() });

    expect(mocks.album.removeAssetsFromAll).toHaveBeenCalledWith([member]);
  });

  it('does nothing for an unknown stack or one without other members', async () => {
    mocks.stack.getAlbumRuleInfo.mockResolvedValueOnce(undefined);
    await sut.onStackCreate({ stackId: newUuid(), userId: newUuid() });
    mocks.stack.getAlbumRuleInfo.mockResolvedValueOnce({ primaryAssetId: newUuid(), memberIds: [] });
    await sut.onStackCreate({ stackId: newUuid(), userId: newUuid() });

    expect(mocks.album.copyAlbums).not.toHaveBeenCalled();
    expect(mocks.album.removeAssetsFromAll).not.toHaveBeenCalled();
  });
});
