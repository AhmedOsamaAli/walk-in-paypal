"""The launch kit: ad copy checked line by line, one retry then rules, the poster and the tracked links."""
from __future__ import annotations

import asyncio
import copy
import json
import re

from app import scoring
from app.catchment import Catchment
from app.llm import LLM
from app.survey import constraints, kit
from app.survey.concepts import rule_concept
from app.survey.design import design_concept
from app.survey.evidence import annotate, gap_for
from app.survey.models import RunState, Site
from tests.fakes import GENRES, place

SITE = (30.26, -97.72)
# The walk as the catchment stores it, (lon, lat), closed.
RING = [(-97.725, 30.26), (-97.72, 30.265), (-97.715, 30.26), (-97.72, 30.255), (-97.725, 30.26)]
TAGS = {
    "crowd": "urn:tag:customer_identity:qloo",
    "time": "urn:tag:time_of_day_fit:qloo",
    "intent": "urn:tag:visit_intent:qloo",
    "menu": "urn:tag:menu_highlight:qloo",
}


def bakery(name: str, index: int, level: int, north: float, *, website: str | None = None, keywords: list | None = None,
           hood: str | None = None, **tags: list[str]) -> dict:
    entity = place(name, "Bakery", SITE[0] + north, SITE[1], index)
    props = entity["properties"]
    props["price_level"] = level
    if website:
        props["website"] = website
    if keywords is not None:
        props["keywords"] = keywords
    if hood:
        props["neighborhood"] = hood
    for family, labels in tags.items():
        entity["tags"] += [{"id": f"{TAGS[family]}:{label.lower()}", "name": label, "type": TAGS[family]} for label in labels]
    return entity


# Loved bakeries 2–3 km north, outside the walk; two of them charge $$$ and are known for kouign amann.
LOVED = [
    bakery("Crumb", 1, 3, 0.020, website="https://crumb.example/", crowd=["Families", "Couples"], time=["Morning"],
           intent=["Routine visit"], menu=["Kouign amann"]),
    bakery("Rise", 2, 3, 0.025, website="https://rise.example/", crowd=["Families", "Couples"], time=["Morning", "Midday"],
           intent=["Routine visit"], menu=["Kouign amann"]),
    bakery("Proof", 3, 2, 0.030, crowd=["Families"], time=["Morning"], intent=["Destination"]),
]
# Two $ bakeries inside the walk, whose reviews complain about waits, rude staff and dirty tables.
INSIDE = [
    bakery("Corner Loaf", 4, 1, 0.001, hood="Holly", keywords=[
        {"name": "long wait", "count": 7}, {"name": "rude staff", "count": 3}, {"name": "sourdough", "count": 9}]),
    bakery("Dawn Rolls", 8, 1, 0.002, hood="Holly", keywords=[
        {"name": "long lines", "count": 4}, {"name": "dirty tables", "count": 2}]),
]


def blank_row(genre: str, score: int, rank: int, **fields) -> dict:
    row = {
        "genre": genre, "genre_id": GENRES.get(genre, f"urn:tag:genre:place:test_{genre.lower().replace(' ', '_')}"),
        "demand_rank": rank, "ref_rank": rank + 1.0, "lift": 0.1, "nearby_count": 6, "nearby_capped": False,
        "around_count": 30, "around_capped": False, "expected_nearby": 6.0, "relative_supply": 1.0,
        "favorites_kind": "citywide", "favorites_total": 0, "favorites_far": 0, "median_favorite_km": None,
        "median_far_km": None, "leakage": None, "evidence": "ok", "storefront_share": 1.0, "gap_score": score,
        "_favorite_entities": [], "favorites": [], "_nearby_entities": [], "competitors": [], "city_favorites": [],
    }
    return {**row, **fields}


def bakery_row(loved: list[dict], inside: list[dict], **fields) -> dict:
    measured = {
        "ref_rank": 14.5, "lift": 0.85, "nearby_count": len(inside), "around_count": 18, "expected_nearby": 5.2,
        "relative_supply": 0.41, "favorites_kind": "local", "favorites_total": 3, "favorites_far": 3,
        "median_favorite_km": 2.8, "median_far_km": 2.8, "leakage": 0.8, "_favorite_entities": loved,
        "favorites": [{**scoring.place_card(e, SITE), "within_walk": False} for e in loved],
        "_nearby_entities": inside, "competitors": [scoring.place_card(e, SITE) for e in inside],
    }
    return blank_row("Bakery", 64, 6, **{**measured, **fields})


