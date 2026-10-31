/* A survey on screen: its live status, the site's title block, and the results in tabs, each panel ending with the way on
   to the next. A chunk of its own, loaded the first time a survey shows (the app starts loading it before then). */
import type { ReactNode, Ref } from "react";
import type { Travel } from "../api/types";
import { BlockSection } from "../components/BlockSection";
import { ConceptsSection } from "../components/ConceptsSection";
import { ExampleWait } from "../components/ExampleWait";
import { GapsSection } from "../components/GapsSection";
import { ImproveSection } from "../components/ImproveSection";
import { KeepSurveys } from "../components/KeepSurveys";
import { LiveStatus } from "../components/LiveStatus";
import { SectionBoundary } from "../components/SectionBoundary";
import { SiteHeader } from "../components/SiteHeader";
import { SurveyLog } from "../components/SurveyLog";
import { TabPager, TabPanel, Tabs } from "../components/Tabs";
import { TasteSection } from "../components/TasteSection";
import { VerdictSection } from "../components/VerdictSection";
import type { ResultLink } from "../lib/journey";
import { Settled } from "../lib/motion";
import { SURVEY_TABS_ID, tabNo, type SurveyTab, type SurveyTabItem } from "../lib/surveyTabs";
import { withUnderstood, withVerdict, type Surveyed } from "../lib/titleBlock";
import { areaWord } from "../map/pins";
import type { SurveyState } from "../state/survey";

export interface SurveyViewProps {
  survey: SurveyState;
  /** The site's name, eyebrow and title block. */
  title: Surveyed;
  /** Restored or brought back rather than streamed here: nothing animates in again. */
  settled: boolean;
  tabs: SurveyTabItem[];
  selected: SurveyTab;
  /** The tabs left since they were last shown in this run: what they hold does not slide in again. */
  left: { run: number; tabs: SurveyTab[] };
  /** Where the status bar sends the owner once the survey is done, until they have looked. */
  result: ResultLink | null;
  /** The tab with the answer, once the survey is complete. */
  answer: SurveyTab | null;
  /** The line under the status while a survey runs, pointing at the finished examples. */
  examples: boolean;
  /** "Keep your surveys": under a survey run here that completed. */
  keep: boolean;
  /** Where the site stands, for its link to Google Maps. */
  point: { lat: number; lon: number } | null;
  /** The area inside a sentence ("10-minute walk"), and how it was measured, for "inside the walk" or "the drive". */
  areaLabel: string;
  travel: Travel;
  /** The site's name, where focus lands when a survey is restored or brought back. */
  titleRef: Ref<HTMLHeadingElement>;
  /** Shows a tab; `focus` moves focus to its first heading. */
  onShowTab: (id: SurveyTab, focus: boolean) => void;
  onRetry: () => void;
  onNewSurvey: () => void;
  onToggleGap: (index: number) => void;
  onOpenDesign: (index: number, opener: HTMLElement | null) => void;
}

export function SurveyView({
  survey,
  title,
  settled,
  tabs,
  selected,
  left,
  result,
  answer,
  examples,
  keep,
  point,
  areaLabel,
  travel,
  titleRef,
  onShowTab,
  onRetry,
  onNewSurvey,
  onToggleGap,
  onOpenDesign,
}: SurveyViewProps) {
  /** The area after "inside" or "outside": "the walk", or "the drive" for a drive or a road distance. */
  const area = areaWord(travel);

  /** What a tab holds, once it has arrived. */
  function panelContent(id: SurveyTab): ReactNode {
    const no = tabNo(survey.intent, id);
    switch (id) {
      case "log":
        return (
          <SectionBoundary key={`log-${survey.run}`} label="The survey log">
            <SurveyLog no={no} log={survey.log} summary={survey.summary} />
          </SectionBoundary>
        );
      case "area":
        return survey.block ? (
          <SectionBoundary key={`block-${survey.run}`} label="The block">
            <BlockSection no={no} block={survey.block} area={areaLabel} />
          </SectionBoundary>
        ) : null;
      case "gaps":
        return survey.gaps ? (
          <SectionBoundary key={`gaps-${survey.run}`} label="The gaps">
            <GapsSection no={no} gaps={survey.gaps} openGap={survey.openGap} onToggle={onToggleGap} area={area} />
          </SectionBoundary>
        ) : null;
      case "verdict":
        return survey.verdict ? (
          <SectionBoundary key={`verdict-${survey.run}`} label="The verdict">
            <VerdictSection no={no} verdict={survey.verdict} />
          </SectionBoundary>
        ) : null;
      case "improve":
        return survey.improve ? (
          <SectionBoundary key={`improve-${survey.run}`} label="What to change">
            <ImproveSection no={no} data={survey.improve} />
          </SectionBoundary>
        ) : null;
      case "concepts":
        return survey.concepts ? (
          <SectionBoundary key={`concepts-${survey.run}`} label="The concepts">
            <ConceptsSection
              no={no}
              data={survey.concepts}
              rules={survey.understood}
              baseline={survey.baseline}
              onOpen={onOpenDesign}
              runId={survey.runId}
            />
          </SectionBoundary>
        ) : null;
      case "taste":
        return survey.taste ? (
          <SectionBoundary key={`taste-${survey.run}`} label="The wider taste">
            <TasteSection no={no} taste={survey.taste} cues={survey.cues ?? []} />
          </SectionBoundary>
        ) : null;
    }
  }

  return (
    <>
      <Settled value={settled}>
        <SectionBoundary key={`live-${survey.run}`} label="The survey status">
          <LiveStatus
            survey={survey}
            result={result}
            onResult={() => {
              if (answer) onShowTab(answer, true);
            }}
            onRetry={onRetry}
          />
        </SectionBoundary>
        {examples ? <ExampleWait key={`wait-${survey.run}`} running={survey.status === "running"} /> : null}
        <SiteHeader
          eyebrow={title.eyebrow}
          label={title.label}
          fields={withVerdict(withUnderstood(title.fields, survey.understood), survey.verdict)}
          point={point}
          onNewSurvey={onNewSurvey}
          titleRef={titleRef}
        />
        <Tabs
          label="Results"
          items={tabs}
          selected={selected}
          onSelect={(id) => {
            onShowTab(id as SurveyTab, false);
          }}
          idPrefix={SURVEY_TABS_ID}
          pin="page"
          className="survey-tabs"
        />
        {tabs.map(({ id }) => (
          <TabPanel
            key={id}
            idPrefix={SURVEY_TABS_ID}
            id={id}
            selected={id === selected}
            className={left.run === survey.run && left.tabs.includes(id) ? "tab-left" : undefined}
          >
            {panelContent(id)}
            <TabPager
              items={tabs}
              current={id}
              onSelect={(next) => {
                onShowTab(next as SurveyTab, true);
              }}
            />
          </TabPanel>
        ))}
      </Settled>
      {keep ? <KeepSurveys /> : null}
    </>
  );
}
