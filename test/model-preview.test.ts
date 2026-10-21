import { describe, expect, it } from 'vitest';
import { isPreviewable, previewTarget } from '../src/renderer/components/ModelPreview';

describe('model preview target', () => {
  it('previews models, blockstates and item definitions only', () => {
    expect(isPreviewable('src/main/resources/assets/demo/models/block/crate.json')).toBe(true);
    expect(isPreviewable('src/main/resources/assets/demo/blockstates/crate.json')).toBe(true);
    expect(isPreviewable('src/main/resources/assets/demo/items/gem.json')).toBe(true);
    expect(isPreviewable('src/main/resources/assets/demo/lang/en_us.json')).toBe(false);
    expect(isPreviewable('src/main/resources/data/demo/recipe/crate.json')).toBe(false);
  });

  it('picks the model to draw', () => {
    expect(previewTarget('src/main/resources/assets/demo/models/item/gem.json', '{}')).toBe('demo:item/gem');
    expect(previewTarget('src/main/resources/assets/demo/blockstates/crate.json', '{"variants":{"facing=north":[{"model":"demo:block/crate","y":90}],"facing=south":{"model":"demo:block/other"}}}')).toBe('demo:block/crate');
    expect(previewTarget('src/main/resources/assets/demo/blockstates/wall.json', '{"multipart":[{"when":{"up":"true"},"apply":{"model":"demo:block/post"}}]}')).toBe('demo:block/post');
    expect(previewTarget('src/main/resources/assets/demo/items/gem.json', '{"model":{"type":"minecraft:model","model":"demo:item/gem"}}')).toBe('demo:item/gem');
    expect(previewTarget('src/main/resources/assets/demo/blockstates/broken.json', '{ nope')).toBeNull();
  });
});
