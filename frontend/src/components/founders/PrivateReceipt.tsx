import { useRef } from "react";
import { absoluteUrl } from "../../lib/kit";
import { receiptUrl } from "../../lib/routes";
import { CopyButton } from "../CopyButton";

export function PrivateReceipt({ token }: { token: string }) {
  const target = useRef<HTMLAnchorElement>(null);
  const path = receiptUrl(token);
  return (
    <div className="cp-private-receipt">
      <p className="mono">Your private receipt</p>
      <p>Keep this link to check or withdraw your pledge from another device. Anyone with it can do the same, so do not share it publicly.</p>
      <div className="cp-receipt-link">
        <a ref={target} href={path} rel="noreferrer">{absoluteUrl(path)}</a>
        <CopyButton text={absoluteUrl(path)} what="your private receipt link" target={target} />
      </div>
    </div>
  );
}
