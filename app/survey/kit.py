"""The launch kit for one concept (free): ad copy for each channel of the launch plan, a poster drawn from the
walk, tracked links and the decision dossier.

The model writes the copy; deterministic checks read every line against the plan's claims, so an ad never states a
number the evidence does not give, a price or an offer, names a competitor or a place on the block (possessive or not),
borrows an artist's, a show's or a brand's name, says "only" beyond what its claim proves, or reaches for a
superlative. Menu items a model wrote count as the business's own words only once they pass the same checks. Rejected
lines go back to the model once with the reasons; whatever is still missing is written by rules from the claims
themselves, so the kit always works without a model. The poster is data for vector art (the walk's real outline), never
a stock or generated picture.
"""
from __future__ import annotations

import copy
import dataclasses
import inspect
import json
import logging
import re
import unicodedata
from collections.abc import Awaitable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlencode

from .. import scoring
from ..answers import AnswerCache, fingerprint
from ..catchment import Reach
from ..llm import LLM
from . import launch
from .concepts import COMMON_NAME_WORDS, FILLER, place_names
from .constraints import Constraints
from .dossier import (
    build_dossier,
    business_name,
    campaign,
    concept_at,
    map_trips,
    streets_basis,
    untested,
    usable_claims,
    walk_outline,
)
from .evidence import (
    NATIONAL,
    NOT_NATIONAL,
    PROPER_WORDS,
    area_noun,
    gap_for,
    in_sentence,
    is_walk,
    number,
    offer_items,
    people_here,
    plural,
    singular,
)
from .models import RunState

log = logging.getLogger("walkin")

# Each channel's fields and their limits: characters (spaces included), words, list sizes; a script is read aloud.
FORMATS: dict[str, dict[str, dict]] = {
    "spotify": {"script": {"words": 75, "spoken": True}, "companion": {"chars": 40}},
    "nextdoor": {"headline": {"chars": 60}, "body": {"chars": 600}},
    "google_search": {"headlines": {"chars": 30, "min": 8, "max": 15}, "descriptions": {"chars": 90, "min": 4, "max": 4}},
    "meta": {"primary_text": {"chars": 125}, "headline": {"chars": 40}, "description": {"chars": 30}},
    "poster": {"headline": {"chars": 40}, "subline": {"chars": 90}},
}
# The launch plan's channels, and the copy each one runs.
CHANNELS = {
    "Spotify Ads": "spotify", "Nextdoor": "nextdoor", "Google Ads custom segment": "google_search",
    "Meta or Google local ads": "meta",
}
CHANNEL_NAMES = {key: name for name, key in CHANNELS.items()} | {"poster": "Poster"}
# utm_source and utm_medium per channel, in the forms analytics tools group by default.
UTM = {
    "spotify": ("spotify", "audio"), "nextdoor": ("nextdoor", "paid_social"), "google_search": ("google", "cpc"),
    "meta": ("facebook", "paid_social"), "poster": ("poster", "qr"),
}
# Who each channel reaches, so the copy says "close by" only where it is true; reaches() puts in the survey's area.
REACHES = {
    "spotify": "Listeners across the city who over-index on the area's artists and podcasts; most do not live nearby.",
    "nextdoor": "Neighbors in the neighborhoods of the walk.",
    "google_search": "People searching who browse the websites of the places locals now travel to.",
    "meta": "People inside a radius that covers the walk.",
    "poster": "People passing the door: it hangs in the window.",
}
WORDS_PER_SECOND = 2.5


def reaches(key: str, area: str | int = 10) -> str:
    """Who a channel reaches (REACHES), with the survey's area where it names the walk: 'the 30-minute drive'."""
    return REACHES[key] if is_walk(area) else REACHES[key].replace("the walk", f"the {area_noun(area)}")

NUMBER = re.compile(r"\d+(?:[.,:]\d+)*")
NUMBER_WORDS = {
    "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80,
    "ninety": 90, "hundred": 100, "thousand": 1000, "dozen": 12,
    # Quantities that are no number in particular, and none the evidence gives: 'loved by thousands'.
    "dozens": 12, "hundreds": 100, "thousands": 1000, "million": 1_000_000, "millions": 1_000_000,
    "billion": 1_000_000_000, "billions": 1_000_000_000,
}
NUMBER_WORD = re.compile(r"\b(" + "|".join(NUMBER_WORDS) + r")\b", re.IGNORECASE)
# Numbers in words, for a walk's minutes said in words: 'a ten-minute walk', 'twenty-five minutes'.
ONES = ("one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
        "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen")
