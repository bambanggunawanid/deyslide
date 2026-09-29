Feature: Slide preview
  As a person writing a deck in Markdown
  I want each slide rendered the way Slidev renders it
  So that the preview shows what the audience will see

  Scenario: Markdown becomes a slide
    When the preview renders the "heading and bold text" sample
    Then the slide has a heading "Hello"
    And the slide shows "bold" in bold

  Scenario: The first slide is a cover, others use the default layout
    When the preview renders "Title" as the first slide
    Then the slide uses the "cover" layout
    When the preview renders "Details" as the second slide
    Then the slide uses the "default" layout

  Scenario: Two columns
    When the preview renders the "two columns" sample with the layout "two-cols"
    Then the left column shows "Left"
    And the right column shows "Right"

  Scenario: Clicks reveal list items one at a time
    When the preview renders the "a list revealed by clicks" sample
    Then the slide has 3 clicks
    When the preview is at click 2
    Then "One" and "Two" are visible and "Three" is hidden

  Scenario: The click count drives expressions
    When the preview renders the "an expression using the click count" sample
    And the preview is at click 1
    Then the slide shows "b"

  Scenario: Code is highlighted and never run as a template
    When the preview renders the "code containing braces" sample
    Then the slide shows highlighted code reading "const a = {{ b }}"

  Scenario: A Magic Move steps through its code
    When the preview renders the "a two step Magic Move" sample
    Then the slide has 1 click
    And the code shows "let a = 1"

  Scenario: Deyslide components render
    When the preview renders the "an ellipse shape" sample
    Then the slide has an ellipse shape

  Scenario: Positioned elements use Slidev canvas units
    When the preview renders the "a positioned box" sample
    Then "Box" is placed at left 100, top 50, width 200 and height 80

  Scenario: A broken template is reported
    When the preview renders the "an empty v-if" sample
    Then the preview reports an error

  Scenario: A component whose tag spans several lines
    When the preview renders the "a component with attributes on several lines" sample
    Then the slide has an ellipse shape

  Scenario: Every slide of the demo deck renders
    When the preview renders each slide of the demo deck
    Then none of them reports an error
    And their clicks are 0, 2, 3, 0 and 0
