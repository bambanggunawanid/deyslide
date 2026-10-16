Feature: Approving the Deyslide apps in the browser
  As a person signing in to the Deyslide app
  I want the consent page to say plainly what the app gets
  So that I know an app asking for my whole account is a big step

  Scenario: The consent page says the app gets the whole account
    Given I am signed in
    And the app "Deyslide app" asks for the API with the answer going to "http://127.0.0.1:49152/callback"
    Then the consent page names "Deyslide app" and my email
    And it lists only "Full access to your Deyslide account, including deleting projects and decks and sharing them"
    And it does not claim the app cannot delete projects or decks
    And it says the answer goes to "127.0.0.1:49152"

  Scenario: The phone app's own scheme is named in place of a host
    Given I am signed in
    And the app "Deyslide app" asks for the API with the answer going to "id.bambanggunawan.deyslide:/oauth/callback"
    Then it says the answer goes to "the Deyslide app on this device"
    When I press "Allow"
    Then the browser goes to "id.bambanggunawan.deyslide:/oauth/callback?code=fake-code"

  Scenario: Claude Code still sees the shorter list
    Given I am signed in
    And the app "Claude Code" asks for the MCP endpoint with the answer going to "http://localhost:33418/callback"
    Then it lists "See your projects and decks, and those shared with you", "Create projects and decks" and "Change the slides in decks you can edit"
    And it says the app cannot delete projects or decks
