Feature: Reading and repairing the live deck
  As the views of a deck and the server that stores it
  I want a reader that never fails on a loaded deck, and a repair for what edits merged into
  So that one broken element or a clash between two people never blocks the whole deck

  Background:
    Given Ana and Budi each have a live document loaded from the same three slide deck

  Scenario: Deleting both slides of a two slide deck at once leaves a deck that reads as one empty slide
    Given the deck has only the slides "a" and "b"
    When Ana deletes "a" and Budi deletes "b" at the same time
    And their documents sync
    Then both documents read as one empty slide
    And the check says the deck has too few slides

  Scenario: Repair adds one slide after both slides were deleted
    Given the deck has only the slides "a" and "b"
    And Ana deletes "a" and Budi deletes "b" at the same time
    And their documents sync
    When the server repairs Ana's document with the origin "server"
    Then the repair says it changed the deck, in one change with the origin "server"
    And after syncing both documents have one empty slide with a new id
    And the check passes

  Scenario: Repair removes the extra copy left when two people move the same slide
    When Ana moves "a" to the end and Budi moves "a" to the middle at the same time
    And their documents sync
    Then the slide "a" appears twice
    And the check says two slides have the same id
    When the server repairs Ana's document
    Then the slide "a" appears once and the check passes

  Scenario: Repair gives a fresh id to a different slide with the same id
    Given Ana's document has a second, different slide with the id "b"
    When the server repairs Ana's document
    Then the first "b" keeps its id and the other one has a new id with the same content

  Scenario: Repair removes the extra copy left when two people restack the same box
    When Ana moves the box "x" to the top of the stack and Budi moves it to the bottom at the same time
    And their documents sync
    Then the box "x" appears twice on slide "a"
    When the server repairs Ana's document
    Then the box "x" appears once on slide "a" and the check passes

  Scenario: A box with a negative width is clamped
    Given an older client set the width of the box "x" to -40
    Then reading the deck leaves the box "x" out and the check fails at its width
    When the server repairs Ana's document
    Then the box "x" has a width of 0 and is read again
    And the check passes

  Scenario: A box that cannot be fixed is removed
    Given Ana's document has a box "clip" of the unknown type "video" on slide "b"
    Then reading the deck leaves the box "clip" out
    When the server repairs Ana's document
    Then the slide "b" no longer holds the box "clip" and the check passes

  Scenario: A text box stored without a shared text gets one back
    Given the text of the box "x" was stored as plain text
    Then the check says the box "x" is not stored the right way
    When the server repairs Ana's document
    Then the box "x" has a shared text with the same words and the check passes

  Scenario: Frontmatter a peer stored with a value YAML cannot write is cleaned up
    Given Budi stored the frontmatter of slide "b" as layout "center" and a count held as a BigInt
    And their documents sync
    Then reading Ana's document shows slide "b" with layout "center" only, and its Markdown can be written
    And the check fails at the frontmatter of slide "b"
    When the server repairs Ana's document
    Then slide "b" has the frontmatter layout "center" and the check passes

  Scenario: A slides list that a peer replaced with something else is rebuilt
    Given Budi replaced the list of slides with a plain text
    And their documents sync
    Then reading Ana's document shows one empty slide
    And the check says "The deck has no list of slides"
    When the server repairs Ana's document
    Then Ana's document has one empty slide with a new id and the check passes

  Scenario: A healthy deck needs no repair
    When the server repairs Ana's document
    Then the repair says it changed nothing and the document did not change
    And the check passes

  Scenario: A document without a deck cannot be read or repaired
    Given a live document that has not loaded its deck
    Then reading it fails with "The deck is not loaded yet"
    And the check says "The deck is not loaded yet"
    And repairing it fails with "The deck is not loaded yet"
