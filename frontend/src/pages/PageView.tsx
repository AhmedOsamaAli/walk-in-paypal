import { Suspense } from "react";
import { examplesChunk, foundersChunk, kitChunk, placesChunk, privacyChunk } from "../chunks";
import { ExampleBanner } from "../components/ExampleBanner";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { lazyComponent } from "../lib/lazy";
import { pageUrl, type PageRoute } from "../lib/routes";
import { kitExample, useExamples } from "../state/examples";

// Each page loads with its own chunk the first time it opens.
const ExamplesPage = lazyComponent(examplesChunk, (chunk) => chunk.ExamplesPage);
const KitPage = lazyComponent(kitChunk, (chunk) => chunk.KitPage);
const DossierPage = lazyComponent(kitChunk, (chunk) => chunk.DossierPage);
const PlacesPage = lazyComponent(placesChunk, (chunk) => chunk.PlacesPage);
const PrivacyPage = lazyComponent(privacyChunk, (chunk) => chunk.PrivacyPage);
const FoundersPage = lazyComponent(foundersChunk, (chunk) => chunk.FoundersPage);
const CampaignPage = lazyComponent(foundersChunk, (chunk) => chunk.CampaignPage);
const ReceiptPage = lazyComponent(foundersChunk, (chunk) => chunk.ReceiptPage);
const StartCampaignPage = lazyComponent(foundersChunk, (chunk) => chunk.StartCampaignPage);

function Broken() {
  return (
    <main className="page" id="main">
      <div className="page-sheet">
        <p className="page-alert" role="alert">
          This page could not be shown. Reload it to try again.
        </p>
      </div>
    </main>
  );
}

/** The sheet a page sits on, empty while the page's own code loads, so nothing moves when the page arrives. */
function Loading() {
  return (
    <main className="page" id="main" aria-busy="true">
      <div className="page-sheet">
        <p className="sr-only">Loading the page…</p>
      </div>
    </main>
  );
}

interface PageViewProps {
  route: PageRoute;
  /** "Survey your own storefront", from the examples and an example's pages: a fresh brief at "/". */
  onFresh: () => void;
}

function Shown({ route, onFresh }: PageViewProps) {
  switch (route.page) {
    case "places":
      return <PlacesPage />;
    case "privacy":
      return <PrivacyPage />;
    case "examples":
      return <ExamplesPage onFresh={onFresh} />;
    case "founders":
      return <FoundersPage />;
    case "kit":
      return <KitPage token={route.token} />;
    case "dossier":
      return <DossierPage token={route.token} />;
    case "campaign":
      return <CampaignPage route={route} />;
    case "receipt":
      return <ReceiptPage token={route.token} />;
    case "start-campaign":
      return <StartCampaignPage />;
  }
}

/**
 * The page an address asks for, each in a boundary of its own so nothing carries over from one page to the next. An
 * example's kit and its report say they are an example, above the page and off its paper.
 */
export function PageView({ route, onFresh }: PageViewProps) {
  const { list } = useExamples();
  const example = route.page === "kit" || route.page === "dossier" ? kitExample(list, route.token) : null;
  return (
    <>
      {example ? <ExampleBanner example={example} onFresh={onFresh} page /> : null}
      <ErrorBoundary key={pageUrl(route)} fallback={<Broken />}>
        <Suspense fallback={<Loading />}>
          <Shown route={route} onFresh={onFresh} />
        </Suspense>
      </ErrorBoundary>
    </>
  );
}
