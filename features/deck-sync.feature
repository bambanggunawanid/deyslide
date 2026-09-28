Feature: Live deck document
  As two people editing the same deck
  I want our changes to merge instead of overwriting each other
  So that live co-editing never loses work

  Scenario: A deck survives a round trip through the live document
    Given a deck with every element type
    When it is loaded into a live document and read back
    Then the result equals the original deck

  Scenario: One person moves a text box while another edits its text
    Given Ana and Budi each have a live document loaded from the same deck
    When Ana moves the title to x 300 y 200
    And Budi appends " and Trees" to the title text at the same time
    And their documents sync
    Then both documents have the title at x 300 y 200
    And both documents have the title text "# Intro to Graphs and Trees"

  Scenario: Two people move the same box on different axes
    Given Ana and Budi each have a live document loaded from the same deck
    When Ana changes the title width to 700
    And Budi rotates the title by 10 degrees at the same time
    And their documents sync
    Then both documents have the title with width 700 and rotation 10

  Scenario: Both people type in the same text box
    Given Ana and Budi each have a live document loaded from the same deck
    When Ana types "Hello " at the start of the speaker notes on slide 1
    And Budi types " Thanks!" at the end of the same notes at the same time
    And their documents sync
    Then both documents have the notes "Hello Welcome everyone. Thanks!"

  Scenario: The live document converts to the same Markdown as the deck
    Given a deck with every element type
    When it is loaded into a live document and written as Markdown
    Then the Markdown equals the Markdown written straight from the deck
