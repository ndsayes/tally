// Shrinks a photo to a size Claude reads well (long edge ≤ 1568 px) and converts it to JPEG.
// Smaller images upload faster and cost fewer tokens.
export async function prepImage(file, maxEdge = 1568) {
  const img = await load(file);
  const w = img.width;
  const h = img.height;
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * s);
  canvas.height = Math.round(h * s);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { dataUrl, data: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' };
}

async function load(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // fall through to <img>
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not open that image.'));
    img.src = URL.createObjectURL(file);
  });
}
