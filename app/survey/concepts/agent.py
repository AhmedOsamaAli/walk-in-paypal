"""The agent: a model with live Qloo tools investigates the evidence and proposes concepts, which grounding checks; an
investigation of identical evidence is replayed from the answer cache instead of spending the free AI quota again.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from ... import engine, scoring
from ...answers import AnswerCache, fingerprint
from ...llm import LLM, LLMUnavailable, compact_json
from ...qloo import QlooClient, QlooError
from ..evidence import annotate, evidence_brief, fits, gap_evidence, gap_for, gap_summary, inspect_payload, public_gap
from ..experience import fans_of
from ..models import Emit, RunState
from .grounding import clean_concepts
from .rules import requested_first, strong_enough
from .wildcard import wildcard_items, wildcard_pair, with_wildcard

log = logging.getLogger("walkin")


def wildcard_brief(run: RunState) -> dict | None:
    """The wildcard the evidence supports, as the agent sees it: the two loves it combines and what they are known for."""
    pair = wildcard_pair(run)
    if not pair:
        return None
    first, why_first, second, why_second = pair
    return {
        "combines": [{"genre": first["genre"], "evidence": why_first}, {"genre": second["genre"], "evidence": why_second}],
        "inside_the_area": "no place is both",
        "loved_items": wildcard_items(run, first, second),
    }


def agent_brief(run: RunState) -> dict:
    """The evidence pack the agent reads, with the wildcard candidate when there is one."""
    brief = evidence_brief(run)
    candidate = wildcard_brief(run)
    if candidate:
        brief["wildcard_candidate"] = candidate
    return brief


CONCEPT_SYSTEM = """You are a neighborhood business strategist who designs storefronts across retail, services,
leisure, wellness, culture and hospitality. Food and drink are not the default: consider the actual measured gaps,
including non-food businesses, and let evidence and the owner's rules determine the concepts. Do not invent variety
by recommending a weak category over a stronger fitting one.
You only reason from Qloo evidence about the people inside the site's area (catchment.area in the evidence: a walk, a
drive or a road distance, such as "10-minute walk" or "30-minute drive"): residents, workers and visitors alike, so call
them "people here", never "locals". Never call the area a walk unless it is one. When the site has an age_focus, the
rankings, favorites and taste lean toward that age group: they are what people here of that age rank and love.
Demand is compared with same-size areas around the site (on land), not the whole city; supply is compared with what a
block this dense would typically hold. Only claim that people here travel for something when the evidence says so; when it
says their favorites are just the city's famous places, there is no travel evidence. Distances are medians, not
averages.
Work like an analyst, in as few turns as possible. Tools called in the same turn run in parallel, so batch them:
1. First turn: test_category for up to 3 hunches the gap table does not cover, drawn from the brands, artists, films,
   shows and taste cues this area over-indexes on (sports teams suggest a sports bar; design brands suggest a concept
   store); in the same turn, inspect_gap and fan_taste for the 2 or 3 strongest gaps. Fan taste is the category's
   audience at large, not only people here: only its overlap with the area's signature taste is evidence of fit.
2. Second turn, only if needed: inspect_gap or fan_taste for a tested category you now want to build on.
3. Then call submit_concepts with exactly 3 concepts, each on a different genre from the gap table or your tests.
   Build on the strongest gaps: a category with a gap score under 30 is not a recommendation while stronger ones fit
   (a weak test result is a finding, not a concept), unless it is the owner's request.
