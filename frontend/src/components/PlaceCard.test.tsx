import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Pin } from "../map/pins";
import { PlaceCard } from "./PlaceCard";

const pin: Pin = { key: "bakery#c0", name: "Actual Bakery", mark: "1", role: "inside",
  lat: 30, lon: 31, distanceM: 50, inArea: true, alsoLoved: false, osm: null,
  place: { id: "p1", name: "Actual Bakery", lat: 30, lon: 31, rating: 4.5, known_for: ["Rye loaf"],
    complaints: ["Long lines"], url: "https://example.com/bakery", link: "site" } };
const render = (compact: boolean) => renderToStaticMarkup(<PlaceCard pin={pin} compact={compact} focus={false}
  onExpand={() => undefined} onClose={() => undefined} />);

describe("compact previews keep the full card accessible", () => {
  it("shows a real name and rating without turning hover into a large details panel", () => {
    const html = render(true);
    expect(html).toContain('class="place-card inside preview"');
    expect(html).toContain("Actual Bakery");
    expect(html).toContain("4.5");
    expect(html).toContain("View details");
    expect(html).not.toContain("Known for Rye loaf");
    expect(html).not.toContain("Reviews complain about");
    expect(html).toContain('href="https://example.com/bakery"');
    expect(html).toContain('target="_blank"');
  });
  it("retains all place details for explicit click, tap and keyboard activation", () => {
    const html = render(false);
    expect(html).toContain("Known for Rye loaf");
    expect(html).toContain("Reviews complain about");
    expect(html).not.toContain("View details");
    expect(html).toContain('aria-label="Close"');
  });
});
