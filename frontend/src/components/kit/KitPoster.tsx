import { useEffect } from "react";
import type { Kit, KitView } from "../../api/kit";
import { ownCampaign } from "../../lib/founders";
import { trackedUrl } from "../../lib/kit";
import { posterForKit } from "../../lib/posterProject";
import type { PosterStatus } from "./PosterArt";
import { PosterSection } from "./PosterSection";
import type { Landing } from "./TrackedLinks";

interface KitPosterProps {
  view: KitView;
  kit: Kit;
  landing: Landing;
  campaignsError?: string | null;
  mode?: "editor" | "report";
  onAddLink?: () => void;
  onStatus?: (status: PosterStatus) => void;
}

/** The same checked offer, destination, actual campaign and saved artwork on every kit/report surface. */
export function KitPoster({ view, kit, landing, campaignsError, ...props }: KitPosterProps) {
  const pending = view.campaigns === undefined;
  const { onStatus } = props;
  useEffect(() => {
    if (pending || campaignsError) onStatus?.({ ready: false, problem: campaignsError ?? null });
  }, [pending, campaignsError, onStatus]);
  if (pending || campaignsError) return <p className="poster-ask" role={campaignsError ? "alert" : "status"}>
    {campaignsError ?? "Checking this kit's campaign before preparing the customized poster…"}
  </p>;
  const tracked = kit.links.find((link) => link.key === "poster");
  return <PosterSection poster={posterForKit(kit)} scope={`kit:${view.token}`}
    link={tracked ? trackedUrl(landing.url, tracked.query) : landing.url}
    landing={landing} campaign={ownCampaign(view)} {...props} />;
}