def world(notes: str = "no alcohol", size_m2: float | None = 60, verdict: bool = False, **row_fields) -> RunState:
    """A survey of an Austin corner: a bakery gap with every kind of claim, beside six other categories."""
    site = Site(*SITE, "Test Corner, Austin", notes=notes, size_m2=size_m2, intent="open" if verdict else "explore",
                business="bakery" if verdict else "")
    run = RunState(id="kit", site=site, constraints=constraints.parse(notes))
    run.catchment = Catchment(*SITE, 10, "street network", RING)
    loved, inside = copy.deepcopy(LOVED), copy.deepcopy(INSIDE)
    others = [
        place("Patio Tacos", "Tex-Mex", SITE[0] - 0.001, SITE[1], 5),
        place("Cuvee Coffee", "Coffee shop", SITE[0], SITE[1] + 0.001, 6),
        place("Holly Hardware", "Hardware store", SITE[0] - 0.002, SITE[1], 7),
    ]
    for entity, hood in zip(others, ("East Cesar Chavez", "Holly", "East Cesar Chavez"), strict=True):
        entity["properties"]["neighborhood"] = hood
    run.block = inside + others
    run.taste = {
        "artists": [{"name": "Global Pop Star"}], "brands": [{"name": "Global Coffee"}],
        "distinctive_artists": [{"name": "Gary Clark Jr."}, {"name": "Mobley"}],
        "distinctive_podcasts": [{"name": "Stassi"}],
        "distinctive_brands": [{"name": "Patagonia", "kind": "retail"}],
        "distinctive_tv": [{"name": "Pier Pressure", "year": 2021}],
        "distinctive_movies": [{"name": "Harbor Lights", "year": 1998}],
    }
    rows = [
        blank_row("Wine Bar", 71, 3),  # the strongest gap, ruled out by the owner's notes
        bakery_row(loved, inside, **row_fields),
        blank_row("Coffee shop", 58, 4), blank_row("Brunch", 50, 2), blank_row("Japanese", 40, 7),
        blank_row("Ramen", 30, 9), blank_row("Gift shop", 20, 12),
        blank_row("Yoga studio", 45, 15, evidence="thin", around_count=1),
    ]
    run.gaps = [annotate(run, row) for row in rows]
    bakery_gap = gap_for(run, "Bakery")
    run.concepts = [{**rule_concept(run, bakery_gap), "name": "Golden Hour", "signature": ["Kouign amann", "Rye loaf"]}]
    if verdict:
        run.verdict = {"query": "bakery", "found": True, "genre": "Bakery", "genre_id": bakery_gap["genre_id"],
                       "level": "strong", "headline": "Bakery is one of the strongest gaps here: #2 of 8 categories measured.",
                       "position": 2, "of": 8, "gap_score": 64}
    return run


def sheet(run: RunState, index: int = 0) -> dict:
    return asyncio.run(design_concept(run, index))


def build(run: RunState, design: dict, llm=None, answers=None) -> dict:
    return asyncio.run(kit.build_kit(llm or LLM("", None, "test-model"), run, 0, design, answers))


def facts_of(run: RunState, design: dict, claims: list[dict] | None = None) -> kit.Facts:
    concept = run.concepts[0]
    name = kit.business_name(run, concept, design)
    return kit.facts_for(run, concept, design, name, kit.usable_claims(concept, design)[0] if claims is None else claims)


def test_clipped_model_copy_is_rejected_at_source_before_it_can_reach_any_kit_surface():
    run = world()
    facts = facts_of(run, sheet(run))
    for text in ("Enjoy coffee and freshly", "Rye loaf with", "Made for the", "Butter croissants..."):
        assert any("ends mid-sentence" in reason for reason in facts.check(text)), text
    kept, rejected, _ = kit.check_answer(
        {"poster": {"headline": "Rye loaf", "subline": "Enjoy coffee and freshly", "claims": []}},
        ["poster"], facts, set(),
    )
    assert "subline" not in kept["poster"]["fields"]
    assert rejected[0]["field"] == "subline" and "ends mid-sentence" in rejected[0]["reasons"][0]
    assert facts.check("Rye loaf and kouign amann.") == []


