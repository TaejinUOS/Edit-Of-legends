import sharp from 'sharp';

// Separate connected glyphs before upscaling. LoL's italic slash can otherwise
// be read together with the following digit (e.g. "7/2/7" -> "1/2/17").
export async function glyphImages(input, rawInfo) {
  const { data, info } = await (
    rawInfo
      ? sharp(input, { raw: { width: rawInfo.width, height: rawInfo.height, channels: 1 } })
      : sharp(input)
  )
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width,
    h = info.height,
    seen = new Uint8Array(w * h),
    components = [];
  for (let i = 0; i < data.length; i++) {
    if (seen[i] || data[i] < 95) continue;
    const stack = [i];
    seen[i] = 1;
    let left = w,
      top = h,
      right = 0,
      bottom = 0;
    const pixels = [];
    while (stack.length) {
      const p = stack.pop(),
        x = p % w,
        y = Math.floor(p / w);
      pixels.push(p);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const n = yy * w + xx;
          if (!seen[n] && data[n] >= 95) {
            seen[n] = 1;
            stack.push(n);
          }
        }
    }
    if (pixels.length >= Math.max(5, h * 0.2) && bottom - top >= h * 0.28)
      components.push({ left, right, top, bottom, pixels });
  }
  components.sort((a, b) => a.left - b.left);
  if (components.length < 5 || components.length > 8) return null;
  const images = [];
  for (const c of components) {
    const cw = c.right - c.left + 1,
      ch = c.bottom - c.top + 1;
    const buf = Buffer.alloc((cw + 12) * (ch + 12), 255);
    for (const p of c.pixels)
      buf[(Math.floor(p / w) - c.top + 6) * (cw + 12) + (p % w) - c.left + 6] = 0;
    images.push(
      await sharp(buf, { raw: { width: cw + 12, height: ch + 12, channels: 1 } })
        .resize({ height: 128 })
        .png()
        .toBuffer(),
    );
  }
  return images;
}
