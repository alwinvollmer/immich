import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { BaseService } from 'src/services/base.service.js';

/**
 * custom: stack album rule. Only a stack's cover (primary asset) is ever in albums.
 *
 * When a stack is created or its cover changes, the cover inherits every album of
 * the other members, and the members are removed from all albums. AlbumService
 * refuses to add non-cover members to albums (getNonPrimaryMemberIds), so neither
 * the web UI, the API, workflows nor the mobile app's folder-album sync can put
 * them back. Album thumbnails pointing to a removed member are recomputed.
 */
@Injectable()
export class StackAlbumService extends BaseService {
  @OnEvent({ name: 'StackCreate' })
  async onStackCreate({ stackId }: ArgOf<'StackCreate'>) {
    await this.applyStackAlbumRule(stackId);
  }

  @OnEvent({ name: 'StackUpdate' })
  async onStackUpdate({ stackId }: ArgOf<'StackUpdate'>) {
    await this.applyStackAlbumRule(stackId);
  }

  async applyStackAlbumRule(stackId: string) {
    const info = await this.stackRepository.getAlbumRuleInfo(stackId);
    if (!info || info.memberIds.length === 0) {
      return;
    }

    for (const memberId of info.memberIds) {
      await this.albumRepository.copyAlbums({ sourceAssetId: memberId, targetAssetId: info.primaryAssetId });
    }
    await this.albumRepository.removeAssetsFromAll(info.memberIds);
    await this.albumRepository.updateThumbnails();
  }
}
