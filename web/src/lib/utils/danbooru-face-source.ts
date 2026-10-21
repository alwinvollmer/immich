// custom: where a person on an image came from (DanbooruService records it in the `custom.danbooru` marker)
import { getAssetMetadataByKey, SourceType, type AssetFaceResponseDto } from '@immich/sdk';

export type FaceRecord = { id: string; person: string | null; source: string };

const labels: Record<string, string> = {
  pixai: 'pixai',
  whole: 'pixai · no head',
  ccip: 'CCIP match',
  cluster: 'cluster',
  manual: 'manual',
};

export const loadFaceRecords = async (assetId: string): Promise<Map<string, FaceRecord>> => {
  try {
    const { value } = await getAssetMetadataByKey({ id: assetId, key: 'custom.danbooru' });
    const faces = (value as { faces?: FaceRecord[] }).faces ?? [];
    return new Map(faces.map((record) => [record.id, record]));
  } catch {
    // no marker (not tagged yet, or tagged before face sources were recorded)
    return new Map();
  }
};

/** label for a person's faces on one image; undefined when nothing is known */
export const faceSourceLabel = (
  faces: AssetFaceResponseDto[],
  records: Map<string, FaceRecord>,
  personId: string,
): string | undefined => {
  const found = new Set<string>();
  for (const face of faces) {
    if (face.sourceType === SourceType.MachineLearning) {
      found.add('Immich ML');
      continue;
    }
    const record = records.get(face.id);
    if (!record) {
      if (records.size > 0) {
        found.add(labels.manual);
      }
      continue;
    }
    found.add(record.person === personId ? (labels[record.source] ?? record.source) : labels.manual);
  }
  return found.size > 0 ? [...found].join(', ') : undefined;
};