def assert_valid(ads: dict, facts: kit.Facts) -> None:
    """Every line within its limits and past every check; lists within their sizes."""
    for key, pieced in ads.items():
        for field, spec in kit.FORMATS[key].items():
            value = pieced[field]
            lines = value if isinstance(value, list) else [value]
            if "min" in spec:
                assert spec["min"] <= len(lines) <= spec["max"], (key, field, lines)
            for line in lines:
                assert line and not facts.check(line, **kit.limits(spec)), (key, field, line, facts.check(line, **kit.limits(spec)))


class ScriptedLLM:
    """Answers the copy prompt from a script; an exception in the script is raised instead."""

    enabled = True

    def __init__(self, *replies) -> None:
        self.replies = list(replies)
        self.prompts: list[str] = []

    async def complete_json(self, system: str, user: str):
        self.prompts.append(user)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply, "test-model"


GOOD = {
    "spotify": {"script": "Golden Hour is a new bakery in Holly, with kouign amann no bakery that close is known for. "
                          "Book ahead, or be served fast at the counter. Golden Hour, Holly. Walk in.",
                "companion": "Golden Hour, Holly", "claims": ["new", "promise"]},
    "nextdoor": {"headline": "Bakery without crossing town",
                 "body": "Hi neighbors! Golden Hour bakes kouign amann, which no bakery within a 10-minute walk is known "
                         "for. Book ahead, or be served fast at the counter.",
                 "claims": ["closer", "new", "promise"]},
    "google_search": {
        "headlines": ["Golden Hour", "Kouign amann in Holly", "Bakery without crossing town", "Book ahead or walk in",
                      "New bakery in Holly", "Morning pastries in Holly", "Open Mon–Thu 11 am–10 pm",
                      "A short walk from home", "Rye loaf, baked daily"],
        "descriptions": ["Golden Hour bakes kouign amann in Holly.", "Kouign amann no bakery nearby is known for.",
                         "Bakery without crossing town: a short walk from home.", "Book ahead, or be served fast."],
        "claims": ["new", "closer", "promise"]},
    "meta": {"primary_text": "Golden Hour is a new bakery in Holly. Come for the kouign amann.",
             "headline": "Golden Hour, new in Holly", "description": "A short walk from home", "claims": ["new"]},
    "poster": {"headline": "Bakery without crossing town",
               "subline": "Kouign amann, which no bakery within a 10-minute walk is known for.",
               "claims": ["closer", "new"]},
}
# The claim a walk with no bakery inside it makes (launch.claims), for the checks of what "only" may say.
ONLY = {"id": "only", "kind": "only", "line": "The only bakery within a 10-minute walk",
        "proof": "Qloo lists no bakery inside the walk, and OpenStreetMap shows none either."}
# Every line breaks a rule: a superlative, a competitor, a fan base, a web address, a stray number, a length, a show.
BAD = {
    "spotify": {"script": "The best bakery in Austin, for every Mobley fan.", "companion": "Better than Corner Loaf"},
    "nextdoor": {"headline": "Austin's #1 bakery", "body": "Visit goldenhour.com for 20% off."},
    "google_search": {"headlines": ["Famous kouign amann", "Since 2019"], "descriptions": ["Award-winning pastries."]},
    "meta": {"primary_text": "Cheapest croissants in town.", "headline": "A bakery for the whole neighborhood of Holly",
             "description": "Open 24/7"},
    "poster": {"headline": "Pier Pressure nights", "subline": "Like Patagonia, but for bread."},
}


