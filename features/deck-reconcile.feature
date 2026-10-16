Feature: Markdown into the live deck
  As a person editing a deck as Markdown while others edit it live
  I want my Markdown applied to the live document as small changes
  So that the slides and boxes others are working on keep their place and their text

  Background:
    Given a live document loaded from a three slide deck written as Markdown

  Scenario: Applying the deck's own Markdown changes nothing
    When the deck's Markdown is applied back
    Then the document did not change

  Scenario: Inserting a slide at the top keeps every other slide as it was
    When a slide "# Agenda" is typed above the first slide and applied
    Then there are 4 slides and the first one has a new id
    And the other slides kept their ids
    And the title, the notes and the body text are still the same shared texts

  Scenario: Editing a slide while someone moves a box on another slide keeps both
    Given Budi has a copy of the document
    When the title is changed to "# Intro to Trees" in the Markdown and applied
    And Budi moves the body box to x 300 at the same time
    And the two documents sync
    Then both documents have the title "# Intro to Trees"
    And both documents have the body box at x 300

  Scenario: Typing in the same box from Markdown and from the canvas merges by character
    Given Budi has a copy of the document
    When " today" is added to the end of the title in the Markdown and applied
    And Budi types "Big " into the title after "# " at the same time
    And the two documents sync
    Then both documents have the title "# Big Intro to Graphs today"

  Scenario: A Markdown edit and canvas edits to the same slide keep each other's fields
    Given Budi has a copy of the document, and a value both sides set at once would take the Markdown side
    When the title is changed to "# Intro to Trees" in the Markdown and applied
    And Budi moves the title box to x 300 and sets the first slide's layout to "center" at the same time
    And the two documents sync
    Then both documents have the title "# Intro to Trees" at x 300
    And both documents have the first slide's layout "center"

  Scenario: Moving a shape in the Markdown keeps the fill someone changed on the canvas
    Given Budi has a copy of the document, and a value both sides set at once would take the Markdown side
    When the shape box is moved to x 600 in the Markdown and applied
    And Budi changes the shape's fill to "#22d3ee" at the same time
    And the two documents sync
    Then both documents have the shape at x 600 with the fill "#22d3ee"

  Scenario: Notes changed in the Markdown merge with someone typing in them
    Given Budi has a copy of the document, and a value both sides set at once would take the Markdown side
    When the first slide's notes are changed to "Welcome everyone, and thanks for coming." in the Markdown and applied
    And Budi types "Hello! " at the start of the first slide's notes at the same time
    And the two documents sync
    Then both documents have the notes "Hello! Welcome everyone, and thanks for coming." in the same shared text

  Scenario: Notes the Markdown leaves alone keep the trailing space someone just typed
    Given someone typed a space after "Welcome everyone." in the first slide's notes
    When the title is changed to "# Intro to Trees" in the Markdown and applied
    Then the notes read "Welcome everyone. " with the trailing space, in the same shared text

  Scenario: Changing frontmatter replaces it and leaves the boxes alone
    When the first slide's layout is changed to "center" in the Markdown and applied
    Then the first slide's frontmatter is layout "center"
    And the first slide kept its id and the title is still the same shared text

  Scenario: Reordering slides in the Markdown moves them under their ids
    When the last slide is moved to the top in the Markdown and applied
    Then the slides are the third, the first and the second, with their ids
    And the moved slide still reads "# Thanks"

  Scenario: Deleting a slide in the Markdown deletes only that slide
    When the second slide is removed from the Markdown and applied
    Then the slides are the first and the third, with their ids
    And the title and the notes are still the same shared texts

  Scenario: Editing a Magic Move step changes only that box's steps
    When "sum(prices)" is changed to "total(prices)" in the second Magic Move step and applied
    Then the box "steps" has the steps "let total = 0" and "const total = total(prices)"
    And the box "steps" kept its position
    And the body text is still the same shared text

  Scenario: A box typed without data-id above an older box keeps the older box's text
    Given the second slide has a box saved with the data-id "slide-2:el:1"
    When a new box without data-id is typed above it in the Markdown and applied
    Then the box "slide-2:el:1" is still the same shared text with its own words
    And the new box has a fresh id and reads "New box typed by hand"

  Scenario: Reordering boxes in the Markdown restacks them under their ids
    When the body box and the shape box swap places in the Markdown and applied
    Then the boxes of the second slide are "box", "body" and "steps"

  Scenario: A box whose content becomes an image is replaced under the same id
    When the body text is replaced by an image tag in the Markdown and applied
    Then the box "body" is an image of "https://example.com/graph.png"

  Scenario: A copied box keeps the original and gives the copy a fresh id
    When the shape box is copied with its data-id and moved to x 600 in the Markdown and applied
    Then the box "box" is still the same shape at x 500
    And a second shape at x 600 has a fresh id

  Scenario: Slide ids in the frontmatter pair a slide that moved and changed
    When the deck is written with slide ids, its last slide moved to the top and its text changed, and applied
    Then the slides are the third, the first and the second, with their ids
    And the first slide reads "# Thanks a lot"

  Scenario: A deck from an older client with place based ids keeps the slide ids
    When an older client saves the deck with a slide inserted at the top and slide ids "slide-1" to "slide-4"
    Then there are 4 slides and the first one has a new id
    And the other slides kept their ids

  Scenario: New slides and boxes keep an id written in the Markdown when it is free
    When a slide with the id "summary" holding a copy of the shape box with its data-id is added at the end of the Markdown and applied
    Then the last slide has the id "summary" and its shape has the id "box"
    When the deck is written with slide ids and loaded into a new document as a new deck
    Then the new document has the same slide ids

  Scenario: A rewrite too big to align in full still keeps the slides that did not change
    Given a live document with 1200 one line slides
    When every other slide is rewritten and the last slide is moved to the top in the Markdown and applied
    Then the document holds that Markdown
    And every slide kept its id, the moved one too

  Scenario: Text someone is typing keeps its trailing space when Markdown changes elsewhere
    Given someone on the canvas typed "Nodes and edges " with a trailing space in the body box
    When the title is changed to "# Intro to Trees" in the Markdown and applied
    Then the body box reads "Nodes and edges " with the trailing space

  Scenario Outline: Content that could split a slide survives the Markdown round trip
    Given the second slide holds <content>
    When the deck is written as Markdown and applied back
    Then the deck reads back with the same slides and the same boxes
    And the boxes read back <reading>
    And the document did not change
    When the title is changed to "# Intro to Trees" in that Markdown and applied
    Then the second slide was not touched

    Examples:
      | content                                                  | reading                                       |
      | a text box with a line "---"                             | as they were                                  |
      | a text box with a line "</v-drag>"                       | as they were                                  |
      | speaker notes with "-->"                                 | as they were                                  |
      | speaker notes with "&lt;!--" and "--&gt;" typed as text  | as they were                                  |
      | a text box that reads like an image                      | as they were                                  |
      | a text box that reads like a code block                  | as they were                                  |
      | a text box that reads like a component                   | as they were                                  |
      | a text box with an HTML comment left open                | with the comment opening written as "&lt;!--" |
      | a text box with a code block left open                   | with the code block closed                    |
      | a text box with "</v-drag>" inside a line                | with that tag written as "&lt;/v-drag>"       |
      | a text box with "</v-drag>" as inline code               | as they were                                  |
      | a text box with a v-drag opening it never closes         | with that tag written as "&lt;v-drag"         |
      | a text box holding a v-drag box of its own               | as they were                                  |
      | a text box whose v-drag box closes on an indented line   | with that closing line not indented           |
      | a text box with a v-drag tag cut short by a closing tag  | with both tags written with "&lt;"            |
      | a text box with a v-drag tag cut short by a code block   | with the cut short tag written with "&lt;"    |
      | a code box with a line "</v-drag>"                       | as they were                                  |
      | a code box with "<!--" and speaker notes                 | as they were                                  |
      | a shape and a sandbox whose values hold "</v-drag>"      | as they were                                  |
      | a raw block that starts with "---"                       | as they were                                  |
      | a raw block that ends with an HTML comment               | as they were                                  |
      | a raw block that starts with a YAML code block           | as they were                                  |
      | a raw block with a v-drag closed on its own line         | as they were                                  |
      | a raw block with a v-drag closed at the end of a line    | as they were                                  |
      | an image whose alt text has a line "---"                 | as they were                                  |
      | a frontmatter value with "---"                           | as they were                                  |

  Scenario Outline: A v-drag that raw Markdown closes itself is kept as it was typed
    When <tag> is typed at the end of the last slide and applied
    Then the deck's Markdown holds it as it was typed
    And it is part of the last slide's raw Markdown

    Examples:
      | tag                                          |
      | a v-drag closed on its own line              |
      | a v-drag closed at the end of a line of text |
      | a self closing v-drag                        |

  Scenario: A leading empty slide survives the round trip
    Given a deck whose first slide is empty
    When it is written as Markdown without ids and read back
    Then it still has 2 slides and the first one is empty
    And applying that Markdown to its live document changes nothing

  Scenario: Each slide's Markdown is the text Slidev splits from the deck
    Given the demo deck, and a deck with empty slides first, in the middle and last
    Then each slide's Markdown joins into the deck's Markdown
    And each one equals the slide text Slidev reads from the deck's Markdown

  Scenario Outline: Half typed Markdown is refused softly and changes nothing
    When <change> in the Markdown
    And the Markdown is applied
    Then it fails as "<kind>" with "<message>"
    And the document did not change

    Examples:
      | change                                                         | kind    | message                                                     |
      | "<!--" is typed in the title                                   | typing  | Slide 1 has an HTML comment that is not closed              |
      | "<!--" is typed in the body box                                | typing  | Slide 2 has an HTML comment that is not closed              |
      | a code fence is opened at the end of the last slide            | typing  | Slide 3 has a code block that is not closed                 |
      | a code fence is opened in the body box                         | typing  | Slide 2 has a code block that is not closed                 |
      | a code fence is opened in the title above a fence in the notes | typing  | Slide 1 has a code block that is not closed                 |
      | a v-drag is opened above the body box                          | typing  | Slide 2 has a <v-drag> tag that is not closed               |
      | half a v-drag tag is typed above the body box                  | typing  | Slide 2 has a <v-drag> tag that is not closed               |
      | a v-drag tag is typed inside the body box                      | typing  | Slide 2 has a <v-drag> tag that is not closed               |
      | "---" is typed above a list item                               | typing  | The frontmatter of slide 3 is not a list of keys and values |
      | the first slide's YAML is broken                               | invalid | The frontmatter is not valid YAML. Slide 1:                 |
      | the first slide's YAML expands aliases too far                 | invalid | Deyslide cannot read this deck: Excessive alias count       |

  Scenario: Markdown waits until the document has a deck
    Given a live document that has not loaded its deck
    When the deck's Markdown is applied to it
    Then it fails with "The deck is not loaded yet" and the document is still empty
    When the deck's Markdown is applied to it as a new deck
    Then it holds the 3 slides with fresh slide ids
