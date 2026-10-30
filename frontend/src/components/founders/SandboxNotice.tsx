import { cx } from "../../lib/css";
import { SANDBOX_NOTICE } from "../../lib/founders";

/** A compact, explicit disclosure at payment decisions and money/status views. */
export function SandboxNotice({ className }: { className?: string }) {
  return (
    <p className={cx("sandbox", className)}>
      {SANDBOX_NOTICE}
    </p>
  );
}
