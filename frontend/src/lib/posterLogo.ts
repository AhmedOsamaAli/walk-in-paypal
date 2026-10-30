import { posterLogoMime } from "./posterBrand";

export async function readPosterLogo(file: File): Promise<{ data: string; background: string; accent?: string }> {
  if (file.size > 512 * 1024) throw new Error("Keep the logo to 512 KB or less.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = posterLogoMime(bytes);
  if (!mime) throw new Error("Use a real PNG, JPEG or WebP logo, not an SVG or another file renamed as an image.");
  const blob = new Blob([bytes], { type: mime });
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch {
    throw new Error("The logo image could not be decoded. Export it again as PNG, JPEG or WebP.");
  }
  if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4096 || bitmap.height > 4096) {
    bitmap.close();
    throw new Error("The logo must be at most 4096 pixels in either direction.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 48;
  const context = canvas.getContext("2d");
  if (!context) { bitmap.close(); throw new Error("This browser cannot read the logo's colors."); }
  context.drawImage(bitmap, 0, 0, 48, 48);
  bitmap.close();
  const pixels = context.getImageData(0, 0, 48, 48).data;
  const colors = new Map<string, number>();
  let brightness = 0, visible = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] ?? 0, g = pixels[i + 1] ?? 0, b = pixels[i + 2] ?? 0;
    if ((pixels[i + 3] ?? 0) < 128) continue;
    brightness += .2126 * r + .7152 * g + .0722 * b;
    visible++;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 24) continue;
    const key = `#${[r, g, b].map((value) => Math.min(255, Math.round(value / 32) * 32).toString(16).padStart(2, "0")).join("")}`;
    colors.set(key, (colors.get(key) ?? 0) + 1);
  }
  if (!visible) throw new Error("The logo is entirely transparent. Use an image with visible artwork.");
  const accent = [...colors].sort((a, b) => b[1] - a[1])[0]?.[0];
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The logo could not be read."));
    };
    reader.onerror = () => { reject(new Error("The logo could not be read.")); };
    reader.readAsDataURL(blob);
  });
  return { data, background: visible && brightness / visible > 160 ? "#17203b" : "#ffffff", ...(accent ? { accent } : {}) };
}
