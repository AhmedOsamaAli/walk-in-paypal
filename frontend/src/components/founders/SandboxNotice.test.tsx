import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SANDBOX_NOTICE } from "../../lib/founders";
import { SandboxNotice } from "./SandboxNotice";

describe("the demo-payment disclosure", () => {
  it("uses the same compact, explicit wording as the poster", () => {
    const html = renderToStaticMarkup(<SandboxNotice className="cp-sandbox" />);
    expect(SANDBOX_NOTICE).toBe("Demo payments — no real money.");
    expect(html).toContain(SANDBOX_NOTICE);
    expect(html).toContain('class="sandbox cp-sandbox"');
    expect(html).not.toContain("PayPal sandbox");
  });
});
