"""Evidence gathering: each function answers one question about a site using Qloo."""
from __future__ import annotations

import asyncio
import inspect
import math
import re
from collections.abc import Awaitable

from . import osm, scoring
from .catchment import Catchment
from .demographics import age_signal
from .geo import distance_m, point_wkt
from .qloo import QlooClient, QlooError

TASTE_M = 1500  # neighborhood used for brand and artist taste
METRO_M = 20_000  # the wider city, used for the city's own favorite places
FAVORITES_M = 15_000  # where locals' favorite places are searched for
MIN_AROUND_M = 900  # smallest "surrounding area" used to predict supply
NEARBY_LIMIT = 100  # places of a genre counted inside the walk
AROUND_LIMIT = 150  # places of a genre counted in the surrounding area
GAP_GENRES = 8
LOOKUPS = 24  # places only OpenStreetMap seems to show, looked up by name on Qloo per cross-check
REF_BEARINGS = (0, 60, 120, 180, 240, 300)
TASTE_REF_BEARINGS = (30, 150, 270)
TASTE_DOMAINS = {
    "brands": "urn:entity:brand",
    "artists": "urn:entity:artist",
    "movies": "urn:entity:movie",
    "tv": "urn:entity:tv_show",
    "podcasts": "urn:entity:podcast",
}
# The tags that say what a distinctive title or brand is, per taste domain, kept on its card for the themed wild card
# (survey/themes.py): media genres and the specific subgenres for films and shows, Qloo's and the music catalog's genres
# for artists, and a brand's industry before its genre, which is broad (Patagonia's genres are Casual, Fashion and
# Athletic; its industry is Outdoor Equipment).
TASTE_GENRES = {
    "brands": ("urn:tag:industry:qloo", "urn:tag:genre:brand"),
    "artists": ("urn:tag:genre:qloo", "urn:tag:genre:music"),
    "movies": ("urn:tag:genre:media", "urn:tag:genre:qloo", "urn:tag:subgenre:qloo"),
    "tv": ("urn:tag:genre:media", "urn:tag:genre:qloo", "urn:tag:subgenre:qloo"),
    "podcasts": ("urn:tag:genre:media",),
}
CARD_GENRES = 8  # a title's genres and its specific subgenres, while the taste event stays small


def around_radius(catchment: Catchment) -> int:
    """The fallback around area when routing failed: a circle twice the walk's radius."""
    return max(MIN_AROUND_M, round(2 * catchment.radius_m))


# A drive or a long road distance can be wider than the walk-sized defaults: the favorites, the city's favorites and the
# taste neighborhood grow with the area, so the places people travel to still lie beyond it.
def favorites_m(catchment: Catchment) -> int:
    return max(FAVORITES_M, round(2.5 * catchment.radius_m))


def metro_m(catchment: Catchment) -> int:
    return max(METRO_M, round(3 * catchment.radius_m))


def taste_m(catchment: Catchment) -> int:
    return max(TASTE_M, round(catchment.radius_m))


def around_filter(catchment: Catchment) -> dict:
    """Where supply is compared: the area a walk twice as long reaches over the streets, or the fallback circle."""
    if catchment.around:
        return {"filter.location": catchment.around_wkt, "filter.location.radius": 0}
    return circle_filter(catchment.lat, catchment.lon, around_radius(catchment))


def around_area_m2(catchment: Catchment) -> float:
    return catchment.around_area_m2 or math.pi * around_radius(catchment) ** 2


def offset_point(lat: float, lon: float, distance_m: float, bearing_deg: float) -> tuple[float, float]:
    d_lat = distance_m * math.cos(math.radians(bearing_deg)) / 111_320
    d_lon = distance_m * math.sin(math.radians(bearing_deg)) / (111_320 * math.cos(math.radians(lat)))
    return lat + d_lat, lon + d_lon