Give every tool call a one-sentence reason that names the evidence behind it.
Your job in submit_concepts is to choose, name and position. The server writes every factual line itself from the
measured evidence (why here, who it is for, the competition, the risk and how each concept meets the owner's rules),
so do not restate numbers.
Hard rules. The server checks every concept against them after you answer: what breaks one is repaired once and a
concept that still breaks one is dropped, so keep them exactly.
- owner_constraints and the unit: never a category ruled_out_by_owner_notes or whose fits_the_unit starts with "no"
  (test categories that fit instead), and nothing in the offer they forbid.
- Price band (owner_constraints.price): a budget concept is never described as upscale, premium, luxury, high-end or
  fine dining, in its name, its one_liner or its items; an upscale one is never described as cheap, budget, a bargain
  or discounted; a mid-range one is neither.
- No hood (owner_constraints.no_hood, or a light kitchen): no signature item that needs a deep fryer, a griddle or
  flat-top, a grill or charcoal, a wok or a pizza oven (no fries, crispy potatoes, tempura, katsu, karaage, falafel or
  taameya, donuts, churros, burgers, kebabs or kofta, steaks, fried chicken or pizza, and no one_liner that promises
  them); everything is baked in a ventless oven or assembled cold. No kitchen (owner_constraints.no_kitchen): nothing
  is cooked at all.
- Vegetarian: no meat or fish in any item. Halal: no pork and no alcohol. Family friendly: no bars or nightlife.
- Names are original business names ("Ube & Oak"), never a category plus the neighborhood ("Breakfast, Zamalek"), and
  never reuse or echo the name of an existing place.
Other rules: never invent places, brands or statistics; inspired_by only contains names returned by inspect_gap; when
the evidence has an owner_request, the first concept is that business (its genre exactly as given), designed to win at
this site, and the other two are the strongest alternatives; respect the owner's other notes.
Be specific enough that an owner could act on it, never filler such as "great vibes" or "quality and atmosphere":
- three concepts are three different businesses (not brunch and breakfast, not a café and a coffee shop), each one a
  business someone can open: never a broad genre such as Personal care; test a specific one instead (gym, barbershop);
- one_liner is the positioning in one sentence: what it is and how it differs from the competitors inside the area.
  It states no number the evidence does not give (no seat counts, floor areas, years or prices), places no
  competitor "next door" (they are inside the area) and uses no word nothing measured backs (cozy, chic, vibe,
  welcoming, inviting, curated, elevated, haven); a one_liner that does is replaced by the evidence's own line;
- signature items come first from inspect_gap's menu_gap: what the places people here love are known for and no place
  inside the area is.
When the evidence has a wildcard_candidate, also submit wildcard: one business that combines exactly its two loves,
with a name, a one_liner and signature items drawn from its loved_items, under the same hard rules. It is shown after
the three concepts as untested and is never ranked."""


MAX_LIVE_TESTS = 3


MAX_FAN_CHECKS = 4


REASON = {"type": "string", "description": "One sentence: why you are checking this, naming the evidence behind it"}


CONCEPT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "test_category",
            "description": "Test a business category that is not in the gap table, live against Qloo: places inside the area, "
                           "what the surroundings predict, places people here love versus the city's, and a gap score on "
                           "the same scale as the table. At most 3 per survey.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "A specific storefront category, e.g. bookstore, bicycle repair, gym, florist or bakery"},
                    "reason": REASON,
                },
                "required": ["category", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fan_taste",
            "description": "Live Qloo cross-domain check: brands and artists that people who love a category also love "
                           "(its audience at large, biased to this area), which of them belong to this area's signature "
                           "taste, and whether Qloo ignores the category as a signal here.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "A genre from the gap table or a tested category"},
                    "reason": REASON,
                },
                "required": ["category", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inspect_gap",
            "description": "Competitors inside the area (with what reviews know them for and complain about) and "
                           "the favorite places of people here of one genre, plus what those favorites offer (menu, "
                           "offerings, amenities and what reviews mention).",
            "parameters": {
                "type": "object",
                "properties": {
                    "genre": {"type": "string", "description": "Genre exactly as written in the gap table or a test result"},
                    "reason": REASON,
                },
                "required": ["genre", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_concepts",
            "description": "Submit the final 3 concepts, and the wildcard when the evidence has a wildcard_candidate.",
            "parameters": {
                "type": "object",
                "properties": {
                    "concepts": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "description": "A memorable venue name"},
                                "genre": {"type": "string", "description": "Genre exactly as written in the gap table or a test result"},
                                "one_liner": {"type": "string", "description": "The positioning: what it is and how it differs from the competitors inside the area"},
                                "signature": {"type": "array", "items": {"type": "string"},
                                              "description": "3-4 short items (2-6 words each): dishes, drinks or experiences "
                                                             "people would come for; never the room, seating or mood"},
                                "inspired_by": {"type": "array", "items": {"type": "string"}},
                            },
                            "required": ["name", "genre", "one_liner", "signature"],
                        },
                    },
                    "wildcard": {
                        "type": "object",
                        "description": "Only with a wildcard_candidate: one business combining exactly its two loves",
                        "properties": {
                            "name": {"type": "string", "description": "A memorable venue name"},
                            "one_liner": {"type": "string", "description": "What it is: the two loves in one storefront"},
                            "signature": {"type": "array", "items": {"type": "string"},
                                          "description": "3-4 short items, drawn from the candidate's loved_items"},
                        },
                    },
                },
                "required": ["concepts"],
            },
        },
    },
]


AGENT_VERSION = fingerprint(CONCEPT_SYSTEM, CONCEPT_TOOLS, MAX_LIVE_TESTS, MAX_FAN_CHECKS)


@dataclass
class AgentResult:
    concepts: list[dict]
    raw_concepts: list[dict]
    model: str | None
    trail: list[list]  # replayable record of what the agent did: [event, data] pairs
    raw_wildcard: dict | None = None  # the model's name, one-liner and signature for the wildcard, as it sent them
    notes: list[str] = field(default_factory=list)  # what the owner's rules repaired or dropped, in plain words


async def agent_concepts(llm: LLM, q: QlooClient, run: RunState, emit: Emit) -> AgentResult:
    trail: list[list] = []
    testing: dict[str, asyncio.Future] = {}  # genre id -> live measurement, shared by concurrent calls
    announced: set[tuple[str, str]] = set()
    results: dict[tuple[str, str], asyncio.Future] = {}
    fan_checks = 0

    def call_key(name: str, args: dict) -> tuple[str, str]:
        return name, str(args.get("category") or args.get("genre") or "").strip().lower()

    async def record(event: str, data: dict) -> None:
        trail.append([event, data])
        await emit(event, data)

    async def refuse(message: str) -> dict:
        await record("finding", {"text": message})
        return {"error": message}

    async def inspect(args: dict) -> dict:
        row = gap_for(run, str(args.get("genre") or ""))
        return inspect_payload(run, row) if row else {"error": "Unknown genre. Use one from the gap table or a test result."}

    async def resolve(query: str) -> tuple[dict | None, str | None]:
        row = gap_for(run, query)
        if row:
            return {"id": row["genre_id"], "name": row["genre"]}, None
        return await engine.find_genre(q, run.genres, query)

    async def measure(genre: dict) -> dict:
        row = annotate(run, await engine.probe_genre(q, run.catchment, genre, run.gaps, run.site.ages))
        row["source"] = "agent"
        run.explored.append(row)
        trail.append(["explored", {"genre": genre}])
        await emit("explored", {"row": public_gap(row)})
        if not fits(row):
            await record("finding", {"text": f"{row['genre']} does not fit this unit: it {row['fit']['reason']}."})
        return row

    async def test_category(args: dict) -> dict:
        query = str(args.get("category") or "").strip()[:80]
        try:
            genre, why_not = await engine.find_genre(q, run.genres, query) if query else (None, "No category given.")
        except QlooError as exc:
            return await refuse(f"Qloo lookup for '{query}' failed: {exc}")
        if not genre:
            return await refuse(why_not or f"Qloo has no storefront category matching '{query}'.")
        if genre["id"] not in testing:
            existing = gap_for(run, genre["name"])
            if existing:
                await record("finding", {"text": f"{existing['genre']} is already in the gap table (gap {existing['gap_score']})."})
                return {"already_measured": True, **gap_summary(existing, run.site.area, run.site.ages)}
            if not scoring.matches_focus(genre["name"], run.site.focus):
                return await refuse(f"{genre['name']} is outside the owner's focus.")
            if len(testing) >= MAX_LIVE_TESTS:
                return await refuse(f"Live test budget used ({MAX_LIVE_TESTS} per survey).")
            testing[genre["id"]] = asyncio.ensure_future(measure(genre))
        try:
            row = await asyncio.shield(testing[genre["id"]])
        except QlooError as exc:
            return await refuse(f"Qloo test of {genre['name']} failed: {exc}")
        area, ages = run.site.area, run.site.ages
        return {"tested_live": True, **gap_summary(row, area, ages), "evidence": gap_evidence(row, area, ages)}

    async def fan_taste(args: dict) -> dict:
        nonlocal fan_checks
        query = str(args.get("category") or "").strip()[:80]
        if fan_checks >= MAX_FAN_CHECKS:
            return await refuse(f"Fan taste budget used ({MAX_FAN_CHECKS} per survey).")
        fan_checks += 1
        try:
            genre, why_not = await resolve(query) if query else (None, "No category given.")
            if not genre:
                return await refuse(why_not or f"Qloo has no storefront category matching '{query}'.")
            fans = await fans_of(q, run, genre["id"])
        except QlooError as exc:
            return await refuse(f"Qloo fan taste for '{query}' failed: {exc}")
        if not fans.get("specific"):
            await record("finding", {"text": (
                f"Qloo ranks people who love {genre['name']} like everyone near the site, so their taste says nothing "
                "specific about the category here."
            )})
            return {"category": genre["name"], "specific": False,
                    "note": "Qloo ignores this category as a signal here; this is no evidence for or against it."}
        brands = [b["name"] for b in fans["brands"]]
        artists = [a["name"] for a in fans["artists"]]
        signature = {e["name"] for e in run.taste.get("distinctive_brands", []) + run.taste.get("distinctive_artists", [])}
        shared = [name for name in brands + artists if name in signature]
        text = f"People who love {genre['name']} also love {', '.join(brands[:4]) or 'no brands Qloo knows'}"
        text += f"; artists {', '.join(artists[:3])}" if artists else ""
        text = text.rstrip(".") + "."
        if shared:
            text += f" Shared with this area's signature taste: {', '.join(shared)}".rstrip(".") + "."
        await record("finding", {"text": text})
        return {"category": genre["name"], "specific": True,
                "people_who_love_it_also_love": {"brands": brands, "artists": artists},
                "shared_with_area_signature": shared,
                "note": "These are the category's audience at large, not only people here; overlap with the area's "
                        "signature taste is the evidence of fit."}

    async def on_call(name: str, args: dict, thought: str | None) -> None:
        if name == "submit_concepts":
            return
        key = call_key(name, args)
        if key in announced:  # a repeated check adds nothing new to the log
            return
        announced.add(key)
        await record("agent", {"tool": name, "args": args, "thought": thought})

    def once(name: str, handler: Callable[[dict], Awaitable[dict]]) -> Callable[[dict], Awaitable[dict]]:
        """Runs each distinct check once; a repeat gets the earlier result back, saying so."""
        async def checked(args: dict) -> dict:
            key = call_key(name, args)
            if key in results:
                result = await asyncio.shield(results[key])
                return {**result, "note": "You already ran this check in this survey; this is the same result."}
            results[key] = asyncio.ensure_future(handler(args))
            return await asyncio.shield(results[key])
        return checked

    async def on_step(step: int, phase: str) -> None:
        label = "Agent reads the evidence and plans what to check" if step == 0 else "Agent weighs what it found"
        state = {"start": "running", "end": "done"}.get(phase, phase)
        await emit("status", {"step": f"agent-{step}", "state": state, "label": label})

    waits = 0

    async def on_wait(seconds: float, phase: str) -> None:
        nonlocal waits
        if phase == "start":
            waits += 1
        await emit("status", {
            "step": f"agent-wait-{waits}", "state": "running" if phase == "start" else "done",
            "label": f"Free AI quota refills in {max(1, round(seconds))} s; the agent waits",
        })

    result, model = await llm.run_tools(
        CONCEPT_SYSTEM,
        "Evidence pack:\n" + compact_json(agent_brief(run)),
        CONCEPT_TOOLS,
        {
            "inspect_gap": once("inspect_gap", inspect),
            "test_category": once("test_category", test_category),
            "fan_taste": once("fan_taste", fan_taste),
        },
        final_tool="submit_concepts",
        max_steps=6,
        on_call=on_call,
        on_step=on_step,
        on_wait=on_wait,
    )
    raw = [c for c in submitted(result, "concepts") or [] if isinstance(c, dict)]
    wildcard = submitted(result, "wildcard")
    log.info("Agent %s submitted %s", model, [(c.get("name"), c.get("genre")) for c in raw] if result else "nothing")
    notes: list[str] = [] if raw else ["The agent submitted no concepts, so the evidence rules designed them."]
    concepts = clean_concepts(run, copy.deepcopy(raw), notes)
    return AgentResult(concepts, raw, model, trail, wildcard if isinstance(wildcard, dict) else None, notes)


def submitted(result: dict | None, key: str) -> object:
    """A field of the agent's submission; some models send a list or an object as a JSON string, which is read too."""
    value = (result or {}).get(key)
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    return value


async def replay_agent(
    q: QlooClient, run: RunState, saved: dict, emit: Emit, notes: list[str] | None = None,
) -> list[dict]:
    """Re-emits a saved investigation for identical evidence; live tests are re-measured from the Qloo cache."""
    for event, data in saved.get("trail", []):
        if event == "explored":
            row = annotate(run, await engine.probe_genre(q, run.catchment, data["genre"], run.gaps, run.site.ages))
            row["source"] = "agent"
            run.explored.append(row)
            await emit("explored", {"row": public_gap(row)})
        else:
            await emit(event, data)
    return clean_concepts(run, copy.deepcopy(saved.get("raw_concepts", [])), notes)


async def concepts_from_agent(
    llm: LLM, q: QlooClient, run: RunState, emit: Emit, answers: AnswerCache | None,
) -> tuple[list[dict], dict]:
    """The agent's concepts and how they were made; an empty list means the evidence rules must step in.

    The ranked concepts come first, then the wildcard when the evidence supports one. `notes` in the second value says,
    in plain words, what was repaired, replaced or dropped, the owner's rules first among the reasons."""
    key = fingerprint("concepts", AGENT_VERSION, agent_brief(run))
    saved = answers.get("concepts", key) if answers else None
    notes: list[str] = []
    try:
        if saved:
            await emit("replay", {"saved_at": saved.get("saved_at"), "model": saved.get("model")})
            concepts = await replay_agent(q, run, saved, emit, notes)
            ranked = requested_first(run, strong_enough(run, concepts, notes))
            about = {"model": saved.get("model"), "replayed_from": saved.get("saved_at")}
            return with_wildcard(run, ranked, saved.get("raw_wildcard"), notes), with_notes(about, notes)
        result = await agent_concepts(llm, q, run, emit)
    except LLMUnavailable:
        log.warning("Every LLM model is resting; falling back to evidence rules", exc_info=True)
        await emit("notice", {"message": "Every free AI model is busy or out of quota right now, so these concepts come from the evidence rules."})
        return [], {}
    except Exception as exc:  # LLM outages must not break the demo
        log.warning("Concept agent failed; falling back to evidence rules", exc_info=True)
        await emit("notice", {"message": f"The AI agent failed ({type(exc).__name__}), so these concepts come from the evidence rules."})
        return [], {}
    if result.concepts and answers:
        answers.put("concepts", key, {"trail": result.trail, "raw_concepts": result.raw_concepts, "model": result.model,
                                      "raw_wildcard": result.raw_wildcard})
    notes = result.notes
    ranked = requested_first(run, strong_enough(run, result.concepts, notes))
    return with_wildcard(run, ranked, result.raw_wildcard, notes), with_notes({"model": result.model}, notes)


def with_notes(about: dict, notes: list[str]) -> dict:
    """The concepts payload's extras, with what was repaired, replaced or dropped when anything was."""
    return {**about, "notes": list(dict.fromkeys(notes))} if notes else about
