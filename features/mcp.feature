Feature: Deyslide MCP server
  As a person who uses Claude Code
  I want Claude Code to write and look at my decks through Deyslide's MCP server
  So that I can build talks with my own Claude plan, without an API key

  Background:
    Given the Deyslide API with a slide renderer
    And Ana is signed in on her browser with the demo deck "Sorting" in the project "Talks"

  Scenario: Claude Code signs in through the browser
    When Claude Code calls the MCP server without a token
    Then it is refused with 401 and pointed to the protected resource metadata
    And the metadata names Deyslide's sign in as the authorization server
    When Claude Code connects and Ana approves it in her browser
    Then Claude Code asked for a token for the MCP endpoint only
    And list_decks shows the deck "Sorting" with 5 slides and its editor link

  Scenario: Guests are sent to sign in first
    When Claude Code sends a guest's browser to authorize
    Then the browser lands on the sign in page with the request attached

  Scenario: Ana can say no
    When Claude Code connects and Ana denies it in her browser
    Then Claude Code gets no token and the MCP server still refuses it

  Scenario: Tools say what they change
    Given Claude Code is connected as Ana
    Then the tools are "get_guide, list_decks, create_project, create_deck, read_deck, write_deck, edit_slides, render_slides"
    And "get_guide, list_decks, read_deck, render_slides" are marked read only
    And the server's instructions explain the read, edit and render loop

  Scenario: Create a deck from Claude Code
    Given Claude Code is connected as Ana
    When Claude Code creates the project "Lectures" and in it the deck "Recursion" with 3 slides
    Then Ana's account lists "Recursion" in "Lectures" with 3 slides
    And the answer gives the deck's editor link

  Scenario: Read a deck with numbered slides
    Given Claude Code is connected as Ana
    When Claude Code reads the deck "Sorting"
    Then it gets 5 slides wrapped in numbered slide tags and the editor link

  Scenario: Edits land in one batch
    Given Claude Code is connected as Ana
    When Claude Code adds a slide "# Summary" at the end and moves it to position 2
    Then the deck has 6 slides and slide 2 is "# Summary"

  Scenario: A bad edit saves nothing
    Given Claude Code is connected as Ana
    When Claude Code sends two edits where the second breaks the frontmatter
    Then the answer says "Nothing was saved. Edit 2 (replace) failed: The frontmatter is not valid YAML"
    And the deck still has its 5 original slides

  Scenario: A whole deck that is not valid is refused
    Given Claude Code is connected as Ana
    When Claude Code writes a deck whose first frontmatter is broken
    Then the answer starts with "Nothing was saved. The frontmatter is not valid YAML."

  Scenario: See slides as images
    Given Claude Code is connected as Ana
    And the renderer reports that slide 3 overflows
    When Claude Code renders slides 1 and 3 of "Sorting"
    Then it gets two PNG images with each slide's click count
    And slide 3 is reported as overflowing
    And the renderer drew slide 3 with the deck's headmatter at its last click

  Scenario: No renderer, no images
    Given the Deyslide API without a slide renderer
    And Ana is signed in on her browser with the demo deck "Sorting" in the project "Talks"
    And Claude Code is connected as Ana
    When Claude Code renders slides 1 and 3 of "Sorting"
    Then the answer says slide images are not available

  Scenario: Other accounts stay out of reach
    Given Budi connects Claude Code to his own account
    When Budi's Claude Code reads Ana's deck "Sorting"
    Then it is told "There is no deck with that id in this account. Call list_decks to see the decks."
    And Budi's list_decks is empty

  Scenario: A token from somewhere else is refused
    When Claude Code calls the MCP server with a made up token
    Then it is refused with 401 and told the token is invalid