# A comparison area where Qloo lists fewer places than this is open water, a rail yard or an airfield, not a neighborhood.
MIN_REF_PLACES = 3
# Where to look instead, in order: nearer and farther along the bearing, then turned a little either way.
REF_ALTERNATIVES = ((0.7, 0), (1.4, 0), (1.0, 30), (1.0, -30), (0.7, 30), (0.7, -30))


async def populated(q: QlooClient, point: tuple[float, float], radius: float) -> bool:
    places = await places_in(q, circle_filter(*point, round(radius)), take=MIN_REF_PLACES, include_closed=True)
    return len(places) >= MIN_REF_PLACES


async def land_centres(
    q: QlooClient, lat: float, lon: float, radius_m: float, distance_m: float, bearings,
) -> list[tuple[float, float]]:
    """The comparison centres: each bearing's point when Qloo lists places around it, otherwise the first alternative
    nearer, farther or a little to either side that has some; a bearing with none (open sea) is left out, and an
    alternative within a radius of another centre is kept once."""
    async def centre(bearing: float) -> tuple[float, float] | None:
        for factor, turn in ((1.0, 0), *REF_ALTERNATIVES):
            point = offset_point(lat, lon, distance_m * factor, bearing + turn)
            if await populated(q, point, radius_m):
                return point
        return None

    kept: list[tuple[float, float]] = []
    for point in await asyncio.gather(*(centre(bearing) for bearing in bearings)):
        if point and all(distance_m_between(point, other) >= radius_m for other in kept):
            kept.append(point)
    return kept


def reference_distance(radius_m: float) -> float:
    return max(2500.0, 3.5 * radius_m)


def distance_m_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    return distance_m(a[0], a[1], b[0], b[1])


async def places_in(
    q: QlooClient, location: dict, tag: str | None = None, take: int = 50, offset: int = 0, include_closed: bool = False,
) -> list[dict]:
    params = {"filter.type": "urn:entity:place", **location, "take": take}
    if tag:
        params["filter.tags"] = tag
    if offset:
        params["offset"] = offset
    found = scoring.entities(await q.insights(params))
    return found if include_closed else [place for place in found if scoring.is_open(place)]


PAGE = 50


async def places_found(q: QlooClient, location: dict, tag: str, limit: int) -> list[dict]:
    """Every place of a genre in an area, open or closed, page by page until `limit` places have been fetched."""
    found: dict[str, dict] = {}
    offset = 0
    while offset < limit:
        # Closed places are dropped only after paging: a full page tells whether there is another one.
        page = await places_in(q, location, tag=tag, take=PAGE, offset=offset, include_closed=True)
        for place in page:
            found.setdefault(scoring.item_id(place) or f"#{len(found)}", place)
        if len(page) < PAGE:
            break
        offset += PAGE
    return list(found.values())


async def places_upto(q: QlooClient, location: dict, tag: str, limit: int) -> list[dict]:
    """Every open place of a genre in an area, page by page up to `limit`: Qloo returns at most 50 per request, and a
    dense city has more cafés than that within a kilometre, which would make every genre look equally common."""
    return [place for place in await places_found(q, location, tag, limit) if scoring.is_open(place)][:limit]


def walk_filter(catchment: Catchment) -> dict:
    return {"filter.location": catchment.wkt, "filter.location.radius": 0}


def circle_filter(lat: float, lon: float, radius: int) -> dict:
    return {"filter.location": point_wkt(lat, lon), "filter.location.radius": radius}


async def scan_walk(q: QlooClient, catchment: Catchment) -> tuple[list[dict], list[dict]]:
    """Up to 100 places inside the walking catchment, deduplicated, as (open, closed): the closed ones are no part of
    the block, but OpenStreetMap often still shows them, and the cross-check must know Qloo lists them as closed."""
    location = walk_filter(catchment)
    first, second = await asyncio.gather(
        places_in(q, location, include_closed=True), places_in(q, location, offset=50, include_closed=True),
    )
    seen: set[str] = set()
    places = []
    for place in first + second:
        pid = scoring.item_id(place)
        if pid and pid not in seen:
            seen.add(pid)
            places.append(place)
    return [p for p in places if scoring.is_open(p)], [p for p in places if not scoring.is_open(p)]


