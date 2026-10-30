import type { Campaign } from "../../api/founders";
import { posterForCampaign } from "../../lib/posterProject";
import { PosterSection } from "../kit/PosterSection";

export function CampaignPoster({ campaign }: { campaign: Campaign }) {
  return <section className="cp-sec cp-campaign-poster" aria-label="Your campaign poster">
    <h2 className="cp-h">A poster for your founding supporters</h2>
    <PosterSection poster={posterForCampaign(campaign)} scope={campaign.kit_token ? `kit:${campaign.kit_token}` : `campaign:${campaign.id}`}
      campaign={campaign} link={null} />
  </section>;
}
