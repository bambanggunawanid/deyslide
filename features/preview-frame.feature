Feature: Preview frame
  As a person editing, presenting or exporting a deck
  I want the sandboxed preview to answer the editor quickly and exactly
  So that animations play, drags feel direct and exports show the right slide

  Scenario: Replies carry the id of their render
    Given the preview frame is open
    When the editor asks it to render a list revealed by clicks with the id "first"
    Then the frame answers "rendered" for "first" with 3 clicks

  Scenario: A slide that does not compile is reported with its id
    Given the preview frame is open
    When the editor asks it to render a broken slide with the id "broken"
    Then the frame answers "error" for "broken" with the reason

  Scenario: A render that a newer one overtakes still gets a reply
    Given the preview frame is open
    When the editor asks for a slide with the id "older" and at once for another with the id "newer"
    Then the frame tells "older" that a newer render replaced it
    And the frame answers "rendered" for "newer", whose slide is the one on screen

  Scenario: Stepping through clicks keeps the slide mounted
    Given the preview frame shows a Magic Move at click 0
    When the editor asks for click 1 of the same slide
    Then the slide on screen is the same one, not mounted again
    And the Magic Move shows its second step

  Scenario: A click past the last one stops at the last one
    Given the preview frame shows a Magic Move at click 0
    When the editor asks for click 5 of the same slide
    Then the Magic Move shows its second step

  Scenario: Print mode mounts the slide afresh at every click
    Given the preview frame shows a Magic Move at click 0 in print mode
    When the editor asks for click 1 of the same slide in print mode
    Then the slide is mounted afresh
    And the Magic Move shows its second step

  Scenario: An error a slide throws stays reported while stepping through clicks
    Given the preview frame shows a slide with clicks whose expression throws
    Then the frame reports what the slide threw
    When the editor asks for click 1 of the same slide
    Then the frame answers "rendered" and reports what the slide threw again

  Scenario: An error a slide throws at one click clears when stepping back
    Given the preview frame shows a slide whose expression throws only after the first click
    When the editor asks for click 1 of the same slide
    Then the frame reports what the slide threw at that click
    When the editor asks for click 0 of the same slide
    Then the frame answers "rendered" with no error, and the slide shows no error

  Scenario: Changing the slide mounts it again
    Given the preview frame shows a Magic Move at click 0
    When the editor asks for a slide with other content
    Then a new slide replaces the old one

  Scenario: Positions move an element until the next render
    Given the preview frame shows the box "box" at left 100 and top 50
    When the editor sends the position left 300 and top 120 for "box"
    Then the box is placed at left 300 and top 120 on the same slide
    When the editor asks for the same slide again
    Then the box is placed at left 100 and top 50 on the same slide

  Scenario: Positions that cannot be shown are ignored
    Given the preview frame shows the box "box" at left 100 and top 50
    When the editor sends a position for "box" whose width is negative
    Then the box is placed at left 100 and top 50 on the same slide

  Scenario: Ids that name built-in properties are ordinary ids
    Given the preview frame shows boxes whose ids are "constructor" and "__proto__"
    Then both boxes are placed where the slide puts them
    When the editor sends the position left 300 and top 120 for "__proto__"
    Then the box "__proto__" moves there and the box "constructor" stays

  Scenario: Print mode tells components the slide is being exported
    Given the preview frame is open
    When the editor asks it to render a slide in print mode
    Then the preview's own Slidev stub reports print mode
    When the editor asks it to render the slide for editing
    Then the preview's own Slidev stub no longer reports print mode

  Scenario: Slides read their frontmatter and clicks the way Slidev slides do
    Given the preview frame is open
    When the editor asks it to render a slide titled "Graphs" that shows $frontmatter and $slidev, at click 1
    Then the slide shows the title "Graphs" and the click 1
    And the preview's own Slidev stub gives components the frontmatter and the click

  Scenario: Media links the frame cannot load are swapped
    Given the preview frame is open
    When the editor asks it to render an image from "/api/media/m1/file" with a signed link for it
    Then the image loads the signed link

  Scenario: Deck fonts load without holding up the slide
    Given the preview frame is open, with font stylesheets slow to arrive
    When the editor asks it to render a deck whose fonts are "Inter" and "JetBrains Mono"
    Then the frame answers while the font stylesheet is still loading
    And the page asks Google Fonts for Inter and JetBrains Mono
    And the slide uses Inter with Slidev's fallbacks, and JetBrains Mono for code

  Scenario: A font stylesheet that fails is not asked for again
    Given the preview frame is open, with font stylesheets failing to load
    When the editor asks it to render a deck whose fonts are "Missing Sans"
    Then the stylesheet is removed once it fails
    When the editor asks for another slide of the same deck
    Then the page does not ask Google Fonts for it again