async def _genre_ranking(q: QlooClient, signal: dict) -> list[dict]:
    data = await q.insights({"filter.type": "urn:tag", "filter.tag.types": "urn:tag:genre:place", **signal, "take": 50})
    return [tag for tag in scoring.tags(data) if tag.get("name") and scoring.item_id(tag)]


async def demand_genres(q: QlooClient, catchment: Catchment, ages: str = "all") -> tuple[list[dict], list[str]]:
    """Place genres the people in the catchment engage with, ranked here and in same-size areas around (on land).

    With an age focus, every ranking leans toward that age group (Qloo's demographic signal), here and around alike.
    """
    radius = max(300, round(catchment.radius_m))
    centres = await land_centres(
        q, catchment.lat, catchment.lon, radius, reference_distance(catchment.radius_m), REF_BEARINGS,
    )
    focus = age_signal(ages)
    local, *references = await asyncio.gather(
        _genre_ranking(q, {"signal.location": catchment.wkt, **focus}),
        *(
            _genre_ranking(q, {"signal.location": point_wkt(lat, lon), "signal.location.radius": radius, **focus})
            for lat, lon in centres
        ),
    )
    reference_ranks = []
    for reference in references:
        business = [tag for tag in reference if scoring.is_business_genre(tag["name"])]
        if business:
            reference_ranks.append({scoring.item_id(tag): rank for rank, tag in enumerate(business, 1)})
    business, cues = [], []
    for tag in local:
        name = tag["name"]
        if scoring.is_taste_cue(name):
            cues.append(name)
        elif scoring.is_business_genre(name):
            business.append({"id": scoring.item_id(tag), "name": name})
    for rank, genre in enumerate(business, 1):
        genre["rank"] = rank
        genre["ref_rank"] = (
            scoring.reference_rank([ranks.get(genre["id"]) for ranks in reference_ranks])
            if len(reference_ranks) >= 3 else None
        )
        # How many comparison areas the median is over: fewer than six when some fell in open water.
        genre["ref_areas"] = len(reference_ranks) if genre["ref_rank"] is not None else 0
    return business, cues[:6]


def near(entities: list[dict], lat: float, lon: float, limit_m: float = 1.5 * FAVORITES_M) -> list[dict]:
    """Favorites are searched within FAVORITES_M of the site; a place located far beyond that is a data error, never a
    trip, so it is dropped. Places without a location are kept: they draw nothing."""
    out = []
    for entity in entities:
        location = scoring.place_location(entity)
        if location is None or distance_m(lat, lon, *location) <= limit_m:
            out.append(entity)
    return out


