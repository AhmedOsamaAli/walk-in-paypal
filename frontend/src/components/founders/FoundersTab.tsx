import "../../styles/founders.css";
import { useRef } from "react";
import { paypalOf, type KitCampaign } from "../../api/founders";
import type { Kit, KitView } from "../../api/kit";
import { cx } from "../../lib/css";
import { dayText, deadlineText, heldText, inSandbox, moneyText, neededText, ownCampaign, statusText, supportersText } from "../../lib/founders";
import { absoluteUrl } from "../../lib/kit";
import { isPlainClick } from "../../lib/navigation";
import { useSession } from "../../state/session";
import { CopyButton } from "../CopyButton";
import { Link } from "../Link";
import { SignInOptions } from "../SignIn";
import { CampaignForm } from "./CampaignForm";
import { ProgressBar } from "./ProgressBar";
import { SandboxNotice } from "./SandboxNotice";

/** The count, the money and the terms of a kit's campaign, in a line or two. */
function Standing({ campaign, name }: { campaign: KitCampaign; name: string }) {
  const progress = {
    supporters: campaign.supporters,
    goal: campaign.goal,
    remaining: Math.max(0, campaign.goal - campaign.supporters),
    funded: campaign.supporters >= campaign.goal,
  };
  return (
    <div className="fk-standing">
      <p className="fk-count">
        <b>{campaign.supporters}</b> of {campaign.goal} neighbors
        <span className="mono">
          {neededText(progress, campaign.deadline)} · {heldText(campaign.status, campaign.total)}
        </span>
      </p>
      <ProgressBar supporters={campaign.supporters} goal={campaign.goal} funded={progress.funded} label={`Neighbors backing ${name}`} />
    </div>
  );
}

/** The owner's open campaign for this kit: how it stands, its link, and the poster that now points to it. */
function YourCampaign({ campaign, name, onPoster }: { campaign: KitCampaign; name: string; onPoster: () => void }) {
  const box = useRef<HTMLElement>(null);
  const share = absoluteUrl(campaign.url);
  return (
    <div className="fk-yours">
      <p className="fk-kicker mono">
        Your campaign · <span className="state" data-state={campaign.status}>{statusText(campaign.status)}</span>
      </p>
      <h3 className="fk-title">
        {campaign.supporters ? `Neighbors are backing ${name}` : `Your campaign for ${name} is open`}
      </h3>
      <Standing campaign={campaign} name={name} />
      <p className="fk-terms">
        Pledge {moneyText(campaign.amount)} · deadline {deadlineText(campaign.deadline)}
      </p>
      <div className="fk-actions">
        <Link className="ink-button" href={campaign.url}>
          Open the campaign page <span aria-hidden="true">→</span>
        </Link>
        <a
          className="ghost mono"
          href="#poster"
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onPoster();
          }}
        >
          See the poster
        </a>
      </div>
      <p className="fk-label mono">Share its link</p>
      <p className="cp-share">
        <code ref={box}>{share}</code>
        <CopyButton text={share} what="the campaign's link" target={box} />
      </p>
      <p className="fk-note">
        The window poster&apos;s QR code opens this campaign now, and the poster says its terms: pledge {moneyText(campaign.amount)},
        charged only if {campaign.goal} neighbors join by {dayText(campaign.deadline)}.
      </p>
    </div>
  );
}

/** Other people's open campaigns for this business, which anyone can back. */
function Others({ campaigns, name }: { campaigns: KitCampaign[]; name: string }) {
  if (!campaigns.length) return null;
  return (
    <div className="fk-others">
      <p className="fk-label mono">{campaigns.length === 1 ? "An open campaign for this business" : "Open campaigns for this business"}</p>
      <ul className="fk-other-list">
        {campaigns.map((campaign) => (
          <li key={campaign.id}>
            <Link className="fk-other" href={campaign.url}>
              <span className="fk-other-main">
                <b>{supportersText(campaign)}</b>
                <span>
                  Pledge {moneyText(campaign.amount)} · {heldText(campaign.status, campaign.total)} · by {dayText(campaign.deadline)}
                </span>
              </span>
              <span className="place-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="fk-note">Back {name} there, or start your own below.</p>
    </div>
  );
}

interface FoundersTabProps {
  view: KitView;
  kit: Kit;
  /** Shows the poster's tab. */
  onPoster: () => void;
}

/**
 * The kit's Founders tab: the owner's open campaign for the kit, or the way to start one (signed in with Google first);
 * other people's open campaigns for the business are listed for anyone to back.
 */
export function FoundersTab({ view, kit, onPoster }: FoundersTabProps) {
  const { phase, user, config } = useSession();
  const paypal = paypalOf(config);
  const name = kit.concept.name;
  const mine = ownCampaign(view);
  const others = (view.campaigns ?? []).filter((campaign) => !campaign.is_owner && campaign.status === "open");

  let body;
  if (mine) body = <YourCampaign campaign={mine} name={name} onPoster={onPoster} />;
  else if (view.campaigns === undefined) {
    // The kit's campaigns are still on their way (state/kit.ts): no form for one the owner may already have.
    body = <div className="sk sk-block short" aria-hidden="true" />;
  } else if (user) {
    body = (
      <>
        <Others campaigns={others} name={name} />
        {paypal?.enabled === false ? (
          <p className="cp-off">Founders is off on this server: PayPal isn&apos;t set up here, so no campaign can take pledges.</p>
        ) : (
          <CampaignForm token={view.token} name={name} email={user.email} sandbox={inSandbox(paypal)} />
        )}
      </>
    );
  } else if (phase === "loading") {
    body = <div className="sk sk-block short" aria-hidden="true" />;
  } else {
    body = (
      <>
        <Others campaigns={others} name={name} />
        <div className={cx("prompt-card", "fk-signin")}>
          <h3 className="prompt-title">Sign in with Google to start one</h3>
          <p className="prompt-text">
            A campaign belongs to the person who starts it: you set the money terms, AI drafts the words from this kit&apos;s
            evidence, and you publish. Backing one never needs an account.
          </p>
          <SignInOptions />
        </div>
      </>
    );
  }

  return (
    <div className="fk">
      <ol className="fk-how" aria-label="How Founders works">
        <li>
          <b>Neighbors pledge with PayPal</b>
          <span>before the lease is signed. PayPal only holds each pledge.</span>
        </li>
        <li>
          <b>Enough of them by the deadline?</b>
          <span>Everyone is charged, and the money goes to you.</span>
        </li>
        <li>
          <b>Short of the goal?</b>
          <span>Every hold is released. Nobody pays.</span>
        </li>
      </ol>
      {mine && inSandbox(paypal) ? <SandboxNotice /> : null}
      {body}
    </div>
  );
}
