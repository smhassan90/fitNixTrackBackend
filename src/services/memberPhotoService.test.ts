import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  MEMBER_PHOTO_TARGET_MAX_BYTES,
  compressMemberPhoto,
} from './memberPhotoService';

async function makeNoisyJpeg(width: number, height: number): Promise<Buffer> {
  // Pseudo-noise so JPEG does not collapse to a few KB like a solid fill.
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (i * 37 + (i % 251) * 13) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('compressMemberPhoto', () => {
  it('compresses a large JPEG under the storage budget while keeping dimensions usable', async () => {
    const input = await makeNoisyJpeg(1600, 1200);
    assert.ok(input.length > MEMBER_PHOTO_TARGET_MAX_BYTES);

    const result = await compressMemberPhoto(input);
    assert.equal(result.mimeType, 'image/jpeg');
    assert.ok(result.sizeBytes <= MEMBER_PHOTO_TARGET_MAX_BYTES);
    assert.ok(result.width > 0 && result.width <= 480);
    assert.ok(result.height > 0 && result.height <= 480);
  });
});
