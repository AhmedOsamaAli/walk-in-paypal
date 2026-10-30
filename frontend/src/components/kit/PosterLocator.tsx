import type { StreetMap } from "../../api/sitemap";
import type { LatLon } from "../../api/types";
import { fitFrame, linePath, ringPath, STREET_LAYERS } from "../../lib/sitemap";
import { POSTER_FONTS, type Box } from "../../lib/poster";
import type { PosterBrand } from "../../lib/posterBrand";

/** A real street locator around the proposed door, not a survey catchment or a claim that the viewer is there. */
export function PosterLocator({ streets, site, box, brand, clipId, planned = true }: {
  streets: StreetMap; site: LatLon; box: Box; brand: PosterBrand; clipId: string; planned?: boolean;
}) {
  const north = 320 / 111_320;
  const east = north / Math.max(.02, Math.cos(site[0] * Math.PI / 180));
  const camera: LatLon[] = [[site[0] - north, site[1] - east], [site[0] + north, site[1] + east]];
  const frame = fitFrame(camera, site, { width: box.width, height: box.height, pad: 10, box: streets.box });
  const [x, y] = frame.at(site);
  return (
    <g transform={`translate(${box.x} ${box.y})`}>
      <g clipPath={`url(#${clipId})`}>
        <rect width={box.width} height={box.height} fill="#f3f1e8" />
        <path d={ringPath(streets.water, frame.at)} fill="#c6dfe8" />
        <path d={ringPath(streets.parks, frame.at)} fill="#dbe6ca" />
        {STREET_LAYERS.map((layer, i) => <g key={layer}>
          <path d={linePath(streets.streets[layer] ?? [], frame.at)} fill="none" stroke="#bab5a7" strokeWidth={5 - i * .8} />
          <path d={linePath(streets.streets[layer] ?? [], frame.at)} fill="none" stroke="#fffdf7" strokeWidth={3.5 - i * .65} />
        </g>)}
        <circle cx={x} cy={y} r="7" fill={brand.accent} stroke={brand.ink} strokeWidth="2" />
        <rect x={Math.min(box.width - 116, Math.max(8, x + 12))} y={Math.max(7, y - 16)} width="108" height="22" rx="4" fill={brand.ink} />
        <text x={Math.min(box.width - 108, Math.max(16, x + 20))} y={Math.max(22, y - 1)} fontFamily={POSTER_FONTS.mono} fontSize="8.5" fill={brand.paper}>{planned ? "PLANNED LOCATION" : "FIND US HERE"}</text>
      </g>
      <rect width={box.width} height={box.height} fill="none" stroke={brand.ink} strokeWidth=".8" />
      <text x={box.width - 4} y={box.height - 5} textAnchor="end" fontFamily={POSTER_FONTS.sans} fontSize="6.8" fill="#343a3e" stroke="#f3f1e8" strokeWidth="2" paintOrder="stroke">{streets.credit}</text>
    </g>
  );
}
