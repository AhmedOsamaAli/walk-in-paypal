import type { Box } from "../../lib/poster";
import { POSTER_FONTS } from "../../lib/poster";
import type { PosterBrand } from "../../lib/posterBrand";

/** Original vector artwork, varied by the business and its art direction; no borrowed brand or audience imagery. */
export function PosterMotif({ box, brand, clipId }: { box: Box; brand: PosterBrand; clipId: string }) {
  if (box.height < 1) return null;
  const { width: w, height: h } = box;
  const variation = brand.seed % 7;
  const lightId = `${clipId}-light`;
  return (
    <g transform={`translate(${box.x} ${box.y})`} clipPath={`url(#${clipId})`} aria-hidden="true">
      <defs>
        <radialGradient id={lightId} cx={brand.direction === "night" ? "64%" : "28%"} cy="18%" r="85%">
          <stop offset="0" stopColor={brand.accent} stopOpacity={brand.direction === "night" ? ".23" : ".17"} />
          <stop offset="1" stopColor={brand.paper} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={w} height={h} fill={`url(#${lightId})`} />
      {brand.direction === "botanical" ? (
        <g>
          <g transform="translate(22 11)" fill={brand.ink} opacity=".065">
            {[.15, .34, .56, .78].map((at, i) => <ellipse key={at} cx={w * at} cy={h * (.22 + (i % 2) * .28)}
              rx={w * .095} ry={h * .42} transform={`rotate(-32 ${w * at} ${h * .42})`} />)}
          </g>
          <ellipse cx={w / 2} cy={h * .72} rx={w * .36} ry={h * .62} fill={brand.accent} />
          {Array.from({ length: 5 + variation % 3 }, (_, i) => {
            const x = 25 + i * w / 7;
            return <g key={i} transform={`translate(${x} ${h}) rotate(${(i % 2 ? 1 : -1) * (18 + variation)})`}>
              <path d={`M0 0Q35 ${-h * .55} 5 ${-h}`} fill="none" stroke={brand.ink} strokeWidth="2" />
              {[.3, .55, .8].map((at, j) => <ellipse key={at} cx={j % 2 ? 13 : -8} cy={-h * at} rx={10 + variation} ry="23" transform={`rotate(${j % 2 ? 35 : -35} 0 ${-h * at})`} fill={brand.ink} />)}
            </g>;
          })}
          <text x={w / 2} y={h * .68} textAnchor="middle" fontFamily={POSTER_FONTS.serif} fontSize={Math.min(98, h * .7)} fill={brand.paper}>{brand.initials}</text>
        </g>
      ) : brand.direction === "kinetic" ? (
        <g>
          <path d={`M0 ${h * .89}L${w} ${h * .52}M0 ${h * .99}L${w} ${h * .62}`}
            stroke={brand.ink} strokeWidth={h * .14} opacity=".055" />
          <rect x={-w * .1} y={h * .15} width={w * 1.2} height={h * .7} fill={brand.ink} transform={`rotate(-${7 + variation} ${w / 2} ${h / 2})`} />
          <circle cx={w * .74} cy={h / 2} r={h * .39} fill="none" stroke={brand.accent} strokeWidth={h * .12} />
          <path d={`M20 ${h * .55}H${w * .17}L${w * .24} ${h * .28}L${w * .34} ${h * .78}L${w * .44} ${h * .42}H${w * .91}`} fill="none" stroke={brand.paper} strokeWidth="5" strokeLinejoin="round" />
          <text x={25} y={h * .78} fontFamily={POSTER_FONTS.sans} fontWeight="600" fontSize={Math.min(86, h * .56)} fill={brand.paper}>{brand.initials}</text>
        </g>
      ) : brand.direction === "coastal" ? (
        <g>
          <ellipse cx={w * .55} cy={h * .62} rx={w * .35} ry={h * .35} fill={brand.ink} opacity=".075"
            transform={`rotate(-8 ${w / 2} ${h / 2})`} />
          <ellipse cx={w * .5} cy={h * .45} rx={w * .36} ry={h * .39} fill={brand.ink} />
          <path d={`M${w * .2} ${h * .55}Q${w * .43} ${-h * .3} ${w * .65} ${h * .5}L${w * .8} ${h * .19}L${w * .76} ${h * .79}L${w * .65} ${h * .56}Q${w * .4} ${h * 1.18} ${w * .2} ${h * .55}Z`} fill={brand.accent} />
          <circle cx={w * .3} cy={h * .47} r="4" fill={brand.ink} />
          {Array.from({ length: 4 }, (_, i) => <path key={i} d={`M-15 ${h * .7 + i * 13}Q${w * .2} ${h * .4 + i * 13} ${w * .45} ${h * .73 + i * 13}T${w + 15} ${h * .7 + i * 13}`} fill="none" stroke={brand.ink} strokeWidth="1.5" />)}
        </g>
      ) : brand.direction === "night" ? (
        <g>
          {Array.from({ length: 6 + variation % 3 }, (_, i) => <ellipse key={i} cx={w * .54} cy={h * .52} rx={35 + i * 22} ry={18 + i * 10} fill="none" stroke={i % 2 ? brand.ink : brand.accent} strokeWidth={i % 2 ? 1 : 3} transform={`rotate(-22 ${w / 2} ${h / 2})`} />)}
          <path d={`M0 ${h * .12}H${w * .32}V${h * .92}H${w * .9}`} fill="none" stroke={brand.accent} strokeWidth="10" />
          <text x={24} y={h * .67} fontFamily={POSTER_FONTS.sans} fontSize={Math.min(84, h * .66)} fill={brand.ink}>{brand.initials}</text>
        </g>
      ) : brand.direction === "workshop" ? (
        <g>
          <rect x={w * .08} y={h * .13} width={w * .88} height={h * .84} fill={brand.ink} opacity=".11"
            transform={`rotate(${variation - 3} ${w / 2} ${h / 2})`} />
          <rect x={w * .06} y={h * .08} width={w * .88} height={h * .84} fill={brand.accent} transform={`rotate(${variation - 3} ${w / 2} ${h / 2})`} />
          <circle cx={w * .72} cy={h * .5} r={h * .3} fill={brand.paper} stroke={brand.ink} strokeWidth="3" />
          <path d={`M${w * .72} ${h * .18}V${h * .82}M${w * .58} ${h * .5}H${w * .86}`} stroke={brand.ink} strokeWidth="2" />
          <text x={w * .11} y={h * .7} fontFamily={POSTER_FONTS.sans} fontWeight="600" fontSize={Math.min(100, h * .7)} fill={brand.accentInk}>{brand.initials}</text>
        </g>
      ) : (
        <g>
          <path d={`M${w * .18} ${h}V${h * .48}A${w * .36} ${h * .47} 0 0 1 ${w * .9} ${h * .48}V${h}Z`}
            fill={brand.ink} opacity=".075" />
          <path d={`M${w * .14} ${h}V${h * .45}A${w * .36} ${h * .47} 0 0 1 ${w * .86} ${h * .45}V${h}Z`} fill={brand.accent} />
          <path d={`M${w * .3} ${h * .9}Q${w * .46} ${h * .75} ${w * .62} ${h * .9}V${h * .3}Q${w * .46} ${h * .1} ${w * .3} ${h * .3}Z`} fill={brand.paper} />
          <path d={`M${w * .62} ${h * .9}Q${w * .73} ${h * .8} ${w * .81} ${h * .87}V${h * .27}Q${w * .73} ${h * .15} ${w * .62} ${h * .3}Z`} fill={brand.ink} />
          <text x={w * .44} y={h * .69} textAnchor="middle" fontFamily={POSTER_FONTS.serif} fontSize={Math.min(76, h * .55)} fill={brand.ink}>{brand.initials.slice(0, 1)}</text>
        </g>
      )}
    </g>
  );
}
