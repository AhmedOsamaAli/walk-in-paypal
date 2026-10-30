import { Suspense, useState } from "react";
import type { Campaign } from "../../api/founders";
import { lazyComponent, lazyModule } from "../../lib/lazy";

const posterChunk = lazyModule(() => import("./CampaignPoster"));
const CampaignPoster = lazyComponent(posterChunk, (module) => module.CampaignPoster);

/** The poster editor and QR encoder load only when the owner asks for them. */
export function CampaignPosterButton({ campaign }: { campaign: Campaign }) {
  const [open, setOpen] = useState(false);
  return <div className="cp-owner-poster">
    <button type="button" className="ghost mono" aria-expanded={open} onClick={() => { setOpen((value) => !value); }}>
      {open ? "Hide the campaign poster" : "Make a poster with the real perks"}
    </button>
    {open ? <Suspense fallback={<p role="status">Loading the poster editor...</p>}>
      <CampaignPoster campaign={campaign} />
    </Suspense> : null}
  </div>;
}