def test_each_kind_of_violation_is_caught():
    run = world()
    run.block.append(place("Joe's Bakery", "Bakery", SITE[0], SITE[1] - 0.001, 9))
    facts = facts_of(run, sheet(run))

    def why(text: str, **limits) -> str:
        return " | ".join(facts.check(text, **limits))

    assert why("x" * 41, chars=40) == "over 40 characters (41)"
    assert why("word " * 76, words=75) == "over 75 words (76)"
    assert "names Corner Loaf, a place near the site" in why("Shorter lines than Corner Loaf")  # a competitor
    assert "names Patio Tacos" in why("Grab a pastry after Patio Tacos")  # any place on the block
    assert "names Joe's Bakery" in why("Fresher than Joe's bakery")  # 'bakery' is the concept's word, the name is not
    assert "names Holly Hardware" in why("Next to Holly Hardware")  # so is the neighborhood's
    assert "names Crumb" in why("As good as Crumb, and closer")  # a place locals love, named
    assert why("Crumb by crumb, a better morning") == ""  # the same word, not used as a name
    for name in ("Gary Clark Jr.", "Stassi", "Pier Pressure", "Patagonia"):
        assert f"names {name}, from the audience" in why(f"Made for {name} people"), name
    assert "states 5, a number" in why("5 minutes from your door")
    assert "states 2019" in why("Baking since 2019")
    assert why("Ten minutes from your door") == ""  # the walk's own minutes, in words
    assert why("Open Fri–Sat until 11:30 pm") == ""  # the hours
    assert "states a price" in why("The only $$$ bakery within a 10-minute walk")  # a price level is a price too
    for line in ("The best kouign amann in Austin", "Austin's #1 bakery", "Award-winning pastries", "Famous rye",
                 "The most loved bakery on the block", "Top-rated bread"):
        assert "is a superlative nothing proves" in why(line), line
    for line, word in (("A cozy corner for your morning", "cozy"), ("Good vibes and better bread", "vibes"),
                       ("A curated pastry case", "curated")):
        assert f'"{word}" is filler nothing measured backs' in why(line), line
    assert "a web address" in why("Order at goldenhour.com")
    assert "a symbol a voice cannot read" in why("The only $$$ bakery", spoken=True)
    assert "the owner's notes rule out" in why("Mimosas on Sundays")  # the notes say no alcohol
    without_only = facts_of(run, sheet(run), claims=[])
    assert 'says "only" without an "only" claim' in " ".join(without_only.check("The only bakery on your block"))
    assert "states 12" in why("Within a 12-minute walk")


def test_the_business_name_and_menu_are_its_own_words():
    run = world()
    design = {**sheet(run), "name": "Studio 54 Bakery", "offer": ["Crumb cake", "Rye loaf"]}
    facts = facts_of(run, design)
    assert facts.check("Studio 54 Bakery opens in Holly") == []  # a number in the name is the name's
    assert facts.check("Rye loaf and kouign amann, every morning") == []
    assert facts.check("Try our Crumb cake") == []  # 'Crumb' inside its own menu item is not the place Crumb
    assert facts.check("As good as Crumb") != []
    # A name that reuses a real place's name is not used: the concept's own, checked name is.
    assert kit.business_name(run, run.concepts[0], {**design, "name": "Corner Loaf"}) == "Golden Hour"


def answer_with(channel: str, field: str, text: str) -> dict:
    """The good answer with one line replaced."""
    answer = copy.deepcopy(GOOD)
    answer[channel][field] = text
    return answer


def reasons(facts: kit.Facts, text: str) -> str:
    return " | ".join(facts.check(text))


def test_possessive_names_are_still_names():
    run = world()
    design = sheet(run)
    facts = facts_of(run, design)
    for line, name in (("Skip Corner Loaf's long lines", "Corner Loaf"), ("Skip Corner Loaf’s long lines", "Corner Loaf"),
                       ("Like Crumb's kouign amann, on your block", "Crumb"), ("Mobley's favorite morning stop", "Mobley")):
        assert f"names {name}" in reasons(facts, line), line
    result = build(run, design, ScriptedLLM(answer_with("nextdoor", "headline", "Skip Corner Loaf's long lines"), GOOD))
    assert result["copy"]["nextdoor"]["headline"] == GOOD["nextdoor"]["headline"]
    assert [r["text"] for r in result["rejected"]] == ["Skip Corner Loaf's long lines"]


def test_one_word_names_count_wherever_they_stand_unless_they_are_plain_words():
    run = world()
    design = sheet(run)
    facts = facts_of(run, design)
    for line, name in (("Patagonia fans, meet Golden Hour.", "Patagonia"), ("Mobley fans: your new bakery is here.", "Mobley"),
                       ("Golden Hour - Patagonia style", "Patagonia"), ("Made for stassi listeners", "Stassi"),
                       ("Mornings (Mobley on the speakers)", "Mobley")):
        assert f"names {name}, from the audience" in reasons(facts, line), line
    # Crumb, Rise and Proof are places nearby, and plain words too: they count only written as names.
    for line in ("Crumb by crumb, a better morning", "Rise and shine: Golden Hour is open", "Proof that mornings matter"):
        assert facts.check(line) == [], line
    assert "names Rise" in reasons(facts, "Closer than Rise")
    assert "names Crumb" in reasons(facts, "Crumb's kouign amann, on your block")  # a possessive is a name
    result = build(run, design, ScriptedLLM(answer_with("meta", "headline", "Patagonia fans, meet Golden Hour"), GOOD))
    assert result["copy"]["meta"]["headline"] == GOOD["meta"]["headline"]
    assert [r["text"] for r in result["rejected"]] == ["Patagonia fans, meet Golden Hour"]


