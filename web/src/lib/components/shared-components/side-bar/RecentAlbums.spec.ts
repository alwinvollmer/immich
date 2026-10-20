import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RecentAlbums from '$lib/components/shared-components/side-bar/RecentAlbums.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

describe('RecentAlbums component', () => {
  it('sorts albums by most recently updated', async () => {
    const albums = [
      albumFactory.build({ updatedAt: '2024-01-01T00:00:00Z' }),
      albumFactory.build({ updatedAt: '2024-01-09T00:00:01Z' }),
      albumFactory.build({ updatedAt: '2024-01-10T00:00:00Z' }),
      albumFactory.build({ updatedAt: '2024-01-09T00:00:00Z' }),
      albumFactory.build({ updatedAt: '2024-01-05T00:00:00Z' }),
      albumFactory.build({ updatedAt: '2024-01-02T00:00:00Z' }),
    ];

    sdkMock.getAllAlbums.mockResolvedValueOnce([...albums]);
    render(RecentAlbums);

    expect(sdkMock.getAllAlbums).toHaveBeenCalledOnce();

    // wtf
    await tick();
    await tick();

    const links = screen.getAllByRole('link');
    // custom: the fork shows 5 recent albums (upstream: 3); the oldest one is cut off
    expect(links).toHaveLength(5);
    expect(links[0]).toHaveAttribute('href', `/albums/${albums[2].id}`);
    expect(links[1]).toHaveAttribute('href', `/albums/${albums[1].id}`);
    expect(links[2]).toHaveAttribute('href', `/albums/${albums[3].id}`);
    expect(links[3]).toHaveAttribute('href', `/albums/${albums[4].id}`);
    expect(links[4]).toHaveAttribute('href', `/albums/${albums[5].id}`);
  });
});
