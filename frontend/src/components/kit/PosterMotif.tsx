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
    <g transform={`translate(${box.x} ${box.y})`} clipPath={`url(#${clipId})`} aria-hidden="true" data-poster-subject={brand.subject}>
      <defs>
        <radialGradient id={lightId} cx={brand.direction === "night" ? "64%" : "28%"} cy="18%" r="85%">
          <stop offset="0" stopColor={brand.accent} stopOpacity={brand.direction === "night" ? ".23" : ".17"} />
          <stop offset="1" stopColor={brand.paper} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={w} height={h} fill={`url(#${lightId})`} />
      {["pastry", "coffee", "food", "beauty", "retail", "neutral"].includes(brand.subject) ? (
        <g>
          <ellipse cx={w * .57} cy={h * .72} rx={w * .35} ry={h * .2} fill={brand.ink} opacity=".075" />
          <g transform={`translate(${w * .5} ${h * .5}) scale(${Math.min(w / 430, h / 180)})`}>
            {brand.subject === "pastry" ? <g data-art="pastry">
              <ellipse cx="0" cy="59" rx="157" ry="15" fill={brand.paper} stroke={brand.ink} strokeWidth="2" />
              <path d="M-145 38Q-135-24-89-37Q-50-94 0-58Q50-94 89-37Q135-24 145 38L98 50L70 30Q0 68-70 30L-98 50Z"
                fill={brand.accent} stroke={brand.ink} strokeWidth="3" strokeLinejoin="round" />
              <path d="M-89-37Q-63-14-70 30M-48-61Q-25-10-28 41M48-61Q25-10 28 41M89-37Q63-14 70 30"
                fill="none" stroke={brand.ink} strokeWidth="3" opacity=".8" />
            </g> : brand.subject === "coffee" ? <g data-art="coffee">
              <ellipse cx="-5" cy="67" rx="126" ry="11" fill={brand.ink} opacity=".12" />
              <path d="M-81-32H72V20Q72 67-5 67Q-81 67-81 20Z" fill={brand.accent} stroke={brand.ink} strokeWidth="3" />
              <path d="M74-22H97Q140-22 123 20Q112 41 74 36" fill="none" stroke={brand.ink} strokeWidth="9" />
              <ellipse cx="-5" cy="-32" rx="76" ry="15" fill={brand.paper} stroke={brand.ink} strokeWidth="3" />
              <path d="M-38-47Q-55-64-36-80M0-47Q-17-64 2-80M36-47Q19-64 38-80" stroke={brand.ink} strokeWidth="3" fill="none" />
            </g> : brand.subject === "food" ? <g data-art="food">
              <ellipse rx="100" ry="72" fill={brand.paper} stroke={brand.ink} strokeWidth="3" />
              <ellipse rx="76" ry="52" fill={brand.accent} />
              <path d="M-126-60V63M-141-60V-27Q-126-4-111-27V-60M126-60V63M126-60Q150-19 126-8"
                fill="none" stroke={brand.ink} strokeWidth="6" strokeLinecap="round" />
              <path d="M-35 22Q-22-35 35-26Q27 29-35 22Z" fill={brand.ink} />
            </g> : brand.subject === "beauty" ? <g data-art="beauty">
              <rect x="22" y="-35" width="70" height="99" rx="16" fill={brand.accent} stroke={brand.ink} strokeWidth="3" />
              <path d="M38-35V-60H76V-35M56-60V-76H96M-91 15L-11-67M-91-25L-11 60" fill="none" stroke={brand.ink} strokeWidth="5" />
              <circle cx="-108" cy="31" r="20" fill="none" stroke={brand.ink} strokeWidth="5" />
              <circle cx="-108" cy="-41" r="20" fill="none" stroke={brand.ink} strokeWidth="5" />
            </g> : brand.subject === "retail" ? <g data-art="retail">
              <path d="M-90-35H90L108 70H-108Z" fill={brand.accent} stroke={brand.ink} strokeWidth="3" />
              <path d="M-38-20V-48A38 38 0 0 1 38-48V-20" fill="none" stroke={brand.ink} strokeWidth="5" />
              <text y="46" textAnchor="middle" fontFamily={POSTER_FONTS.serif} fontSize="57" fill={brand.accentInk}>{brand.initials}</text>
            </g> : <g data-art="abstract">
              <circle cx="-55" cy="0" r="65" fill={brand.accent} />
              <path d="M15-65H115V65H15Z" fill={brand.ink} transform={`rotate(${variation * 3 - 9} 65 0)`} />
              <text x="-55" y="18" textAnchor="middle" fontFamily={POSTER_FONTS.serif} fontSize="48" fill={brand.accentInk}>{brand.initials}</text>
            </g>}
          </g>
        </g>
      ) : brand.subject === "botanical" ? (
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
      ) : brand.subject === "fitness" ? (
        <g>
          <path d={`M0 ${h * .89}L${w} ${h * .52}M0 ${h * .99}L${w} ${h * .62}`}
            stroke={brand.ink} strokeWidth={h * .14} opacity=".055" />
          <rect x={-w * .1} y={h * .15} width={w * 1.2} height={h * .7} fill={brand.ink} transform={`rotate(-${7 + variation} ${w / 2} ${h / 2})`} />
          <circle cx={w * .74} cy={h / 2} r={h * .39} fill="none" stroke={brand.accent} strokeWidth={h * .12} />
          <path d={`M20 ${h * .55}H${w * .17}L${w * .24} ${h * .28}L${w * .34} ${h * .78}L${w * .44} ${h * .42}H${w * .91}`} fill="none" stroke={brand.paper} strokeWidth="5" strokeLinejoin="round" />
          <text x={25} y={h * .78} fontFamily={POSTER_FONTS.sans} fontWeight="600" fontSize={Math.min(86, h * .56)} fill={brand.paper}>{brand.initials}</text>
        </g>
      ) : brand.subject === "seafood" ? (
        <g>
          <ellipse cx={w * .55} cy={h * .62} rx={w * .35} ry={h * .35} fill={brand.ink} opacity=".075"
            transform={`rotate(-8 ${w / 2} ${h / 2})`} />
          <ellipse cx={w * .5} cy={h * .45} rx={w * .36} ry={h * .39} fill={brand.ink} />
          <path d={`M${w * .2} ${h * .55}Q${w * .43} ${-h * .3} ${w * .65} ${h * .5}L${w * .8} ${h * .19}L${w * .76} ${h * .79}L${w * .65} ${h * .56}Q${w * .4} ${h * 1.18} ${w * .2} ${h * .55}Z`} fill={brand.accent} />
          <circle cx={w * .3} cy={h * .47} r="4" fill={brand.ink} />
          {Array.from({ length: 4 }, (_, i) => <path key={i} d={`M-15 ${h * .7 + i * 13}Q${w * .2} ${h * .4 + i * 13} ${w * .45} ${h * .73 + i * 13}T${w + 15} ${h * .7 + i * 13}`} fill="none" stroke={brand.ink} strokeWidth="1.5" />)}
        </g>
      ) : brand.subject === "music" ? (
        <g>
          {Array.from({ length: 6 + variation % 3 }, (_, i) => <ellipse key={i} cx={w * .54} cy={h * .52} rx={35 + i * 22} ry={18 + i * 10} fill="none" stroke={i % 2 ? brand.ink : brand.accent} strokeWidth={i % 2 ? 1 : 3} transform={`rotate(-22 ${w / 2} ${h / 2})`} />)}
          <path d={`M0 ${h * .12}H${w * .32}V${h * .92}H${w * .9}`} fill="none" stroke={brand.accent} strokeWidth="10" />
          <text x={24} y={h * .67} fontFamily={POSTER_FONTS.sans} fontSize={Math.min(84, h * .66)} fill={brand.ink}>{brand.initials}</text>
        </g>
      ) : brand.subject === "workshop" ? (
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
