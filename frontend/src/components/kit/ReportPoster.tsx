import { KitPoster } from "./KitPoster";

type Props = Omit<Parameters<typeof KitPoster>[0], "mode" | "onAddLink"> & { preview?: boolean };

export function ReportPoster({ preview = false, ...props }: Props) {
  return <section className="dz-poster" id={preview ? "kit-report-poster" : "dz-poster"}
    aria-labelledby={preview ? "kit-report-poster-title" : "dz-poster-title"} data-section="poster">
    <header className="dz-head">
      <span className="dz-no mono">P</span>
      {preview ? <h3 className="dz-title" id="kit-report-poster-title">The customized poster</h3> :
        <h2 className="dz-title" id="dz-poster-title">The customized poster</h2>}
    </header>
    <p className="dz-poster-note">The same design, logo, checked offer and public QR destination as the poster editor on this device.
      {" "}The PDF includes this artwork on its own A4 or Letter page.</p>
    <KitPoster {...props} mode="report" />
  </section>;
}
