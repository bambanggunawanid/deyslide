Feature: Merging Markdown written against an older deck
  As a writer whose Markdown is based on the deck as it was a moment ago
  (the Markdown view, the assistant, Claude Code, a file on disk)
  I want my changes merged with everything others did since
  So that nobody's work is reverted

  Background:
    Given the live deck "Graphs" with a title, notes, a body box and a closing slide
    And Ana reads its Markdown and keeps that state as their base

  Scenario: A change that only deletes is kept when older Markdown merges
    Given Budi deletes the closing slide and the words " and edges" from the body box
    And the live state vector is still the one in Ana's base
    When Ana merges their Markdown with "!" added to the title
    Then the live deck has 2 slides and the body box reads "Nodes"
    And the title reads "# Intro to Graphs!"
    But applying Ana's Markdown directly would have brought the deleted content back

  Scenario: Edits others made since the base survive the merge
    Given Budi moves the shape box to x 600 and types " today" after "Nodes and edges"
    When Ana merges their Markdown with the title changed to "# Intro to Trees"
    Then the live deck has the title "# Intro to Trees"
    And the shape box is at x 600 and the body box reads "Nodes and edges today"
    But applying Ana's Markdown directly would have put the box and the text back

  Scenario: A new slide before a slide Ana edits leaves Budi's typing in the edited slide
    Given Budi types " today" after "Nodes and edges"
    When Ana merges their Markdown with a slide "# Trees" added before the second slide, whose body box now reads "Nodes and links"
    Then the second slide keeps its id, and its body box reads "Nodes and links today"
    And "# Trees" is a slide of its own, with a new id, before it

  Scenario: Deleting a slide next to one Ana edits keeps the edited slide and Budi's typing in it
    Given Budi types " today" after "Nodes and edges"
    When Ana merges their Markdown without the first slide, and with the body box reading "Nodes and links"
    Then the live deck has the second and the closing slide, under their own ids
    And the body box reads "Nodes and links today"

  Scenario: Typing in the same box merges by character
    Given Budi types "Big " into the title after "# "
    When Ana merges their Markdown with " today" added to the end of the title
    Then the title reads "# Big Intro to Graphs today"

  Scenario: Markdown that cannot be read is refused before anything changes
    When Ana merges their Markdown with "<!--" typed in the title
    Then the merge fails as "typing"
    And the live deck did not change

  Scenario: A base the live deck does not contain falls back to applying the Markdown
    Given Ana's base holds an edit the live deck never received
    When Ana merges their Markdown with the title changed to "# Intro to Trees"
    Then the merge says it fell back
    And the live deck holds exactly Ana's Markdown, with nothing left pending

  Scenario: A writer that keeps the merge's text base does not revert others on its next merge
    Given Budi types " today" after "Nodes and edges"
    When Ana merges their Markdown with the title changed to "# Intro to Trees"
    And Ana changes their own Markdown again, adding the notes line "Ask about cycles."
    And Ana merges it from the text base of their first merge
    Then the body box reads "Nodes and edges today"
    And the title reads "# Intro to Trees" and the notes end with "Ask about cycles."
    But merging it from the live state after their first merge would have reverted Budi's words

  Scenario: The assistant's cumulative versions insert a new slide once
    Given the assistant starts a reply from the live deck
    And Budi types " today" after "Nodes and edges" during the reply
    When the reply sends a version that adds a slide "# Summary" at the end
    And the reply sends a version that also changes the title to "# Intro to Trees"
    And the reply sends a version that also adds "- Edges join nodes" to the summary
    Then the live deck has one "# Summary" slide, reading "# Summary\n\n- Edges join nodes"
    And the title reads "# Intro to Trees"
    And the body box reads "Nodes and edges today"

  Scenario: One writer id keeps the state vector small over many merges
    When the Markdown view merges 100 edits with one writer id, each from the live state after the last
    Then the live state vector has 2 entries
    When another 100 edits are merged without a writer id
    Then the live state vector has 102 entries

  Scenario: A writer merging twice from the same base lands both changes
    When Ana merges their Markdown with the title changed to "# Intro to Trees" as the writer "view"
    And the writer "view" merges their Markdown with the body changed to "Vertices" from the same base
    Then the title reads "# Intro to Trees"
    And the body box reads "Vertices"

  Scenario: A writer cannot use the live deck's own client id
    When Ana merges their Markdown as a writer with the live deck's client id
    Then the merge fails with "A merge writer cannot use the client id of the document it merges into"
    And the live deck did not change

  Scenario: Editing a slide that someone moves keeps one copy of it
    Given Budi moves the first slide to the end
    When Ana merges their Markdown with the title changed to "# Intro to Trees"
    Then the live deck has 3 slides in Budi's order, each id once
    And the moved slide kept its old title, since edits to a slide during a move are lost

  Scenario: Undoing a merge restores the deck and keeps others' edits
    Given an undo manager that tracks the origin "markdown"
    And Budi moves the shape box to x 600 and types " today" after "Nodes and edges"
    When Ana merges their Markdown with the title changed to "# Intro to Trees" with the origin "markdown"
    And the merge is undone
    Then the title reads "# Intro to Graphs"
    And the shape box is at x 600 and the body box reads "Nodes and edges today"

  Scenario: A merge into a deck that waits for an update from Budi lands and keeps waiting
    Given Budi's next two edits reach the live deck in the wrong order, so it waits for the first one
    When Ana merges their Markdown with the title changed to "# Intro to Trees"
    Then the title reads "# Intro to Trees" and the live deck still waits for Budi's first edit
    When Budi's first edit arrives
    Then the live deck holds both of Budi's edits, with nothing left waiting

  Scenario: A base taken before the deck loaded is refused
    When Ana merges their Markdown from a base taken before the deck loaded
    Then the merge fails with "The deck is not loaded yet"
    And the live deck did not change
    And a reply that starts from that base fails the same way

  Scenario: A merge waits until the document has a deck
    Given a live document that has not loaded its deck
    When Ana merges their Markdown into it from an empty base
    Then the merge fails with "The deck is not loaded yet"