def test_model_written_menu_items_keep_the_rules_before_they_count_as_the_business_s_own():
    run = world()
    design = {**sheet(run), "offer": ["Espresso from Cuvee Coffee", "Award-winning sourdough", "Top 12 pastries", "Rye loaf"]}
    facts = facts_of(run, design)
    assert "names Cuvee Coffee" in reasons(facts, "Espresso from Cuvee Coffee, every morning")
    assert "is a superlative nothing proves" in reasons(facts, "Try our award-winning sourdough")
    assert "states 12" in reasons(facts, "Top 12 pastries every morning")
    llm = ScriptedLLM(GOOD)
    result = build(run, design, llm)
    assert json.loads(llm.prompts[0])["business"]["menu"] == ["Rye loaf", "Kouign amann"]  # the model sees only these
    left_out = [note.split('"')[1] for note in result["notes"] if note.startswith("Left out the menu item")]
    assert left_out == ["Espresso from Cuvee Coffee", "Award-winning sourdough", "Top 12 pastries"]


def test_prices_quantities_and_offers_are_not_the_ads_to_make():
    run = world()
    design = sheet(run)
    facts = facts_of(run, design)
    for line in ("Kouign amann from $2", "Rye loaf, $3 a slice", "A rye loaf for 3 dollars", "Coffee for two bucks",
                 "Golden Hour, a $$ bakery in Holly"):
        assert "states a price" in reasons(facts, line), line
    for line, word in (("Loved by thousands of neighbors", "thousands"), ("Hundreds of neighbors already walk here", "Hundreds"),
                       ("Dozens of pastries every morning", "Dozens"), ("A million mornings start here", "million")):
        assert f"states {word}, a number" in reasons(facts, line), line
    for line in ("Free coffee for every neighbor on opening day", "Half price on Mondays", "Two for one on Fridays",
                 "Two croissants, one price: half off"):
        assert "promises a discount" in reasons(facts, line), line
    result = build(run, design, ScriptedLLM(answer_with("poster", "subline", "Kouign amann from $2, every morning."), GOOD))
    assert result["copy"]["poster"]["subline"] == GOOD["poster"]["subline"]


def test_only_keeps_to_what_the_only_claim_proves():
    run = world()
    design = sheet(run)
    facts = facts_of(run, design, claims=[ONLY])
    for line in ("The only bakery in Austin open past midnight", "Golden Hour: the only bakery in Holly",
                 "The only bakery within a 10-minute walk, and the only one open late", "Only here: kouign amann",
                 "No other bakery on your block bakes like this"):
        assert 'beyond what the "only" claim proves' in reasons(facts, line), line
    for line in ("The only bakery within a 10-minute walk", "It is the only bakery within a ten-minute walk.",
                 "Golden Hour is the only bakery within a 10 minute walk. Come say hello."):
        assert facts.check(line) == [], line
    no_claim = facts_of(run, design, claims=[])
    for line, said in (("No other bakery on your block bakes like this", "no other"), ("Nowhere else on the block", "nowhere else"),
                       ("The sole bakery on your block", "the sole"), ("Exclusive pastries, every morning", "exclusive"),
                       ("The one place for kouign amann", "the one place")):
        assert f'says "{said}" without an "only" claim' in reasons(no_claim, line), line
    assert no_claim.check("Grilled Dover sole on Fridays") == []  # the fish claims nothing
    body = f'{GOOD["nextdoor"]["body"]} The only bakery in Austin open late.'
    result = build(run, design, ScriptedLLM(answer_with("nextdoor", "body", body), GOOD))
    assert result["copy"]["nextdoor"]["body"] == GOOD["nextdoor"]["body"]