async def genre_evidence(q: QlooClient, catchment: Catchment, genre: dict, ages: str = "all") -> dict:
    lat, lon = catchment.lat, catchment.lon
    reach = favorites_m(catchment)
    favorites_area = circle_filter(lat, lon, reach)
    focus = age_signal(ages)  # whose favorites: the owner's age focus, or everyone's
    inside, around, local_favorites, city_favorites = await asyncio.gather(
        places_found(q, walk_filter(catchment), genre["id"], NEARBY_LIMIT),
        places_upto(q, around_filter(catchment), genre["id"], AROUND_LIMIT),
        places_in(q, {"signal.location": catchment.wkt, **favorites_area, **focus}, tag=genre["id"], take=20),
        places_in(
            q,
            {"signal.location": point_wkt(lat, lon), "signal.location.radius": metro_m(catchment), **favorites_area, **focus},
            tag=genre["id"],
            take=20,
        ),
    )
    nearby = [place for place in inside if scoring.is_open(place)][:NEARBY_LIMIT]
    # Hotels and malls among the favorites make the comparison atypical; places Qloo merely tags with the genre (a
    # museum with a bar for 'Cocktail bar') say nothing about it and are left out of the favorites.
    storefront = scoring.storefront_share(local_favorites[:10])
    local_favorites = near(scoring.relevant(local_favorites, genre["id"], genre["name"]), lat, lon, 1.5 * reach)
    city_favorites = near(scoring.relevant(city_favorites, genre["id"], genre["name"]), lat, lon, 1.5 * reach)
    kind, favorites = scoring.split_favorites(local_favorites, city_favorites)
    row = scoring.gap_signals(
        genre["id"], genre["name"], genre["rank"], genre.get("ref_rank"),
        nearby, around, favorites, kind, storefront,
        (lat, lon), catchment.contains,
        nearby_capped=len(nearby) >= NEARBY_LIMIT, around_capped=len(around) >= AROUND_LIMIT,
    )
    # Examples lead with the places whose main genre this is.
    nearby = scoring.best_examples(nearby, genre["id"], genre["name"])
    favorites = scoring.best_examples(favorites, genre["id"], genre["name"])
    row["competitors"] = [scoring.place_card(p, (lat, lon)) for p in nearby[:8]]
    row["ref_areas"] = genre.get("ref_areas", 0)
    row["favorites"] = [
        {**scoring.place_card(p, (lat, lon)), "within_walk": bool(loc and catchment.contains(*loc))}
        for p, loc in ((p, scoring.place_location(p)) for p in favorites)
    ]
    row["city_favorites"] = [p.get("name") for p in city_favorites[:6] if p.get("name")]
    row["_favorite_entities"] = favorites
    row["_nearby_entities"] = nearby
    # Qloo lists these inside the walk as closed: OpenStreetMap may still show them, and they are no extra supply.
    row["_closed_nearby"] = [
        {"entity_id": scoring.item_id(p), "name": p.get("name"), "location": p.get("location")}
        for p in inside if not scoring.is_open(p)
    ]
    return row


def cross_check_rows(rows: list[dict], check: osm.CrossCheck | None) -> osm.CrossCheck:
    """Learns every row's Qloo places before any row is checked: Qloo may list a bakery as a Mexican restaurant."""
    check = check or osm.CrossCheck(None)
    for row in rows:
        check.learn_row(row)
    return check


async def cross_check(q: QlooClient, rows: list[dict], check: osm.CrossCheck | None) -> None:
    """Adds to each row what OpenStreetMap shows inside the walk (row['osm']), without the cross-check, that it is off.

    A place only OpenStreetMap seems to show is looked up by name on Qloo around where it stands (the nearest
    LOOKUPS of them), so "Qloo doesn't list it" is checked rather than assumed from the lists the survey read."""
    check = cross_check_rows(rows, check)

    async def lookup(place: dict) -> list[dict]:
        try:
            return await search_places(q, place["name"], place["lat"], place["lon"], miles=1, take=5)
        except QlooError:
            return []

    found = await asyncio.gather(*(lookup(place) for place in check.candidates(rows)[:LOOKUPS]))
    for places in found:
        check.learn(places, located_only=True)
    for row in rows:
        check.apply(row)


async def gap_table(
    q: QlooClient, catchment: Catchment, genres: list[dict], focus: str = "any",
    checked: osm.CrossCheck | Awaitable[osm.CrossCheck] | None = None, ages: str = "all",
) -> list[dict]:
    """Rank the neighborhood's top genres by how underserved they are within the walking catchment.

    `checked`: the survey's OpenStreetMap cross-check, or what will give it once OpenStreetMap answers; it is awaited
    only after Qloo's evidence is in, and applied before the rows are scored, so supply counts both maps.
    """
    candidates = gap_candidates(genres, focus)
    rows = list(await asyncio.gather(*(genre_evidence(q, catchment, genre, ages) for genre in candidates)))
    await cross_check(q, rows, await checked if inspect.isawaitable(checked) else checked)
    return scoring.score_gaps(rows, catchment.area_m2, around_area_m2(catchment))


