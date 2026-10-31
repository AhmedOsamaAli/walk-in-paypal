from app.engine import GAP_GENRES, gap_candidates


def genres(*names):
    return [{"id": f"genre-{i}", "name": name, "rank": i + 1} for i, name in enumerate(names)]


def test_any_business_measures_other_sectors_without_increasing_the_query_budget():
    ranked = genres("Cafe", "Coffee shop", "Bakery", "Brunch", "Breakfast", "Italian restaurant", "Sushi",
                    "Bar", "Gym", "Bookstore", "Florist", "Hair salon")
    found = gap_candidates(ranked)
    assert len(found) == GAP_GENRES
    assert ranked[0] in found and ranked[8] in found and ranked[9] in found
    assert [row["rank"] for row in found] == sorted(row["rank"] for row in found)
    assert ranked == genres("Cafe", "Coffee shop", "Bakery", "Brunch", "Breakfast", "Italian restaurant", "Sushi",
                            "Bar", "Gym", "Bookstore", "Florist", "Hair salon")


def test_a_requested_focus_does_not_inject_other_sectors():
    ranked = genres("Cafe", "Bookstore", "Gym", "Florist", "Hair salon", "Bakery")
    assert [row["name"] for row in gap_candidates(ranked, "retail")] == ["Bookstore", "Florist"]
    assert [row["name"] for row in gap_candidates(ranked, "food_drink")] == ["Cafe", "Bakery"]


def test_missing_other_sector_evidence_is_not_fabricated():
    ranked = genres("Cafe", "Bakery", "Brunch")
    assert gap_candidates(ranked) == ranked
    assert gap_candidates([]) == []


def test_stronger_non_food_evidence_can_lead_the_concepts_without_a_model():
    from app.survey.concepts import rule_concepts
    from tests.test_kit import blank_row, world

    run = world()
    run.gaps = [blank_row("Bookstore", 82, 2), blank_row("Gym", 76, 3), blank_row("Bakery", 45, 4)]
    found = [concept for concept in rule_concepts(run) if not concept.get("wildcard")]
    assert [concept["genre"] for concept in found] == ["Bookstore", "Gym", "Bakery"]
    assert all(concept["gap_score"] == row["gap_score"] for concept, row in zip(found, run.gaps, strict=True))