def test_a_place_named_with_a_category_word_takes_the_name():
    run = world()
    run.block.append(place("Golden Hour Bakery", "Bakery", SITE[0], SITE[1] - 0.001, 9))
    design = sheet(run)
    concept = run.concepts[0]
    # The sheet's name and the concept's are both 'Golden Hour', taken: the sign says what the business is instead.
    assert kit.business_name(run, concept, design) == "Bakery"
    assert kit.business_name(run, concept, {**design, "name": "Golden Hour Cafe"}) == "Bakery"
    assert kit.business_name(run, concept, {**design, "name": "Golden"}) == "Golden"  # shorter is not the same name
    assert kit.business_name(run, concept, {**design, "name": "Sunbeam"}) == "Sunbeam"
    assert build(run, design)["poster"]["name"] == "Bakery"


def test_a_wildcard_concept_says_plainly_that_it_is_untested():
    run = world()
    run.concepts[0]["wildcard"] = True
    note = build(run, sheet(run))["notes"][0]
    assert note.startswith("Untested") and "no place like it exists nearby" in note and "no direct proof of demand" in note
    plain = world()
    assert not any("no direct proof of demand" in note for note in build(plain, sheet(plain))["notes"])


def test_rules_write_every_channel_within_its_limits():
    run = world()
    design = sheet(run)
    result = build(run, design)
    assert result["mode"] == "rules" and result["model"] is None and result["rejected"] == []
    ads = result["copy"]
    assert list(ads) == ["spotify", "nextdoor", "google_search", "meta", "poster"]
    assert_valid(ads, facts_of(run, design))
    ids = {c["id"] for c in result["claims"]}
    assert ids == {"new", "closer", "promise"}  # two bakeries inside the walk: no 'only'
    assert all(set(p["claims"]) <= ids and p["source"] == "rules" for p in ads.values())
    spotify = ads["spotify"]
    assert spotify["words"] <= 75 and spotify["seconds"] == round(spotify["words"] / 2.5)
    assert "Gary Clark" not in spotify["script"] and "$" not in spotify["script"]
    assert "without crossing town" not in spotify["script"]  # the city hears it, not just the walk
    assert ads["nextdoor"]["headline"] == "Golden Hour: a new bakery close by"
    assert "Holly" in ads["nextdoor"]["body"] and "Corner Loaf" not in ads["nextdoor"]["body"]
    assert len(ads["google_search"]["headlines"]) >= 8 and len(ads["google_search"]["descriptions"]) == 4
    assert not any("$" in line for line in ads["google_search"]["headlines"] + ads["google_search"]["descriptions"])
    assert ads["poster"]["claims"] == ["new", "closer"]


def test_rules_copy_stays_valid_with_no_claims_hours_or_neighborhoods():
    run = world()
    for entity in run.block:
        entity["properties"].pop("neighborhood", None)
    design = sheet(run)
    design["hours"] = None
    design["launch"] = {**design["launch"], "claims": [], "where": {**design["launch"]["where"], "neighborhoods": []}}
    design["launch"]["channels"].append({"channel": "Nextdoor", "setting": "Neighborhoods: none.", "why": "test"})
    result = build(run, design)
    assert result["claims"] == []
    ads = result["copy"]
    assert set(ads) == {"spotify", "nextdoor", "google_search", "meta", "poster"}
    assert_valid(ads, facts_of(run, design))
    assert all(piece["claims"] == [] for piece in ads.values())
    assert not any(re.search(r"\bonly\b", line, re.IGNORECASE) for line in kit_lines(ads))


def kit_lines(ads: dict) -> list[str]:
    return [line for piece in ads.values() for key, value in piece.items() if key in {f for spec in kit.FORMATS.values() for f in spec}
            for line in (value if isinstance(value, list) else [value])]


def test_a_rule_breaking_answer_gets_one_retry_with_the_reasons():
    run = world()
    design = sheet(run)
    llm = ScriptedLLM(BAD, GOOD)
    result = build(run, design, llm)
    assert len(llm.prompts) == 2
    retry = llm.prompts[1]
    assert '"best" is a superlative nothing proves' in retry and "Better than Corner Loaf" in retry
    assert "names Corner Loaf, a place near the site" in retry and "google_search.headlines: 0 usable lines, 8 needed" in retry
    assert result["mode"] == "agent" and result["model"] == "test-model"
    ads = result["copy"]
    assert ads["nextdoor"]["headline"] == GOOD["nextdoor"]["headline"]
    assert ads["google_search"]["headlines"] == GOOD["google_search"]["headlines"]
    assert ads["spotify"]["claims"] == ["new", "promise"] and ads["spotify"]["source"] == "agent"
    assert_valid(ads, facts_of(run, design))
    assert {r["attempt"] for r in result["rejected"]} == {1}
    assert len(result["rejected"]) == 12  # every line of the first answer