def gap_candidates(genres: list[dict], focus: str = "any") -> list[dict]:
    """Spend the same query budget across the requested sectors, then let measured gap scores decide the winners."""
    ranked = [genre for genre in genres if scoring.matches_focus(genre["name"], focus)]
    if focus != "any":
        return ranked[:GAP_GENRES]
    picked = ranked[:max(1, GAP_GENRES - 2)]
    # Food-heavy demand rankings must not prevent retail or leisure from being measured at all.
    for sector in ("retail", "leisure"):
        if not any(scoring.matches_focus(genre["name"], sector) for genre in picked):
            candidate = next((genre for genre in ranked if genre not in picked
                              and scoring.matches_focus(genre["name"], sector)), None)
            if candidate is not None and len(picked) < GAP_GENRES:
                picked.append(candidate)
    for genre in ranked:
        if len(picked) >= GAP_GENRES:
            break
        if genre not in picked:
            picked.append(genre)
    return sorted(picked, key=lambda genre: ranked.index(genre))


async def find_genre(q: QlooClient, ranked: list[dict], query: str) -> tuple[dict | None, str | None]:
    """Resolve free text ('bakeries', 'board game cafe', 'taco shop') to a storefront place genre, or say why it cannot.

    Genres locals already rank keep their local and reference ranks; others come from Qloo's tag search and are
    marked unranked, which is itself evidence of weak local demand. A search result only counts when its words match
    the query's (exactly, more specific or broader): "art gallery" must not become "Aboriginal art gallery". The text
    is read as genre_readings gives it, in turn; when none finds a category, the first reading's reason is given.
    """
    first_reason = None
    for text, near in genre_readings(query):
        genre, why = await _find_genre_as(q, ranked, text, query, near)
        if genre:
            return genre, None
        first_reason = first_reason or why
    return None, first_reason


# Everyday names for categories Qloo files under another name, keyed by _normalize_genre's form: a whole query, then
# single words ('burger joint' -> 'hamburger joint').
CASUAL_NAMES = {
    "flower shop": "florist", "flower": "florist", "juice bar": "juice shop", "smoothie bar": "juice shop",
    "smoothie": "juice shop", "noodle bar": "noodle shop", "gelateria": "ice cream shop", "gelato": "ice cream shop",
    "bookshop": "book store", "book shop": "book store",
}
CASUAL_WORDS = {"taqueria": "taco", "boba": "bubble tea", "burger": "hamburger", "bike": "bicycle"}
# Words that only say a place is a business ('taco shop', 'pizza place'). Without them only Qloo's exact category
# counts, so 'pet store' never becomes 'Pet sitter'.
BUSINESS_WORDS = {"shop", "place", "spot", "joint", "stand", "outlet", "business"}


def genre_readings(query: str) -> list[tuple[str, bool]]:
    """The texts a business is looked up by, each with whether a near match (more specific or broader) counts: its
    everyday name's category first ('taqueria' -> 'taco'), then the words as typed, then without the words that only
    say it is a business ('taco shop' -> 'taco'), which must name a category exactly."""
    typed = " ".join(query.strip().lower().split())
    key = _normalize_genre(typed)
    casual = CASUAL_NAMES.get(key) or " ".join(CASUAL_WORDS.get(word, word) for word in key.split())
    readings = ([(casual, True)] if casual != key else []) + [(typed, True)]
    bare = " ".join(word for word in _normalize_genre(casual).split() if word not in BUSINESS_WORDS)
    if bare:
        readings.append((bare, False))
    seen: set[str] = set()
    distinct = []
    for text, near in readings:
        if text and _normalize_genre(text) not in seen:
            seen.add(_normalize_genre(text))
            distinct.append((text, near))
    return distinct


