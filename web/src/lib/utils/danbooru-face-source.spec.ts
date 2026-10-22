// custom: face source labels (DanbooruService marker)
import { SourceType, type AssetFaceResponseDto } from '@immich/sdk';
import { faceSourceLabel, type FaceRecord } from '$lib/utils/danbooru-face-source';

const face = (id: string, sourceType = SourceType.Manual) => ({ id, sourceType }) as AssetFaceResponseDto;
const records = (...list: FaceRecord[]) => new Map(list.map((record) => [record.id, record]));

describe('faceSourceLabel', () => {
  it('names the recorded source', () => {
    expect(faceSourceLabel([face('f1')], records({ id: 'f1', person: 'p1', source: 'pixai' }), 'p1')).toBe('pixai');
    expect(faceSourceLabel([face('f1')], records({ id: 'f1', person: 'p1', source: 'ccip' }), 'p1')).toBe('CCIP match');
  });

  it('marks pixai faces whose head region confirmed the character', () => {
    expect(
      faceSourceLabel([face('f1')], records({ id: 'f1', person: 'p1', source: 'pixai', confirmed: true }), 'p1'),
    ).toBe('pixai ✓');
  });

  it('calls a face manual when its person was changed by hand or it was added by hand', () => {
    expect(faceSourceLabel([face('f1')], records({ id: 'f1', person: 'p1', source: 'pixai' }), 'p2')).toBe('manual');
    expect(faceSourceLabel([face('f9')], records({ id: 'f1', person: 'p1', source: 'pixai' }), 'p2')).toBe('manual');
  });

  it("marks Immich's own face recognition and stays silent without a marker", () => {
    expect(faceSourceLabel([face('f1', SourceType.MachineLearning)], new Map(), 'p1')).toBe('Immich ML');
    expect(faceSourceLabel([face('f1')], new Map(), 'p1')).toBeUndefined();
  });
});