def test_two_rule_breaking_answers_fall_back_to_rules():
    run = world()
    design = sheet(run)
    llm = ScriptedLLM(BAD, BAD)
    result = build(run, design, llm)
    assert len(llm.prompts) == 2  # one retry, never more
    assert result["mode"] == "rules" and result["model"] is None
    assert result["copy"] == build(run, design)["copy"]
    assert {r["attempt"] for r in result["rejected"]} == {1, 2}


def test_a_short_list_is_topped_up_from_the_rules():
    run = world()
    design = sheet(run)
    partial = {key: dict(value) for key, value in GOOD.items()}
    partial["google_search"] = {**GOOD["google_search"], "headlines": GOOD["google_search"]["headlines"][:5]}
    llm = ScriptedLLM(partial, partial)
    result = build(run, design, llm)
    google = result["copy"]["google_search"]
    assert google["headlines"][:5] == GOOD["google_search"]["headlines"][:5] and len(google["headlines"]) == 8
    assert google["source"] == "mixed" and result["copy"]["meta"]["source"] == "agent"
    assert result["mode"] == "agent"
    assert_valid(result["copy"], facts_of(run, design))


def test_a_model_outage_still_delivers_the_kit():
    run = world()
    design = sheet(run)
    llm = ScriptedLLM(RuntimeError("every model is resting"))
    result = build(run, design, llm)
    assert result["mode"] == "rules" and result["copy"] == build(run, design)["copy"]


class MemoryAnswers:
    """An answer cache in memory, shaped like AnswerCache."""

    def __init__(self) -> None:
        self.saved: dict[tuple[str, str], dict] = {}

    def get(self, kind: str, key: str) -> dict | None:
        return self.saved.get((kind, key))

    def put(self, kind: str, key: str, value: dict) -> None:
        self.saved[(kind, key)] = dict(value)


def test_answers_are_replayed_while_the_evidence_is_unchanged():
    run = world()
    design = sheet(run)
    answers = MemoryAnswers()
    first = build(run, design, ScriptedLLM(GOOD), answers)
    assert [kind for kind, _ in answers.saved] == ["kit"]
    silent = ScriptedLLM()
    again = build(run, design, silent, answers)
    assert silent.prompts == [] and again["copy"] == first["copy"] and again["mode"] == "agent"


def test_a_walk_with_none_of_the_kind_makes_the_only_claim_and_the_poster_leads_with_it():
    run = world(nearby_count=0, _nearby_entities=[], competitors=[])
    result = build(run, sheet(run))
    only = next(c for c in result["claims"] if c["kind"] == "only")
    assert only["line"] == "The only bakery within a 10-minute walk"
    assert only["proof"].startswith("Qloo lists no bakery inside the walk")
    assert result["poster"]["claim"]["kind"] == "only"
    assert_valid(result["copy"], facts_of(run, sheet(run)))


def test_the_poster_is_drawn_from_the_walk():
    run = world()
    design = sheet(run)
    poster = build(run, design)["poster"]
    assert poster["ring"] == [[lat, lon] for lon, lat in RING]  # (lon, lat) stored, [lat, lon] drawn
    assert poster["ring"][0] == poster["ring"][-1] and len(poster["ring"]) == len(RING)
    assert poster["site"] == [30.26, -97.72] and poster["minutes"] == 10
    assert poster["neighborhoods"] == ["Holly", "East Cesar Chavez"]
    assert poster["name"] == "Golden Hour" and poster["hours"] == design["hours"]
    assert poster["claim"]["kind"] == "new" and poster["claim"]["proof"] == (
        "2 of the bakeries locals love are known for it; none inside the walk is.")
    assert poster["headline"] == "Bakery without crossing town"
    assert poster["tagline"] is None  # the sheet's tagline states the evidence's numbers, which a poster does not


