Feature: Deck assistant
  As a signed in person who has not learned Slidev Markdown
  I want to ask Claude to change my open deck
  So that I can build a talk by describing it

  Background:
    Given the Deyslide API with the assistant and a scripted Claude
    And Ana is signed in with the demo deck "Sorting" open

  Scenario: Claude adds a slide
    Given Claude will add the slide "# Recursion" at position 6 and then reply "Added a slide about recursion."
    When Ana asks "Add a slide about recursion"
    Then the stream shows the change "Added slide 6"
    And the deck in the stream has 6 slides and the last is titled "Recursion"
    And the stream ends with the reply "Added a slide about recursion."

  Scenario: Claude gets the open deck and nothing else
    When Ana asks "Make the title shorter"
    Then Claude was asked with the model "claude-opus-5-5" and server side fallbacks
    And Claude's only tools are "replace_slide, insert_slide, delete_slide, move_slide"
    And Claude received the 5 slides of the deck, numbered, and the message "Make the title shorter"

  Scenario: The chat so far goes along
    When Ana asks "Now make it blue" after the chat "Add a slide about recursion" and "Added a slide about recursion."
    Then Claude received the chat in order before the deck

  Scenario: A change that would break the deck goes back to Claude
    Given Claude will first send two slides as one, then send "# Fixed" for slide 2
    When Ana asks "Fix slide 2"
    Then Claude was told "That text makes 2 slides"
    And the stream shows only the change "Changed slide 2"

  Scenario: A refusal changes nothing
    Given Claude will refuse part way through a call to delete slide 1
    When Ana asks "Delete the first slide"
    Then the stream shows no change
    And the stream ends because Claude declined

  Scenario: Each month has an allowance
    Given the monthly allowance is 3 dollars and each of Claude's replies costs 2 dollars
    When Ana asks "First" and then "Second"
    Then the allowance shows 100 percent used, starting again on "2026-10-01"
    When Ana asks "Third"
    Then it is refused with 429 "You have used this month's assistant allowance. It starts again on October 1."
    And Claude received 2 requests
    When the calendar moves to October 1
    Then Ana can ask again

  Scenario: The allowance runs out part way through a reply
    Given the monthly allowance is 3 dollars and Claude's first turn costs 3 dollars while it deletes slide 5
    When Ana asks "Delete the last slide and tidy up"
    Then the stream shows the change "Deleted slide 5"
    And the stream ends because the allowance ran out
    And Claude received 1 request

  Scenario: A fallback model's tokens count at its own price
    Given Claude declined and a fallback finished, with 100000 input tokens on "claude-opus-5-5" and 100000 on "claude-opus-4-8"
    When Ana asks "Explain recursion on a slide"
    Then the allowance shows 30 percent used

  Scenario: Leaving part way still counts what Claude used
    Given Claude will delete slide 5 and cost 1 dollar, but is still thinking
    When Ana closes the page before Claude answers
    And Claude finishes that turn
    Then the allowance shows 33 percent used
    And Claude is not asked to continue that reply

  Scenario: One request at a time
    Given Claude is still thinking about Ana's first request
    When Ana sends a second request
    Then it is refused with 409 "The assistant is still working on your last message."

  Scenario: Other people's decks are out of reach
    Given Budi is signed in on another browser
    When Budi asks the assistant about Ana's deck
    Then it is refused with 404 "Not found"
    And Claude received 0 requests

  Scenario: A viewer of a shared deck cannot ask for changes
    Given Ana shared the deck with Budi as a viewer
    When Budi asks the assistant about Ana's deck
    Then it is refused with 403 "You can view this deck but not change it, so the assistant cannot work on it."
    And Claude received 0 requests

  Scenario: An editor of a shared deck can
    Given Ana shared the deck with Budi as an editor
    When Budi asks the assistant about Ana's deck
    Then the stream ends with the reply "Done."

  Scenario: Guests cannot use the assistant
    When a guest asks the assistant about Ana's deck
    Then it is refused with 401 "Sign in first"

  Scenario: Frontmatter Claude writes must be valid YAML
    Given Claude will first send slide 2 with an unclosed list in its frontmatter, then fix it
    When Ana asks "Center slide 2"
    Then Claude was told "The frontmatter is not valid YAML"
    And the stream shows only the change "Changed slide 2"

  Scenario: The assistant is off without a Claude API key
    Given the Deyslide API without an Anthropic API key
    Then the public settings say the assistant is off
