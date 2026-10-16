Feature: Editing the live deck
  As the canvas and the other views of a deck
  I want small, checked edits to the live document
  So that people editing the same deck at once keep each other's work

  Background:
    Given a live document with the slides "intro" and "details" from the sample deck

  Scenario: New ids are short, URL safe and different every time
    When 1000 slide ids and 1000 element ids are made
    Then every slide id is "s-" and 10 URL safe characters
    And every element id is "e-" and 10 URL safe characters
    And no two ids are the same

  Scenario: Inserting a slide puts it where it is asked
    When a slide "agenda" with one text box is inserted at position 1
    Then the slides are "intro", "agenda" and "details"
    And the text box of "agenda" reads "# Agenda"

  Scenario: A slide that breaks the rules is refused and nothing changes
    When a slide with the id "details" is inserted
    Then the edit fails with "A slide with the id \"details\" already exists"
    When a slide with an image without a source is inserted
    Then the edit fails with "The slide is not valid"
    When a slide whose frontmatter holds the key "id" is inserted
    Then the edit fails with "The frontmatter key \"id\" is kept for the slide id"
    And the document did not change

  Scenario: The last slide cannot be deleted
    When the slide "intro" is deleted
    Then the slides are "details"
    When the slide "details" is deleted
    Then the edit fails with "A deck needs at least one slide"

  Scenario: Moving a slide keeps its id and content
    When the slide "intro" is moved to position 1
    Then the slides are "details" and "intro"
    And the slide "intro" still has its title, its 3D scene and its notes

  Scenario: Duplicating a slide gives the copy fresh ids
    When the slide "details" is duplicated
    Then there are 3 slides and the copy comes right after "details"
    And the copy has the same content as "details" with new slide and element ids

  Scenario: Frontmatter is replaced as a whole
    When the frontmatter of "details" is set to layout "center" and class "text-left"
    Then the frontmatter of "details" is layout "center" and class "text-left"

  Scenario: Frontmatter that YAML cannot write is refused
    When the frontmatter of "details" is set to a count stored as a BigInt
    Then the edit fails with "Frontmatter can only hold text, numbers, true or false, null, lists and maps"
    And the document did not change

  Scenario: Setting notes merges with someone typing in them
    Given Budi has a copy of the document
    When the notes of "intro" are set to "Welcome everyone, and thanks for coming."
    And Budi types "Hello! " at the start of the notes of "intro" at the same time
    And the two documents sync
    Then both documents have the notes "Hello! Welcome everyone, and thanks for coming."

  Scenario: Elements are inserted, restacked and deleted
    When a rectangle "card" is inserted at position 0 of "details"
    Then the elements of "details" are "card", "logo", "box", "code", "player" and "sandbox"
    When "card" is moved to position 5 in the stack of "details"
    Then the elements of "details" are "logo", "box", "code", "player", "sandbox" and "card"
    When "box" is deleted from "details"
    Then the elements of "details" are "logo", "code", "player", "sandbox" and "card"

  Scenario: Duplicating an element offsets the copy
    When "box" on "details" is duplicated with an offset of 20 and 30
    Then a copy of "box" with a new id sits right above it at x 220 y 330

  Scenario: Duplicating an element refuses an offset that would break the copy
    When "box" on "details" is duplicated with an offset that has no y
    Then the edit fails with "The offset field \"y\" must be a finite number"
    When "box" is moved to x 1.7e308 and duplicated with an offset of 1e308 and 0
    Then the edit fails with "The element is not valid"
    And "details" still holds its five elements and no copy

  Scenario: Updating an element changes only what is given
    Given Budi has a copy of the document
    When the title is updated with x 300 and the text "# Intro to Graphs!"
    And Budi types "Big " at the start of the title at the same time
    And Budi changes the title width to 700 at the same time
    And the two documents sync
    Then both documents have the title at x 300 with width 700
    And both documents have the title text "Big # Intro to Graphs!"

  Scenario: Sizes are clamped and broken values are refused
    When the title is moved to width -20 and height -5
    Then the title has width 0 and height 0
    When the title is moved to x "Infinity"
    Then the edit fails with "The position field \"x\" must be a finite number"
    When the type of the title is changed to "image"
    Then the edit fails with "An element cannot change its type from text to image"
    When the title is updated with a "src"
    Then the edit fails with "A text element has no field \"src\""
    When the shape "box" gets the props of a 3D scene
    Then the edit fails with "The element is not valid"

  Scenario: Props, sources and code steps change only when they differ
    When the shape "box" is updated with the props it already has
    Then the document did not change
    When the shape "box" is updated with the fill "#22d3ee"
    Then the shape "box" has the fill "#22d3ee"

  Scenario: A raw block becomes a movable text box
    Given the slide "details" starts with a raw block "## Notes for later"
    When the raw block is made movable at x 40 y 60 with width 300
    Then the first element of "details" is a text box with a new id reading "## Notes for later"
    And the text box sits at x 40 y 60 with width 300 and auto height

  Scenario: Every edit runs as one change with the caller's origin
    When each kind of edit runs once with the origin "canvas"
    Then each one changed the document once, with the origin "canvas"

  Scenario: A document without a deck refuses every edit
    Given a live document that has not loaded its deck
    Then inserting a slide fails with "The deck is not loaded yet"
    And deleting, moving and duplicating a slide fail with "The deck is not loaded yet"
    And setting frontmatter and notes fail with "The deck is not loaded yet"
    And inserting, deleting, moving, duplicating and updating an element fail with "The deck is not loaded yet"
    And making a raw block movable fails with "The deck is not loaded yet"

  Scenario: A text change never splits an emoji
    Given a shared text "I like 😀 a lot"
    When it is changed to "I like 😃 a lot"
    Then the shared text reads "I like 😃 a lot"
    And the change replaced the whole emoji

  Scenario: Text changes for an editor are small and in order
    When the changes from "The quick brown fox" to "The slow brown cat" are listed
    Then they are "quick" to "slow" at 4 and "fox" to "cat" at 16