async def _find_genre_as(
    q: QlooClient, ranked: list[dict], text: str, query: str, near: bool,
) -> tuple[dict | None, str | None]:
    """find_genre for one reading of the owner's `query`; without `near`, only an exact category counts."""
    wanted = _normalize_genre(text)
    exact = next(
        (genre for genre in ranked if _normalize_genre(genre["name"]).replace(" ", "") == wanted.replace(" ", "")), None,
    )
    if exact:
        return exact, None
    data = await q.tags({"filter.query": text.strip()[:60], "filter.tag.types": "urn:tag:genre:place", "take": 10})
    best = None
    for position, tag in enumerate(scoring.tags(data)):
        tag_id, name = scoring.tag_id(tag), tag.get("name")
        quality = _match_quality(wanted, _normalize_genre(name)) if tag_id and name else 0
        if quality and not near and quality < 3:
            quality = 0
        if quality and (best is None or (-quality, len(name.split()), position) < best[0]):
            best = ((-quality, len(name.split()), position), tag_id, name)
    if best is None:
        return None, f"Qloo has no storefront category matching '{query}'."
    _, tag_id, name = best
    if name.strip().lower() in scoring.GENERIC_GENRES:
        return None, f"Qloo has no specific storefront category for '{query}', only the generic {name}."
    if not scoring.is_business_genre(name):
        return None, f"Qloo treats {name} as a taste cue or a non-storefront place, not a business to open here."
    known = next((genre for genre in ranked if genre["id"] == tag_id), None)
    return known or {"id": tag_id, "name": name, "rank": scoring.UNRANKED, "ref_rank": None}, None


def _match_quality(query: str, name: str) -> int:
    if query == name or query.replace(" ", "") == name.replace(" ", ""):  # "bookstore" is Qloo's "Book store"
        return 3
    query_words, name_words = set(query.split()), set(name.split())
    if query_words <= name_words:
        return 2  # a more specific category: "bakery" -> "vegan bakery"
    if name_words <= query_words:
        return 1  # a broader one: "natural wine bar" -> "wine bar"
    return 0


def _normalize_genre(text: str) -> str:
    text = " ".join(text.lower().replace("-", " ").split())
    text = text.removesuffix(" restaurants").removesuffix(" restaurant")
    # A shop and a store are one thing: 'bubble tea shop' is Qloo's 'Bubble tea store', 'bookshop' its 'Book store'.
    text = " ".join("shop" if word in ("store", "stores") else word for word in text.split())
    text = text.replace("bookstore", "bookshop")
    if text.endswith("ies"):
        return text[:-3] + "y"
    if text.endswith(("ches", "shes", "sses", "xes")):
        return text[:-2]
    return text[:-1] if text.endswith("s") and not text.endswith("ss") else text


async def probe_genre(q: QlooClient, catchment: Catchment, genre: dict, table: list[dict], ages: str = "all") -> dict:
    """Live evidence for one more genre, scored on the same supply baseline as the site's gap table and cross-checked
    with the survey's OpenStreetMap places (osm.current())."""
    row = await genre_evidence(q, catchment, genre, ages)
    await cross_check(q, [row], osm.current())
    return scoring.score_gaps([row], catchment.area_m2, around_area_m2(catchment), baseline_rows=table)[0]


async def fan_taste(
    q: QlooClient, lat: float, lon: float, tag_id: str, take: int = 15, ages: str = "all", radius: int = TASTE_M,
) -> dict:
    """Brands and artists that people who love a genre also love (Qloo cross-domain affinity, biased to the site and,
    with an age focus, to that age group).

    Mostly the category's audience at large rather than locals: seafood lovers rank much the same in Brooklyn and Cairo.
    """
    signal = {
        "signal.interests.tags": tag_id,
        "signal.location": point_wkt(lat, lon),
        "signal.location.radius": radius,
        "filter.popularity.min": 0.1,
        "take": take,
        **age_signal(ages),
    }
    brands, artists = await asyncio.gather(
        q.insights({"filter.type": "urn:entity:brand", **signal}),
        q.insights({"filter.type": "urn:entity:artist", **signal}),
    )
    return {
        "brands": [
            scoring.entity_card(e) for e in scoring.entities(brands)
            if scoring.is_commercial_brand(e) and scoring.is_safe_name(e.get("name"))
        ][:10],
        "artists": [scoring.entity_card(e) for e in scoring.entities(artists) if scoring.is_safe_name(e.get("name"))][:10],
    }