def test_links_tag_every_channel_with_the_concept_campaign():
    run = world()
    links = build(run, sheet(run))["links"]
    assert [link["key"] for link in links] == ["spotify", "nextdoor", "google_search", "meta", "poster"]
    assert {link["utm_campaign"] for link in links} == {"golden-hour-launch"}
    google = next(link for link in links if link["key"] == "google_search")
    assert (google["utm_source"], google["utm_medium"]) == ("google", "cpc")
    assert google["query"] == "utm_source=google&utm_medium=cpc&utm_campaign=golden-hour-launch"
    assert kit.campaign("Tide & Table") == "tide-and-table-launch"
    assert kit.campaign("Café Olé!") == "cafe-ole-launch"
    assert kit.campaign("بيت القهوة", "Coffee shop") == "coffee-shop-launch"
    # A sheet that renames the business keeps the concept's campaign, so every regenerated sheet tracks as one launch.
    renamed = build(run, {**sheet(run), "name": "Golden Hour Bakehouse"})
    assert renamed["poster"]["name"] == "Golden Hour Bakehouse"
    assert {link["utm_campaign"] for link in renamed["links"]} == {"golden-hour-launch"}


def test_a_run_without_that_concept_has_no_kit():
    run = world()
    run.concepts = []  # an 'improve' run designs no concept
    try:
        build(run, {})
    except IndexError as error:
        assert "no concept 0" in str(error)
    else:
        raise AssertionError("expected an IndexError")


def test_a_real_survey_gets_a_valid_kit():
    from app.survey import pipeline
    from app.survey.models import RunStore
    from tests.fakes import SITE as FAKE_SITE
    from tests.fakes import FakeQloo, FakeWalker

    q = FakeQloo()

    async def ignore(event: str, data: dict) -> None:
        pass

    async def survey():
        llm = LLM("", None, "test-model")
        run = await pipeline.analyze_site(q, FakeWalker(), llm, RunStore(), Site(*FAKE_SITE, "Test Corner, Testville"), ignore)
        return run, await design_concept(run, 0, q)

    run, design = asyncio.run(survey())
    result = build(run, design)
    assert list(result["copy"]) == ["spotify", "meta", "poster"]  # no neighborhoods or websites: no Nextdoor or Google
    assert_valid(result["copy"], facts_of(run, design))
    competitors = {c["name"] for row in run.gaps for c in row["competitors"]}
    assert not any(name in line for name in competitors for line in kit_lines(result["copy"]))
    # A name that is just the category is not repeated: the copy introduces the category instead.
    name = result["concept"]["name"]
    intro = "A new seafood place." if name == "Seafood" else f"{name} is a new seafood place."
    assert result["copy"]["spotify"]["script"].startswith(intro)


def test_the_kit_carries_the_dossier_with_its_copy():
    run = world()
    result = build(run, sheet(run))
    assert result["dossier"]["launch"]["copy"] == result["copy"]
    assert result["concept"] == {"index": 0, "name": "Golden Hour", "genre": "Bakery"}
    assert result["built_at"].endswith("+00:00")


# ---------- The maps ----------

def test_the_poster_map_shows_the_trips_without_naming_them_and_only_with_the_closer_claim():
    run = world()
    result = build(run, sheet(run))
    assert "closer" in [claim["kind"] for claim in result["claims"]]
    assert result["poster"]["map"] == {
        "streets": None,
        "trips": [{"km": 2.2, "bearing": 0}, {"km": 2.8, "bearing": 0}, {"km": 3.3, "bearing": 0}],
        "caption": "2.8 km: where people here go for bakeries now",
    }
    poster = json.dumps(result["poster"], ensure_ascii=False)
    assert not any(name in poster for name in ("Crumb", "Rise", "Corner Loaf", "Dawn Rolls"))
    # Without a claim that people here cross town for it, the poster says nothing of trips.
    calm = world(leakage=0.1)
    plain = build(calm, sheet(calm))
    assert "closer" not in [claim["kind"] for claim in plain["claims"]]
    assert plain["poster"]["map"]["trips"] == [] and plain["poster"]["map"]["caption"] is None


def test_one_street_map_serves_the_poster_and_the_cover_and_may_arrive_while_the_copy_is_written():
    streets = {"box": [[30.25, -97.73], [30.27, -97.71]], "streets": {}, "water": [], "parks": [], "credit": "©"}

    async def fetched() -> dict:
        return streets

    run = world()
    for given in (streets, fetched()):
        result = asyncio.run(kit.build_kit(LLM("", None, "test-model"), run, 0, sheet(run), None, given))
        assert result["poster"]["map"]["streets"] == streets
        assert result["dossier"]["cover"]["map"]["streets"] == streets