TENS = ("twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
# Money: any currency sign ('$2', '$$$'), '3 dollars', 'two bucks'. Ads state no price and no price level.
PRICE = re.compile(
    r"[$€£¢]|\b\d+(?:[.,]\d+)?\s*(?:dollars?|bucks?|cents?|euros?|usd|eur|gbp)\b|"
    r"\b(?:a|an|one|" + "|".join(NUMBER_WORDS) + r")\s+(?:dollars?|bucks?|cents?|euros?)\b",
    re.IGNORECASE,
)
# Exclusivity, said with 'only' or in other words: it needs an 'only' claim, and keeps to what the claim proves.
EXCLUSIVE = re.compile(
    r"\bonly\b|\bno other\b|\bnowhere else\b|\bno ?one else\b|\bnobody else\b|\b(?:the|our|its|your) sole\b|"
    r"\bexclusive(?:ly)?\b|\bone[- ]of[- ]a[- ]kind\b|\bthe one (?:and only )?(?:place|spot|stop)\b|"
    r"\bthe one \w+ (?:in|on|near|nearby|within|around)\b",
    re.IGNORECASE,
)
# Where a clause of a line ends: an 'only' must carry its claim's scope within its own clause.
CLAUSE = re.compile(r"(?<=[.!?;:,])\s+|\s+[-–—]+\s+|\n+")
SUPERLATIVE = re.compile(
    r"#\s*1\b|\bno\.?\s*1\b|\bnumber\s+one\b|\b(?:best|cheapest|finest|greatest|tastiest|freshest|fastest|"
    r"(?:top|highest|best)[- ]rated|(?:world[- ])?famous|renowned|legendary|iconic|award[- ]winning|unbeat(?:able|en)|"
    r"unmatched|unrivall?ed|unparalleled|ultimate|world[- ]class|best[- ]in[- ]class|lowest[- ]priced|lowest prices?|"
    r"most (?:popular|loved|beloved|famous|authentic|delicious|trusted|celebrated))\b",
    re.IGNORECASE,
)
# Price promises: percentages, discounts, freebies, credits, deals and savings ("gluten-free" is not one). The ads make
# no offer: one is the owner's to make.
DISCOUNT = re.compile(
    r"\d\s*%|\bper\s?cent\b|\bdiscount|\bcoupons?\b|\bvouchers?\b|\bpromo(?:tion|tional|s)?\b|\bdeals?\b|\bbargains?\b|"
    r"\bcheaper\b|\b(?:half|reduced|special|lower|best|members?|founders?'?|founding|early[- ]bird)[- ]prices?\b|"
    r"\bearly[- ]bird\b|(?<![-\w])free\b(?!-)|\bcomplimentary\b|\bon the house\b|\bgratis\b|\bbogo\b|"
    r"\b(?:2|two)[- ]for[- ](?:1|one)\b|\bbuy one\b|\bcash ?back\b|\brebates?\b|\bcredits?\b(?!\s*cards?)|"
    r"\bsav(?:e|es|ing)\s+(?:\$|€|£|\d|up\s+to|money|on)|\bsavings\b|\$\s?\d[\d.,]*\s+off\b|\d\s*%\s*off\b|\bhalf[- ]off\b|"
    r"\bon sale\b|\boff\s+(?:your|every|each|all|any|the\s+(?:first|bill|menu|price))\b|\blifetime\b|\bfor life\b",
    re.IGNORECASE,
)
WEB = re.compile(
    r"https?://|\bwww\.|[\w.+-]+@[\w-]+\.\w|\b[a-z0-9-]+\.(?:com|net|org|co|io|us|uk|ca|shop|store|cafe|bar|menu|app)\b",
    re.IGNORECASE,
)
# A walk away, said of a survey of a drive or a road distance: untrue there ('Walk in and say hello' is no distance).
WALKING = re.compile(
    r"\b(?:short\s+walk|walk(?:ing)?\s+distance|on\s+foot|minutes?\s+walk|min\s+walk|steps\s+(?:from|away))\b",
    re.IGNORECASE,
)
# The area an 'only' claim names (launch.claims: 'within a 10-minute walk', 'within a 30-minute drive', 'within a 25 km
# drive'): a trip of minutes, or a road distance in kilometres.
KM = r"(?:km|kilomet(?:er|re)s?)"
TRIP = re.compile(r"(\d+)\s*-?\s*minutes?\s+(walk|drive)", re.IGNORECASE)
ROAD = re.compile(rf"(\d+(?:\.\d+)?)\s*-?\s*{KM}\s+drive", re.IGNORECASE)
UNSPOKEN = re.compile(r"[$#@*/|·•_<>=~^\[\]{}]")
# Characters after which a capitalized word starts a sentence rather than naming something.
SENTENCE_END = set(".!?:;\"“”(–—-•·|")
MASK = " zzownzz "
# A possessive ('Corner Loaf's', 'Mobley’s') reads as the name it belongs to; folding leaves its mark.
POSSESSIVE = re.compile(r"['’`]s\b", re.IGNORECASE)
OWNS = "’"


def fold(text: str) -> str:
    """Accents and apostrophes dropped, case kept, a possessive's 's marked: 'Joe’s Café' -> 'Joe’ Cafe', 'don't' -> 'dont'."""
    plain = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    return POSSESSIVE.sub(OWNS, re.sub(r"['’`](?![sS]\b)", "", plain))


def numbers_in(text: str) -> list[str]:
    return NUMBER.findall(text) + [match.group(1) for match in NUMBER_WORD.finditer(text)]


def canon(token: str) -> str:
    """One form per number: 'ten' and '10', '1,000' and '1000', '2.10' and '2.1'; times of day stay as written."""
    word = NUMBER_WORDS.get(token.lower())
    if word is not None:
        return f"{word:g}"
    token = re.sub(r",(?=\d{3}(?!\d))", "", token)
    if ":" in token:
        return token
    try:
        return f"{float(token.replace(',', '.')):g}"
    except ValueError:
        return token


def spelled(number: int) -> list[str]:
    """A whole number from 1 to 99 as copy may write it in words: 'ten', 'twenty-five' or 'twenty five'."""
    if 1 <= number < 20:
        return [ONES[number - 1]]
    if 20 <= number < 100:
        tens, unit = TENS[number // 10 - 2], number % 10
        return [f"{tens}-{ONES[unit - 1]}", f"{tens} {ONES[unit - 1]}"] if unit else [tens]
    return []


def name_words(text: str) -> list[str]:
    """A name's words, plain and without possessives: "Joe's Bakery & Co" -> ['joe', 'bakery', 'and', 'co']."""
    return scoring.topic_text(POSSESSIVE.sub("", text)).split()


def phrase_pattern(phrase: str) -> re.Pattern | None:
    """A phrase however it is written: 'Tide & Table' also matches 'tide and table', and 'Joe's Bakery' "Joe’s bakery"."""
    words = name_words(phrase)
    if not words:
        return None
    parts = [r"(?:and|&)" if word == "and" else re.escape(word) for word in words]
    return re.compile(r"(?<!\w)" + r"\W*".join(parts) + r"(?!\w)", re.IGNORECASE)


@dataclass(frozen=True)
class Name:
    """A name copy must not use, however it is written: 'Patagonia fans', 'patagonia', 'Mobley's', '- Stassi'. A one-word
    name that is also a plain word ('Rise', 'Proof', 'Crumb') only counts written as a name: capitalized, and not just
    because it starts a sentence, unless it is a possessive ('Crumb's kouign amann'). A match inside the business's own
    words ('Crumb' in its 'Crumb cake') is the business's; one reaching beyond them ('Joe's Bakery' around 'bakery') is
    the name."""

    text: str
    pattern: re.Pattern
    plain: bool  # one plain English word (PLAIN_WORDS)

    def found(self, folded: str, own: list[tuple[int, int]]) -> bool:
        for match in self.pattern.finditer(folded):
            start, end = match.span()
            if any(low <= start and end <= high for low, high in own):
                continue
            if not self.plain:
                return True
            before = folded[:start].rstrip()
            mid_sentence = bool(before) and before[-1] not in SENTENCE_END
            if match.group(0)[:1].isupper() and (mid_sentence or folded[end:end + 1] == OWNS):
                return True
        return False


def names_of(texts: Iterable[str], generic: set[str]) -> list[Name]:
    """Names to watch for; names made only of plain category words ('The Bakery', 'Coffee Shop') say nothing."""
    out: dict[str, Name] = {}
    for text in texts:
        words = [word for word in name_words(text) if word != "the"]
        pattern = phrase_pattern(" ".join(words))
        if not pattern or len("".join(words)) < 3 or set(words) <= generic:
            continue
        out.setdefault(pattern.pattern, Name(text.strip(), pattern, len(words) == 1 and words[0] in PLAIN_WORDS))
    return list(out.values())


@dataclass(frozen=True)
class Scope:
    """What an 'only' claim proves: its kind of business and its area (the walk, the drive or the road distance it
    names). A clause that says 'only', or 'no other', 'nowhere else'…, has to carry all of it."""

    line: str
    parts: tuple[re.Pattern, ...]

    def carried(self, clause: str) -> bool:
        return all(part.search(clause) for part in self.parts)


def in_words(figure: str) -> str:
    """A number as a pattern for the forms copy may write it in: '10' or 'ten', '25' or 'twenty-five'; '2.5' as is."""
    forms = [figure, *(spelled(int(figure)) if figure.isdigit() else [])]
    return "|".join(re.escape(form) for form in forms)


def scope_of(claim: dict, genre: str) -> Scope:
    """The scope of an 'only' claim, read from its line: 'The only bakery within a 10-minute walk', '… within a
    30-minute drive', '… within a 25 km drive'. Its area is carried only as itself: a drive is no walk, and 'within
    25 km' (a straight line) reaches farther than a 25 km drive."""
    line = fold(claim["line"])
    parts: list[re.Pattern] = []
    kinds = [p for p in map(phrase_pattern, sorted({in_sentence(genre), singular(genre), plural(genre)}, key=len, reverse=True)) if p]
    if any(pattern.search(line) for pattern in kinds):
        parts.append(re.compile("|".join(pattern.pattern for pattern in kinds), re.IGNORECASE))
    trip = TRIP.search(line)
    if trip:
        minutes, travel = in_words(trip.group(1)), trip.group(2).lower()
        parts.append(re.compile(rf"\bwithin\s+(?:an?\s+)?(?:{minutes})\s*-?\s*minutes?\s+{travel}\b", re.IGNORECASE))
    road = ROAD.search(line)
    if road:
        parts.append(re.compile(rf"\bwithin\s+(?:an?\s+)?(?:{in_words(road.group(1))})\s*-?\s*{KM}\s+drive\b", re.IGNORECASE))
    whole = phrase_pattern(claim["line"])
    return Scope(claim["line"], tuple(parts) if parts or not whole else (whole,))


@dataclass
class Facts:
    """What the copy may say: the numbers the claims, proofs, hours, area and name give, the scope of each 'only' claim,
    and the names it must never use. The business's own name, menu and neighborhoods are its own words: masked before
    the number, price, 'only' and superlative checks, and never mistaken for another business's name. A menu item a
    model wrote counts as the business's own only once it passes every check itself (`menu`); the others are noted.
    `area` is the survey's ('10-minute walk', '30-minute drive'): beside a drive or a road distance, no line may say the
    place is a walk away."""

    numbers: set[str]
    only: tuple[Scope, ...]
    places: list[Name]
    audience: list[Name]
    own: list[re.Pattern]
    constraints: Constraints
    menu: list[str] = dataclasses.field(default_factory=list)  # the model-written menu items the copy may name
    left_out: list[str] = dataclasses.field(default_factory=list)  # why the others may not, for the owner
    area: str = "10-minute walk"

    def mask(self, folded: str) -> str:
        for pattern in self.own:
            folded = pattern.sub(MASK, folded)
        return folded

    def check(self, text: str, chars: int | None = None, words: int | None = None, spoken: bool = False) -> list[str]:
        """Why a line cannot run; empty when it can."""
        reasons = []
        if chars and len(text) > chars:
            reasons.append(f"over {chars} characters ({len(text)})")
        if words and len(text.split()) > words:
            reasons.append(f"over {words} words ({len(text.split())})")
        folded = fold(text)
        spans = [match.span() for pattern in self.own for match in pattern.finditer(folded)]
        masked = self.mask(folded)
        if re.search(r"\b(?:and|or|the|a|an|our|your|freshly|including|featuring)\s*[,;:.!?]*$|"
                     r"\b(?:with|for|from|of|to)\s*[,;:]*$",
                     masked, re.IGNORECASE) or re.search(r"(?:\.{3}|\u2026)$", text.strip()):
            reasons.append("ends mid-sentence: use a complete line, not clipped copy")
        place = next((name for name in self.places if name.found(folded, spans)), None)
        if place:
            reasons.append(f"names {place.text}, a place near the site: ads must not name other businesses")
        listened = next((name for name in self.audience if name.found(folded, spans)), None)
        if listened:
            reasons.append(f"names {listened.text}, from the audience: artists, shows, podcasts and brands are for "
                           f"targeting only")
        if PRICE.search(masked):
            reasons.append("states a price: ads give no prices or price levels")
        stray = list(dict.fromkeys(token for token in numbers_in(masked) if canon(token) not in self.numbers))
        if stray:
            reasons.append(f"states {', '.join(stray)}, a number no claim, proof, the hours or the {area_noun(self.area)} "
                           f"gives")
        if not is_walk(self.area) and WALKING.search(masked):
            reasons.append(f"says the place is a walk away, but the area is a {self.area}")
        exclusive = self.exclusive(folded)
        if exclusive:
            reasons.append(exclusive)
        superlative = SUPERLATIVE.search(masked)
        if superlative:
            reasons.append(f'"{superlative.group(0)}" is a superlative nothing proves')
        filler = FILLER.search(masked)
        if filler:
            reasons.append(f'"{filler.group(0)}" is filler nothing measured backs: say what it serves or answers')
        if DISCOUNT.search(masked):
            reasons.append("promises a discount, a deal or something free: the ads make no offer")
        if WEB.search(text):
            reasons.append("a web address or email: the tracked link carries the website")
        if spoken and UNSPOKEN.search(text):
            reasons.append("a symbol a voice cannot read")
        if not self.constraints.allows_item(masked):
            reasons.append("offers something the owner's notes rule out")
        return reasons

    def exclusive(self, folded: str) -> str | None:
        """Why a line's 'only' (or 'no other', 'nowhere else'…) cannot run: no 'only' claim proves it, or the clause
        saying it does not keep to the claim's kind of business and area."""
        for clause in CLAUSE.split(folded):
            said = EXCLUSIVE.search(self.mask(clause))
            if not said:
                continue
            word = said.group(0).lower()
            if not self.only:
                return f'says "{word}" without an "only" claim'
            if not any(scope.carried(clause) for scope in self.only):
                return f'says "{word}" beyond what the "only" claim proves: "{self.only[0].line}"'
        return None


def area_numbers(run: RunState) -> set[str]:
    """The figures of the survey's area copy may state: a walk's or a drive's minutes, a road distance's kilometres
    (whose minutes are no figure of the area)."""
    return {canon(token) for token in numbers_in(run.site.area)}


def facts_for(run: RunState, concept: dict, design: dict, name: str, claims: list[dict]) -> Facts:
    """The facts a concept's copy is checked against."""
    genre = concept["genre"]
    row = gap_for(run, genre)
    plan = design.get("launch") if isinstance(design.get("launch"), dict) else {}
    texts = [c["line"] for c in claims] + [c["proof"] for c in claims]
    texts += [design.get("hours") or "", name, str(concept.get("name") or "")]
    numbers = {canon(token) for text in texts for token in numbers_in(text)} | area_numbers(run)
    own = [name, str(concept.get("name") or ""), scoring.genre_title(genre), singular(genre), plural(genre)]
    own += neighborhoods_of(run, design)
    own += [item["item"] for item in offer_items(row, run.constraints, limit=8)] if row else []
    generic = {w for text in (*COMMON_NAME_WORDS, genre, singular(genre), plural(genre)) for w in scoring.topic_text(text).split()}
    generic |= {"and", "of", "a", "an", "new", "place", "places", "co"}
    facts = Facts(
        numbers=numbers,
        only=tuple(scope_of(c, genre) for c in claims if c["kind"] == "only"),
        places=names_of(place_texts(run), generic),
        audience=names_of(audience_texts(run, plan), generic),
        own=own_patterns(own),
        constraints=run.constraints,
        area=run.site.area,
    )
    # The sheet's offer and the concept's signature items are the model's words: the business's own only once they
    # keep every rule themselves (no other business's name, no number, price or superlative nothing proves).
    written = [" ".join(item.split()) for item in strings(design.get("offer")) + strings(concept.get("signature"))]
    for item in dict.fromkeys(item for item in written if item):
        problems = facts.check(item)
        if problems:
            facts.left_out.append(f'Left out the menu item "{item}" ({"; ".join(problems)}).')
        else:
            facts.menu.append(item)
    facts.own = own_patterns(own + facts.menu)
    return facts


def own_patterns(texts: Iterable[str]) -> list[re.Pattern]:
    """The business's own words as patterns, the longest first so a phrase is masked before the words inside it."""
    return [p for p in (phrase_pattern(text) for text in sorted(set(texts), key=len, reverse=True)) if p]


def strings(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def place_texts(run: RunState) -> set[str]:
    """Every place the survey saw: the block, each category's places inside the walk and the places locals love."""
    names = set(place_names(run))
    for row in run.gaps + run.explored:
        for key in ("_nearby_entities", "_favorite_entities"):
            names |= {place.get("name") for place in row.get(key) or []}
    if run.place:
        names.add(run.place.get("name"))
    return {name for name in names if isinstance(name, str) and name.strip()}


def audience_texts(run: RunState, plan: dict) -> set[str]:
    """Artists, podcasts, films, shows and brands the area or a category's fans over-index on: targeting, not creative."""
    names: set = set()
    for cards in run.taste.values():
        if isinstance(cards, list):
            names |= {card.get("name") for card in cards if isinstance(card, dict)}
    for fans in run.fans.values():
        for key in ("brands", "artists"):
            names |= {card.get("name") for card in fans.get(key) or [] if isinstance(card, dict)}
    audience = plan.get("audience") or {}
    for key in ("artists", "podcasts", "screen", "brands", "shared"):
        names |= {name for name in audience.get(key) or [] if isinstance(name, str)}
    return {name for name in names if isinstance(name, str) and name.strip()}


def limits(spec: dict) -> dict:
    return {key: spec[key] for key in ("chars", "words", "spoken") if key in spec}


# ---------- Copy written by rules ----------

Candidate = tuple[str, tuple[str, ...]]

DAY_NAMES = {"Mon": "Monday", "Tue": "Tuesday", "Wed": "Wednesday", "Thu": "Thursday", "Fri": "Friday", "Sat": "Saturday",
             "Sun": "Sunday"}
# Lines true of any new business on a short walk, so a channel's copy is complete even when the evidence says little.
SAFE_HEADLINES = ("New on the block", "A short walk away", "Come say hello", "Walk in and say hello",
                  "Made for the neighborhood", "Your new neighborhood spot", "Steps from home")
SAFE_DESCRIPTIONS = ("New on the block. Walk in and say hello.", "Made for the neighborhood, a short walk from home.",
                     "Steps from home. Come in and say hello.")
# The same beside a long walk, a drive or a road distance, where the place is no short walk from everyone it reaches.
FAR_HEADLINES = ("New on the block", "Now open", "Come say hello", "Walk in and say hello", "Made for the neighborhood",
                 "Your new neighborhood spot", "Come in and say hello")
FAR_DESCRIPTIONS = ("New on the block. Walk in and say hello.", "Made for the neighborhood. Come say hello.",
                    "Now open. Come in and say hello.")
# The longest walk 'a short walk away' is said of: the longest the survey offered before drives existed.
SHORT_WALK = 15
# Plain English words a place, an artist or a brand may be named after ('Rise', 'Proof', 'Crumb'). Copy uses them as
# words, so a one-word name among them only counts written as a name; any other one-word name ('Patagonia', 'Mobley')
# counts however it is written. The words the rules' own lines use are among them, so those lines always stay usable.
PLAIN_TEXT = """
    morning mornings noon afternoon evening evenings night nights dawn dusk sunrise sunset midday midnight daily weekly
    weekend weekends today tomorrow sunday monday tuesday wednesday thursday friday saturday spring summer autumn fall
    winter season seasons hour hours day days week year early late golden
    bread loaf loaves crumb crumbs crust dough flour rise proof knead yeast butter sugar salt pepper honey jam toast bun
    buns roll rolls biscuit cookie cookies cake cakes pie tart scone bagel muffin waffle pancake crepe pastry pastries
    sweet sweets cream milk cheese egg eggs bacon olive olives oil herb herbs sage thyme basil mint rosemary dill fennel
    ginger garlic onion lemon lime orange apple apples pear peach plum cherry berry berries fig figs grape grapes vine
    melon mango coconut cocoa cacao chocolate vanilla caramel maple cinnamon clove nutmeg saffron spice chili salsa
    noodle noodles rice bean beans corn grain grains wheat rye oat oats barley hops malt brew coffee tea juice soda
    water wine beer cider spirit spirits tonic soup stew broth smoke fire flame ember embers coal ash hearth oven kiln
    stove pot pan kettle fork spoon knife plate bowl cup mug jar glass bottle barrel cask table tables counter bench
    supper dinner lunch breakfast brunch feast bite bites taste flavor pantry larder harvest
    field fields garden gardens orchard grove meadow prairie forest wood woods tree trees oak pine cedar birch willow
    elm juniper ivy fern moss leaf leaves root roots seed seeds sprout bloom blossom flower flowers petal rose lily
    daisy poppy clover acorn river lake creek brook stream well pond sea ocean bay harbor harbour coast shore tide tides
    wave waves sand stone rock hill hills mountain valley canyon sky sun moon star stars cloud rain snow storm wind
    north south east west island farm ranch barn mill yard court square park lane alley street avenue road path bridge
    gate door window porch corner block town city village home house nest den hive haven common commons union parish
    copper iron brass gold silver steel tin paper ink thread anchor compass lantern candle light bright warm cozy fresh
    simple honest good fine kind true wild little big small grand royal noble humble happy lucky joy bliss grace hope
    love heart soul friend friends neighbor neighbors family families folk people crowd couples kids local craft
    ritual habit story fable chapter verse rhythm tempo note melody echo origin element wander roam rest
    hello hi welcome come say walk walks minute minutes foot short away steps made neighborhood spot open new close near
    for from with within without which there you your known crossing town only drive drives driving car km long now
"""
PLAIN_WORDS = frozenset(PLAIN_TEXT.split()) | {
    word for line in (*SAFE_HEADLINES, *SAFE_DESCRIPTIONS, *FAR_HEADLINES, *FAR_DESCRIPTIONS, *launch.PROMISES.values(),
                      *DAY_NAMES, *DAY_NAMES.values())
    for word in scoring.topic_text(line).split()
}


@dataclass
class Brief:
    """What the rules write from: the business, where it is (`reach`, the survey's area), its hours and the claims it
    may make."""

    name: str
    kind: str
    title: str
    hood: str | None
    reach: Reach
    hours: str | None
    claims: list[dict]

    def claim(self, kind: str) -> dict | None:
        return next((c for c in self.claims if c["kind"] == kind), None)

    @property
    def area(self) -> str:
        """'10-minute walk', '30-minute drive', '25 km drive': after 'within a'."""
        return self.reach.label

    @property
    def walk(self) -> bool:
        return self.reach.travel == "walk"

    @property
    def short_walk(self) -> bool:
        """Whether the whole area is a short walk away: a walk of SHORT_WALK minutes at most."""
        return self.walk and self.reach.minutes <= SHORT_WALK

    @property
    def trip(self) -> str:
        """The area as a headline: '10 minutes on foot', '30 minutes by car', '25 km by road'."""
        if self.reach.travel == "distance":
            return f"{self.reach.km:g} km by road"
        return f"{self.reach.minutes} minutes {'on foot' if self.walk else 'by car'}"

    @property
    def safe_headlines(self) -> tuple[str, ...]:
        return SAFE_HEADLINES if self.short_walk else FAR_HEADLINES

    @property
    def safe_descriptions(self) -> tuple[str, ...]:
        return SAFE_DESCRIPTIONS if self.short_walk else FAR_DESCRIPTIONS

    @property
    def named(self) -> bool:
        """Whether the name says more than the category: 'Golden Hour' does, a rules-made 'Seafood' does not."""
        return scoring.topic_text(self.name) not in {scoring.topic_text(self.title), scoring.topic_text(self.kind)}

    def intro(self, where: str = "") -> str:
        """'Golden Hour is a new bakery in Holly', or 'A new seafood place in Holly' when the name is the category."""
        return f"{self.name} is a new {self.kind}{where}." if self.named else f"A new {self.kind}{where}."


def item_of(claim: dict) -> str:
    """The item a 'new' claim is about: 'Kouign amann, which no bakery…' -> 'Kouign amann'."""
    return claim["line"].split(", which", 1)[0].strip()


def mid_sentence(item: str) -> str:
    """'Kouign amann' as it reads inside a sentence; 'Neapolitan pizza' and 'BLT' keep their capitals."""
    first = item.split()[0] if item.split() else ""
    proper = bool(NATIONAL.match(first)) and first not in NOT_NATIONAL or first in PROPER_WORDS or len(first) > 1 and first.isupper()
    return item if proper else item[:1].lower() + item[1:]


def sentence(text: str) -> str:
    text = " ".join(text.split()).rstrip(".")
    return text[:1].upper() + text[1:] + "."


def hours_text(hours: str, spoken: bool = False) -> str:
    """'Mon–Thu 11 am–10 pm · Sun noon–6 pm' for a line of copy, or as a voice says it."""
    if not spoken:
        return hours.replace(" · ", ", ")
    text = hours.replace(" · ", "; ").replace("–", " to ")
    return re.sub(r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b", lambda m: DAY_NAMES[m.group(1)], text)


def claim_sentences(brief: Brief, prose: bool = False, skip: tuple[str, ...] = ()) -> list[Candidate]:
    """Each claim as a sentence; `prose` makes an 'only' claim a full sentence for running text."""
    out = []
    for claim in brief.claims:
        kind = claim["kind"]
        if kind in skip:
            continue
        if kind == "only":
            text = claim["line"]
            if prose:
                text = f"It is {text[:1].lower()}{text[1:]}"
        elif kind == "new":
            text = f"Come for the {mid_sentence(item_of(claim))}, which no {brief.kind} within a {brief.area} is known for"
        else:
            text = claim["line"]
        out.append((sentence(text), (claim["id"],)))
    return out


def pick(candidates: Iterable[Candidate], facts: Facts, spec: dict) -> Candidate | None:
    """The first candidate that passes every check."""
    for text, ids in candidates:
        text = " ".join(text.split())
        if text and not facts.check(text, **limits(spec)):
            return text, ids
    return None


def pick_all(candidates: Iterable[Candidate], facts: Facts, spec: dict) -> list[Candidate]:
    """Every distinct candidate that passes, up to the field's most."""
    out: list[Candidate] = []
    seen: set[str] = set()
    for text, ids in candidates:
        text = " ".join(text.split())
        if text and text.casefold() not in seen and not facts.check(text, **limits(spec)):
            seen.add(text.casefold())
            out.append((text, ids))
    return out[: spec["max"]]


def compose(parts: Iterable[Candidate], facts: Facts, spec: dict) -> Candidate:
    """Sentences joined while the whole stays within the limits; a sentence that fails a check is left out."""
    text, ids = "", ()
    for part, used in parts:
        joined = f"{text} {part}".strip()
        if not facts.check(part, spoken=spec.get("spoken", False)) and not facts.check(joined, **limits(spec)):
            text, ids = joined, ids + used
    return text, ids


def piece(fields: dict[str, Candidate | list[Candidate] | None]) -> dict:
    """A rules piece: each field's text and the claims the piece uses."""
    out: dict = {}
    ids: set[str] = set()
    for field, value in fields.items():
        if isinstance(value, list):
            out[field] = [text for text, _ in value]
            ids |= {claim for _, used in value for claim in used}
        elif value and value[0]:
            out[field] = value[0]
            ids |= set(value[1])
    return {"fields": out, "claims": ids}


def rules_spotify(b: Brief, facts: Facts) -> dict:
    spec = FORMATS["spotify"]
    where = f" in {b.hood}" if b.hood else ""
    # The city hears it, so 'without crossing town' is left to the local channels.
    parts = [(b.intro(where), ()), *claim_sentences(b, prose=True, skip=("closer",))]
    if b.hours:
        parts.append((f"Open {hours_text(b.hours, spoken=True)}.", ()))
    closing = f"{b.name}{f', {b.hood}' if b.hood else ''}. " if b.named else ""
    parts.append((f"{closing}Walk in and say hello.", ()))
    companion = [(f"{b.name}, {b.hood}", ())] if b.hood and b.named else []
    companion += [(f"New {b.kind} in {b.hood}", ())] if b.hood else []
    companion += [(b.name, ())] if b.named else []
    companion += [(f"A new {b.kind}", ()), ("New on the block", ())]
    return piece({"script": compose(parts, facts, spec["script"]), "companion": pick(companion, facts, spec["companion"])})


def rules_nextdoor(b: Brief, facts: Facts) -> dict:
    spec = FORMATS["nextdoor"]
    only = b.claim("only")
    headlines = [(only["line"], (only["id"],))] if only else []
    headlines += [(f"{b.name}: a new {b.kind} close by", ())] if b.named else []
    headlines += [(f"A new {b.kind} close by", ()), ("New on the block", ())]
    where = f" in {b.hood}" if b.hood else ""
    hello = f"{b.name} is a new {b.kind}{where}, close by." if b.named else f"there is a new {b.kind}{where}, close by."
    parts = [(f"Hi neighbors! {hello[:1].upper() + hello[1:]}", ()), *claim_sentences(b, prose=True)]
    if b.hours:
        parts.append((f"Open {hours_text(b.hours)}.", ()))
    parts.append(("Come say hello.", ()))
    return piece({"headline": pick(headlines, facts, spec["headline"]), "body": compose(parts, facts, spec["body"])})


def rules_google(b: Brief, facts: Facts) -> dict:
    spec = FORMATS["google_search"]
    where = f" in {b.hood}" if b.hood else ""
    headlines: list[Candidate] = [(b.name, ())]
    if b.hood:
        headlines += [(f"New {b.kind} in {b.hood}", ()), (f"{b.title} in {b.hood}", ())]
    headlines += [(c["line"], (c["id"],)) for c in b.claims if c["kind"] in ("closer", "promise")]
    headlines += [(item_of(c), (c["id"],)) for c in b.claims if c["kind"] == "new"]
    # The longest of them, 'Within a 60-minute drive', is 24 characters: within a headline's 30.
    headlines += [(f"A new {b.kind} near you", ()), (f"Within a {b.area}", ())]
    headlines += [(f"Open {part}", ()) for part in (b.hours or "").split(" · ") if part]
    headlines += [(b.trip, ()), *[(text, ()) for text in b.safe_headlines]]
    descriptions = claim_sentences(b)
    if b.hours:
        descriptions.append((f"Open {hours_text(b.hours)}.", ()))
    descriptions += [(b.intro(where), ())] if b.named else []
    descriptions += [(f"A new {b.kind}{where}. Walk in and say hello.", ()), (f"Within a {b.area}. Come say hello.", ())]
    descriptions += [(text, ()) for text in b.safe_descriptions]
    return piece({"headlines": pick_all(headlines, facts, spec["headlines"]),
                  "descriptions": pick_all(descriptions, facts, spec["descriptions"])})


def rules_meta(b: Brief, facts: Facts) -> dict:
    spec = FORMATS["meta"]
    # The radius covers the walk, so it is close by; around a drive or a road distance it is only somewhere in it.
    intro = b.intro(" close by") if b.walk else b.intro(f" in {b.hood}" if b.hood else "")
    primary = [(f"{intro} {text}", ids) for text, ids in claim_sentences(b, prose=True)]
    primary += [(intro, ()), ("New on the block. Come say hello.", ())]
    headline = [(b.name, ())] if b.named else []
    headline += [(f"New {b.kind} in {b.hood}", ())] if b.hood else []
    headline += [(f"A new {b.kind} close by", ()) if b.walk else (f"A new {b.kind}", ()), ("New on the block", ())]
    description = [(c["line"], (c["id"],)) for c in b.claims if c["kind"] in ("promise", "closer")]
    description += [("A short walk away" if b.short_walk else "Now open", ()), ("New on the block", ())]
    return piece({"primary_text": pick(primary, facts, spec["primary_text"]),
                  "headline": pick(headline, facts, spec["headline"]),
                  "description": pick(description, facts, spec["description"])})


def rules_poster(b: Brief, facts: Facts) -> dict:
    spec = FORMATS["poster"]
    headlines = [(c["line"], (c["id"],)) for c in b.claims if c["kind"] in ("only", "closer", "promise")]
    headlines += [(f"A new {b.kind} on the block", ()), ("New on the block", ())]
    headline = pick(headlines, facts, spec["headline"])
    used = set(headline[1]) if headline else set()
    sublines = [(text, ids) for text, ids in claim_sentences(b) if not used & set(ids)]
    if b.hours:
        sublines.append((f"Open {hours_text(b.hours)}.", ()))
    sublines.append((f"{'A short walk from home' if b.short_walk else 'Now open'}. Walk in and say hello.", ()))
    return piece({"headline": headline, "subline": pick(sublines, facts, spec["subline"])})


RULES = {"spotify": rules_spotify, "nextdoor": rules_nextdoor, "google_search": rules_google, "meta": rules_meta,
         "poster": rules_poster}


# ---------- Copy written by the model ----------

KIT_SYSTEM = """You write the launch ads for a new storefront business. The owner runs them under their own name, so every
line must be true today and provable from the claims you are given.
Rules for every line:
- Claim only what the claims say: rephrase a claim if you like, never stretch it. Without claims, say what the
  business is, where it is, when it is open and what is on its menu.
- Use no number that is not in the claims, their proofs, the hours, the area's minutes or kilometres or the business
  name.
- Never name another business, nor any artist, podcast, show or brand: platforms reject other businesses' names,
  and naming an artist or a brand implies an endorsement the owner does not have. The neighborhoods given are fine.
- Write "only" (or "no other", "nowhere else") only to state a claim of kind "only", with its kind of business and its
  area, as the claim words it ("within a 10-minute walk", "within a 30-minute drive").
- The area (where.area) is a walk, a drive or a road distance: never say the business is a walk away ("a short walk",
  "steps from", "on foot") unless the area is a walk.
- No superlatives nothing proves (best, #1, cheapest, famous, award-winning, top-rated, world-class).
- No filler nothing measured backs (cozy, chic, vibe, welcoming, inviting, curated, elevated, haven): say what it
  serves, when it opens or what it answers.
- No web addresses, phone numbers, prices, price levels or currency signs, discounts, deals or free offers.
- Keep every field within its limit; characters include spaces.
Each channel says who it reaches: say "close by" or "on your block" only where it reaches neighbors. A script is read
aloud: no symbols.
For each channel, list in "claims" the ids of the claims its lines use.
Return JSON with exactly the channels asked: {"<channel>": {"<field>": ..., "claims": [ids]}}; list fields are arrays
of strings."""
KIT_VERSION = fingerprint(KIT_SYSTEM, FORMATS)
RULES_SOURCE = -1


def describe(spec: dict) -> str:
    """A field's limits in words, for the model."""
    parts = []
    if "min" in spec:
        parts.append(f"exactly {spec['min']} lines" if spec["min"] == spec["max"] else f"{spec['min']} to {spec['max']} lines")
    if "chars" in spec:
        parts.append(f"at most {spec['chars']} characters{' each' if 'min' in spec else ''}")
    if "words" in spec:
        parts.append(f"at most {spec['words']} words, about 30 seconds read aloud")
    if spec.get("spoken"):
        parts.append("no symbols")
    return ", ".join(parts)


def neighborhoods_of(run: RunState, design: dict) -> list[str]:
    plan = design.get("launch") if isinstance(design.get("launch"), dict) else {}
    return (plan.get("where") or {}).get("neighborhoods") or launch.where(run, None)["neighborhoods"]


def model_brief(run: RunState, concept: dict, design: dict, name: str, claims: list[dict], keys: list[str], facts: Facts) -> dict:
    """What the model writes from: the business, the claims with their proofs, the voice, and each channel's format."""
    plan = design.get("launch") if isinstance(design.get("launch"), dict) else {}
    when = plan.get("when") or {}
    tagline = design.get("tagline")
    tagline = " ".join(tagline.split()) if isinstance(tagline, str) and tagline.strip() else None
    return {
        "business": {
            "name": name, "kind": singular(concept["genre"]),
            "menu": facts.menu[:6],
            "tagline": tagline if tagline and not facts.check(tagline, chars=90) else None,
        },
        "where": {"neighborhoods": neighborhoods_of(run, design), "area": run.site.area},
        "hours": design.get("hours"),
        "claims": claims,
        "voice": {
            "crowd": [share["label"] for share in (plan.get("audience") or {}).get("crowd") or []],
            "busy_times": [share["label"] for share in when.get("times") or []],
            "lead_with": [share["angle"] for share in when.get("intents") or [] if share.get("angle")][:1],
        },
        "channels": {
            key: {"reaches": reaches(key, run.site.area), "fields": {field: describe(spec) for field, spec in FORMATS[key].items()}}
            for key in keys
        },
    }


async def ask(llm: LLM, answers: AnswerCache | None, user: str) -> tuple[dict, str | None]:
    """One answer from the model, replayed from the cache while the evidence and the prompt are unchanged."""
    key = fingerprint("kit", KIT_VERSION, user)
    saved = answers.get("kit", key) if answers else None
    if saved and isinstance(saved.get("copy"), dict):
        return copy.deepcopy(saved["copy"]), saved.get("model")
    data, model = await llm.complete_json(KIT_SYSTEM, user)
    if data and answers:
        answers.put("kit", key, {"copy": data, "model": model})
    return (copy.deepcopy(data) if isinstance(data, dict) else {}), model


def check_answer(answer: dict, keys: list[str], facts: Facts, ids: set[str]) -> tuple[dict, list[dict], list[str]]:
    """The answer's lines that pass every check, per channel; the lines rejected and why; and what is still missing."""
    pieces: dict = {}
    rejected: list[dict] = []
    problems: list[str] = []
    for key in keys:
        raw = answer.get(key) if isinstance(answer.get(key), dict) else {}
        fields: dict = {}
        for field, spec in FORMATS[key].items():
            value = raw.get(field)
            many = "min" in spec
            texts = (value if isinstance(value, list) else []) if many else [value]
            kept: list[str] = []
            refused = False
            for text in texts:
                if not isinstance(text, str) or not text.strip():
                    continue
                text = " ".join(text.split())
                reasons = facts.check(text, **limits(spec))
                if reasons:
                    refused = True
                    rejected.append({"channel": key, "field": field, "text": text, "reasons": reasons})
                    problems.append(f'{key}.{field} "{text}": {"; ".join(reasons)}')
                elif text.casefold() not in {k.casefold() for k in kept}:
                    kept.append(text)
            if many:
                fields[field] = kept[: spec["max"]]
                if len(kept) < spec["min"]:
                    problems.append(f"{key}.{field}: {len(kept)} usable lines, {spec['min']} needed")
            elif kept:
                fields[field] = kept[0]
            elif not refused:
                problems.append(f"{key}.{field}: missing")
        listed = raw.get("claims") if isinstance(raw.get("claims"), list) else []
        pieces[key] = {"fields": fields, "claims": {c for c in listed if isinstance(c, str) and c in ids}}
    return pieces, rejected, problems


def retry_prompt(brief: str, answer: dict, problems: list[str]) -> str:
    previous = json.dumps(answer, ensure_ascii=False)[:6000]
    return (f"{brief}\n\nYour previous answer:\n{previous}\n\nIt broke these rules. Write the whole JSON again, keep what "
            "was right and fix every point:\n- " + "\n- ".join(problems))


async def write_copy(
    llm: LLM | None, answers: AnswerCache | None, brief: str, keys: list[str], facts: Facts, claims: list[dict],
) -> tuple[list[tuple[dict, str | None]], list[dict]]:
    """The model's checked attempts (a second one only when the first broke a rule) and every line rejected."""
    attempts: list[tuple[dict, str | None]] = []
    rejected: list[dict] = []
    if llm is None or not getattr(llm, "enabled", False):
        return attempts, rejected
    ids = {claim["id"] for claim in claims}
    user = brief
    for attempt in (1, 2):
        try:
            answer, model = await ask(llm, answers, user)
        except Exception:  # an outage must not cost the owner the kit
            log.warning("Launch kit copy: the model failed; the rules write what is missing", exc_info=True)
            break
        pieces, dropped, problems = check_answer(answer, keys, facts, ids)
        attempts.append((pieces, model))
        rejected += [{**item, "attempt": attempt} for item in dropped]
        if not problems:
            break
        user = retry_prompt(brief, answer, problems)
    return attempts, rejected


def detect(texts: list[str], claims: list[dict]) -> set[str]:
    """The claims a piece's words lean on, whatever the model listed: 'only' said, a new item named, a line quoted."""
    said = " ".join(fold(text).lower() for text in texts)
    found = set()
    for claim in claims:
        if claim["kind"] == "only":
            hit = bool(EXCLUSIVE.search(said))
        else:
            phrase = fold(item_of(claim) if claim["kind"] == "new" else claim["line"]).lower().rstrip(".")
            hit = bool(phrase) and re.search(rf"(?<!\w){re.escape(phrase)}(?!\w)", said) is not None
        if hit:
            found.add(claim["id"])
    return found


def merge(
    keys: list[str], attempts: list[tuple[dict, str | None]], rules: dict[str, dict], claims: list[dict],
) -> tuple[dict, int | None]:
    """Each field from the latest attempt that got it right, else from the rules; lists short of their minimum are
    topped up from the rules. Returns the copy and the latest attempt any of it came from."""
    out: dict = {}
    latest: int | None = None
    for key in keys:
        fields: dict = {}
        sources: set[int] = set()
        for field, spec in FORMATS[key].items():
            tried = [(index, attempts[index][0].get(key, {}).get("fields", {}).get(field)) for index in reversed(range(len(attempts)))]
            if "min" in spec:
                lines: list[str] = []
                for source, texts in [*tried, (RULES_SOURCE, rules[key]["fields"].get(field))]:
                    # The rules fill a list the model left empty, and only top up one it started.
                    cap = spec["max"] if source != RULES_SOURCE or not lines else spec["min"]
                    for text in texts or []:
                        if len(lines) < cap and text.casefold() not in {line.casefold() for line in lines}:
                            lines.append(text)
                            sources.add(source)
                fields[field] = lines
            else:
                source, text = next(((index, text) for index, text in tried if text), (RULES_SOURCE, None))
                fields[field] = text or rules[key]["fields"].get(field) or ""
                sources.add(source)
        used = {source for source in sources if source != RULES_SOURCE}
        ids = {claim for index in used for claim in attempts[index][0].get(key, {}).get("claims", set())}
        ids |= detect([text for value in fields.values() for text in (value if isinstance(value, list) else [value])], claims)
        piece_out = {"channel": CHANNEL_NAMES[key], **fields, "claims": [c["id"] for c in claims if c["id"] in ids],
                     "source": "rules" if not used else "agent" if RULES_SOURCE not in sources else "mixed"}
        if key == "spotify":
            words = len(fields["script"].split())
            piece_out["words"], piece_out["seconds"] = words, round(words / WORDS_PER_SECOND)
        out[key] = piece_out
        if used:
            latest = max(used | ({latest} if latest is not None else set()))
    return out, latest


# ---------- The kit ----------

def channel_keys(design: dict) -> list[str]:
    """The copy to write: one piece per channel of the launch plan, and the poster."""
    plan = design.get("launch") if isinstance(design.get("launch"), dict) else {}
    present = {CHANNELS.get(c.get("channel")) for c in plan.get("channels") or [] if isinstance(c, dict)}
    return [key for key in FORMATS if key in present or key == "poster"]


def make_poster(
    run: RunState, design: dict, name: str, piece: dict | None, claims: list[dict], facts: Facts,
    row: dict | None = None, streets: dict | None = None,
) -> dict:
    """What the poster says and the shapes it is drawn from: the walk's outline, the door, the neighborhoods, and the
    map around them (poster_map)."""
    tagline = design.get("tagline")
    tagline = " ".join(tagline.split()) if isinstance(tagline, str) and tagline.strip() else None
    if tagline and facts.check(tagline, chars=90):
        tagline = None
    used = set((piece or {}).get("claims") or [])
    lead = next((c for c in claims if c["id"] in used), None) or (claims[0] if claims else None)
    return {
        "name": name,
        "tagline": tagline,
        "headline": (piece or {}).get("headline"),
        "subline": (piece or {}).get("subline"),
        "claim": {key: lead[key] for key in ("kind", "line", "proof")} if lead else None,
        "hours": design.get("hours"),
        "minutes": run.site.minutes,
        "area_label": run.site.area,
        "ring": walk_outline(run),
        "site": [run.site.lat, run.site.lon],
        "neighborhoods": neighborhoods_of(run, design),
        "map": poster_map(run, row, claims, streets),
    }


def poster_map(run: RunState, row: dict | None, claims: list[dict], streets: dict | None) -> dict:
    """The poster's map: the street map around the survey's area (None when OpenStreetMap did not answer) and, when the
    launch plan may say people here cross town for this kind of place (its 'closer' claim), the trips they make now as
    distances and bearings from the door. Never a name or a location: an ad does not point at another business."""
    km = row.get("median_far_km") if row else None
    if not row or km is None or not any(claim.get("kind") == "closer" for claim in claims):
        return {"streets": streets, "trips": [], "caption": None}
    trips = [{"km": trip["km"], "bearing": trip["bearing"]} for trip in map_trips(run, row)]
    kind = plural(row["genre"])
    kind = in_sentence(row["genre"]) if kind.endswith(" places") else kind  # 'for seafood', 'for bakeries'
    caption = f"{number(km)} km: where {people_here(run.site.ages)} go for {kind} now" if trips else None
    return {"streets": streets, "trips": trips, "caption": caption}


def _kit_maps(payload: object) -> list[tuple[dict, bool]]:
    """The maps a kit draws over the street map: the poster's, and the report cover's (True: its note names sources)."""
    if not isinstance(payload, dict):
        return []
    poster, dossier = payload.get("poster"), payload.get("dossier")
    cover = dossier.get("cover") if isinstance(dossier, dict) else None
    return [(part["map"], is_cover) for part, is_cover in ((poster, False), (cover, True))
            if isinstance(part, dict) and isinstance(part.get("map"), dict)]


def lacks_street_map(payload: object) -> bool:
    """Whether a kit's maps were drawn without the street map, as when no source of it answered while the kit was
    built. A kit made before its maps existed has none to fill."""
    return any(not kit_map.get("streets") for kit_map, _ in _kit_maps(payload))


def with_street_map(payload: dict, streets: dict) -> dict:
    """The kit with `streets` (app.basemap.street_map) in each map that lacks it, the poster's and the report cover's,
    whose note on its sources then names the streets' too; the payload given is left as it was."""
    kit = copy.deepcopy(payload)
    for kit_map, is_cover in _kit_maps(kit):
        if kit_map.get("streets"):
            continue
        kit_map["streets"] = streets
        if is_cover and isinstance(kit_map.get("basis"), str):
            kit_map["basis"] += streets_basis(streets)
    return kit


def make_links(keys: list[str], name: str, genre: str) -> list[dict]:
    """UTM tags per channel; the page adds the owner's website in front of the query."""
    tag = campaign(name, genre)
    out = []
    for key in keys:
        source, medium = UTM[key]
        params = {"utm_source": source, "utm_medium": medium, "utm_campaign": tag}
        out.append({"key": key, "channel": CHANNEL_NAMES[key], **params, "query": urlencode(params)})
    return out


async def build_kit(
    llm: LLM | None, run: RunState, index: int, design: dict, answers: AnswerCache | None = None,
    streets: dict | Awaitable[dict | None] | None = None,
) -> dict:
    """The launch kit for concept `index` and its design sheet: checked ad copy per channel, the poster, tracked links
    and the dossier. Works without a model: the rules then write every line. The notes tell the owner what the kit left
    out and why, led by a plain warning when the concept is an untested wildcard. `streets` is the street map around
    the walk for the poster's and the cover's maps (app.basemap), or what will give it, awaited once the copy is
    written so the two are fetched at once."""
    concept = concept_at(run, index)
    genre = concept["genre"]
    name = business_name(run, concept, design)
    claims, notes = usable_claims(concept, design)
    keys = channel_keys(design)
    facts = facts_for(run, concept, design, name, claims)
    warning = untested(concept)
    notes = ([warning] if warning else []) + notes + facts.left_out
    hoods = neighborhoods_of(run, design)
    brief = Brief(name, singular(genre), scoring.genre_title(genre), hoods[0] if hoods else None, run.site.reach,
                  design.get("hours"), claims)
    rules = {key: RULES[key](brief, facts) for key in keys}
    payload = json.dumps(model_brief(run, concept, design, name, claims, keys, facts), ensure_ascii=False)
    attempts, rejected = await write_copy(llm, answers, payload, keys, facts, claims)
    ads, latest = merge(keys, attempts, rules, claims)
    streets = await streets if inspect.isawaitable(streets) else streets
    return {
        "concept": {"index": index, "name": name, "genre": genre},
        "claims": claims,
        "copy": ads,
        "poster": make_poster(run, design, name, ads.get("poster"), claims, facts, gap_for(run, genre), streets),
        "links": make_links(keys, str(concept.get("name") or name), genre),
        "dossier": build_dossier(run, index, design, ads, streets=streets),
        "rejected": rejected,
        "notes": notes,
        "mode": "agent" if latest is not None else "rules",
        "model": attempts[latest][1] if latest is not None else None,
        "built_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