async def _ranked(
    q: QlooClient, entity_type: str, lat: float, lon: float, radius: int, take: int = 30, ages: str = "all",
) -> list[dict]:
    return scoring.entities(await q.insights({
        "filter.type": entity_type,
        "filter.popularity.min": 0.1,
        "signal.location": point_wkt(lat, lon),
        "signal.location.radius": radius,
        "take": take,
        **age_signal(ages),
    }))


async def local_taste(q: QlooClient, lat: float, lon: float, ages: str = "all", radius: int = TASTE_M) -> dict:
    """What the neighborhood loves and over-indexes on versus same-size areas around, across taste domains.

    Brands and artists keep their popular lists too (they show when Qloo ranks the categories' fans like everyone
    else); for films, shows and podcasts only the distinctive ones are kept: popular ones are popular everywhere. With
    an age focus, here and around alike lean toward that age group. Each distinctive card keeps its `genres`
    (TASTE_GENRES), which the themed wild card reads.
    """
    refs = await land_centres(q, lat, lon, radius, reference_distance(radius), TASTE_REF_BEARINGS)
    kinds = list(TASTE_DOMAINS.values())
    lists = await asyncio.gather(*(
        _ranked(q, kind, r_lat, r_lon, radius, ages=ages) for kind in kinds for r_lat, r_lon in [(lat, lon), *refs]
    ))
    per_kind = len(refs) + 1
    taste: dict[str, list[dict]] = {}
    for index, domain in enumerate(TASTE_DOMAINS):
        local, *references = lists[index * per_kind:(index + 1) * per_kind]
        if domain == "brands":
            local = [e for e in local if scoring.is_commercial_brand(e)]
        if domain in ("brands", "artists"):
            taste[domain] = [scoring.entity_card(e) for e in local if scoring.is_safe_name(e.get("name"))][:12]
        taste[f"distinctive_{domain}"] = [
            {**scoring.entity_card(e), "genres": scoring.tag_names(e, TASTE_GENRES[domain], CARD_GENRES)}
            for e in scoring.distinctive_by_rank(local, references)
        ]
    return taste


def same_category(query: str, name: str) -> bool:
    """Whether the owner typed a category's own name ('bakeries' for 'Bakery'), not a brand that contains it."""
    return _normalize_genre(query).replace(" ", "") == _normalize_genre(name).replace(" ", "")


# Words a chain's name or the owner's query can carry without changing which chain it is: 'a Starbucks franchise',
# 'Blue Bottle' for 'Blue Bottle Coffee'.
CHAIN_FILLER = {"a", "an", "the", "new", "franchise", "branch", "store", "shop", "outlet", "location", "cafe", "café",
                "coffee", "restaurant", "bar", "company", "co"}


def _name_words(text: str) -> list[str]:
    text = text.lower().replace("’", "'").replace("'s", "s").replace("'", "")
    return re.findall(r"[a-z0-9&]+", text)


def is_brand_named(query: str, name: str) -> bool:
    """Whether the owner named this chain. Qloo's brand search is fuzzy ('bakery' finds Carlo's Bakery, 'Joe Coffee'
    finds Trader Joe's), so a chain counts only when all its name's words are in the query and the query adds only
    filler, or when the query is its name without trailing filler and still at least two words ('Blue Bottle')."""
    words, brand = _name_words(query), _name_words(name)
    core = [w for w in brand if w not in CHAIN_FILLER]
    if not words or not core:
        return False
    extra = set(words) - set(brand)
    if set(brand) <= set(words) and extra <= CHAIN_FILLER and len("".join(brand)) >= 4:
        return True
    return len(core) >= 2 and core == [w for w in words if w not in CHAIN_FILLER]


