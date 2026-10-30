import serif from "@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2?url";
import sans from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import mono from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url";
import { POSTER_H, POSTER_W } from "./poster";

let fonts: Promise<string> | null = null;
const FACES = [["Newsreader Variable", serif], ["Geist Variable", sans], ["Geist Mono Variable", mono]] as const;

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The poster asset could not be read."));
    };
    reader.onerror = () => { reject(new Error("The poster asset could not be read.")); };
    reader.readAsDataURL(blob);
  });
}

function fontRules(): Promise<string> {
  fonts ??= Promise.all(FACES.map(async ([name, url]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("The poster fonts could not be embedded. Check your connection and try again.");
    return `@font-face{font-family:"${name}";font-weight:100 900;src:url("${await dataUrl(await response.blob())}") format("woff2");}`;
  })).then((rules) => rules.join("\n")).catch((error: unknown) => { fonts = null; throw error; });
  return fonts;
}

async function posterBlob(svg: SVGSVGElement, raster: boolean): Promise<Blob> {
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
  if (svg.dataset.posterReady !== "true") {
    const problem = svg.dataset.posterProblem;
    throw new Error(problem?.trim() ? problem : "Wait for the poster to finish loading.");
  }
  const copy = svg.cloneNode(true);
  if (!(copy instanceof SVGSVGElement)) throw new Error("The poster could not be prepared for export.");
  copy.setAttribute("width", raster ? String(POSTER_W * 4) : "176.9mm");
  copy.setAttribute("height", raster ? String(POSTER_H * 4) : "250mm");
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = await fontRules();
  copy.insertBefore(style, copy.firstChild);
  return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}`], { type: "image/svg+xml" });
}

export function posterFileName(name: string, extension: "svg" | "png"): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "walk-in"}-poster.${extension}`;
}

export async function downloadPoster(svg: SVGSVGElement, name: string, format: "svg" | "png"): Promise<void> {
  const blob = await posterBlob(svg, format === "png");
  let output = blob;
  if (format === "png") {
    // Data images are allowed by the app's CSP; blob images deliberately are not.
    const image = new Image();
    image.src = await dataUrl(blob);
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = POSTER_W * 4;
    canvas.height = POSTER_H * 4;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot export the poster as an image.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    output = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error("The poster image could not be exported."));
      }, "image/png");
    });
  }
  const url = URL.createObjectURL(output);
  const link = document.createElement("a");
  link.href = url;
  link.download = posterFileName(name, format);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 2000);
}