async def find_brand(q: QlooClient, query: str) -> dict | None:
    """The chain the owner named ('Starbucks', 'a Shake Shack'), when Qloo knows one by that name."""
    if not _name_words(query):
        return None
    data = await q.search({"query": query.strip()[:80], "types": "urn:entity:brand", "take": 5})
    results = data.get("results")
    for brand in results if isinstance(results, list) else []:
        if isinstance(brand, dict) and brand.get("entity_id") and is_brand_named(query, brand.get("name") or ""):
            return brand
    return None


async def brand_stores(q: QlooClient, location: dict, brand_id: str, limit: int) -> tuple[list[dict], bool]:
    """The open places of a chain in an area (Qloo's filter.references_brand), page by page until `limit` open ones are
    found, and whether there may be more than `limit` (paging stopped on a full page). Closed places Qloo still lists are
    skipped, so a few extra pages may be read, never more than two."""
    found: dict[str, dict] = {}
    offset, more = 0, False
    for _ in range(math.ceil(limit / PAGE) + 2):
        params = {"filter.type": "urn:entity:place", "filter.references_brand": brand_id, **location, "take": PAGE}
        if offset:
            params["offset"] = offset
        page = scoring.entities(await q.insights(params))
        for place in page:
            found.setdefault(scoring.item_id(place) or f"#{len(found)}", place)
        more = len(page) == PAGE  # a full page: Qloo may list more
        if not more or sum(1 for place in found.values() if scoring.is_open(place)) > limit:
            break
        offset += PAGE
    stores = [place for place in found.values() if scoring.is_open(place)]
    return stores[:limit], more and len(stores) >= limit


async def search_places(q: QlooClient, query: str, lat: float, lon: float, miles: int = 2, take: int = 8) -> list[dict]:
    """Places whose name matches, near a point. Qloo's search radius is in miles and results are ranked by relevance."""
    data = await q.search({
        "query": query.strip()[:80], "types": "urn:entity:place", "filter.location": f"{lat},{lon}",
        "filter.radius": miles, "take": take,
    })
    results = data.get("results")
    return [e for e in results if isinstance(e, dict) and e.get("entity_id")] if isinstance(results, list) else []


async def place_by_id(q: QlooClient, entity_id: str) -> dict | None:
    """The full record of a place.

    /entities returns a thin record (no keywords, reviews or Michelin), so the place is found through it and then read
    from insights within a few meters of its location, where Qloo returns everything it knows.
    """
    data = await q.entities({"entity_ids": entity_id})
    results = data.get("results")
    found = results if isinstance(results, list) else (results or {}).get("entities", []) if isinstance(results, dict) else []
    thin = next((e for e in found if scoring.item_id(e) == entity_id), None)
    location = scoring.place_location(thin) if thin else None
    if not location:
        return thin
    # The owner's own record is read even when Qloo marks the place closed, so the owner can still compare it.
    around = await places_in(q, circle_filter(*location, 60), take=20, include_closed=True)
    return next((e for e in around if scoring.item_id(e) == entity_id), thin)


async def genre_heatmap(q: QlooClient, lat: float, lon: float, tag: str, radius: int = 3000) -> list[dict]:
    data = await q.insights({
        "filter.type": "urn:heatmap",
        "filter.location": point_wkt(lat, lon),
        "filter.location.radius": radius,
        "signal.interests.tags": tag,
    })
    cells = ((data.get("results") or {}).get("heatmap")) or []
    return [
        {
            "lat": c["location"]["latitude"],
            "lon": c["location"]["longitude"],
            "geohash": c["location"].get("geohash"),
            "affinity": round(c["query"].get("affinity_rank", c["query"].get("affinity", 0)), 3),
        }
        for c in cells
        if c.get("location") and c.get("query")
    ]
