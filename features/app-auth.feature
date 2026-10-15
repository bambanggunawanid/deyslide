Feature: Signing in to the Deyslide apps
  As a person who uses the Deyslide app on a computer or a phone
  I want to sign in through the browser once
  So that the app opens the decks in my account like the website does

  Background:
    Given the Deyslide API
    And Ana is signed in on a browser with the project "Talks"

  Scenario: The desktop app signs in and reads the account
    Given the desktop app registered itself for the API
    When the desktop app asks Ana to sign in from port 49152 and they approve it
    Then the consent page Ana saw named the API as the resource
    And the desktop app gets an access token for the API and a refresh token
    And with that token it lists Ana's project "Talks"
    And it reads Ana's name and email from /api/me
    But Better Auth's own session endpoint does not accept the token

  Scenario: The Android app signs in through its own scheme
    Given the Android app registered itself for the API
    When the Android app asks Ana to sign in and they approve it
    Then the browser hands the code to "id.bambanggunawan.deyslide:/oauth/callback"
    And the Android app trades the code for an access token for the API
    And with that token it lists Ana's project "Talks"

  Scenario: A token for one endpoint does not open the other
    Given the desktop app signed in as Ana
    And Claude Code signed in as Ana for the MCP endpoint
    Then the MCP token is refused by the API
    And the API token is refused by the MCP endpoint

  Scenario: Expired and forged tokens are refused
    Given the desktop app signed in as Ana
    And with that token it lists Ana's project "Talks"
    And Budi has an account too
    When the token is changed to name Budi
    Then the API refuses the changed token with 401
    When the token is sent without a signature
    Then the API refuses the unsigned token with 401
    When an hour and a minute pass
    Then the API refuses the real token with 401

  Scenario Outline: An app that names no resource is asked for the whole account
    Given the desktop app registered itself for the API
    When the desktop app sends Ana's browser to sign in by <method> without naming a resource, and they approve it
    Then the consent page Ana saw named the API as the resource
    And the desktop app gets an access token for the API and a refresh token

    Examples:
      | method |
      | GET    |
      | POST   |

  Scenario: Approving the MCP endpoint does not open the API
    Given the desktop app registered itself for the API
    When the desktop app asks Ana to sign in for the MCP endpoint and they approve it
    Then the consent page Ana saw named the MCP endpoint as the resource
    And the code cannot be traded for a token for the API
    And a refresh token from that approval cannot be traded for a token for the API
    When the desktop app asks Ana again without naming a resource
    Then the consent page shows again, naming the API as the resource

  Scenario: A client that did not ask for the API at registration cannot get it later
    Given an app registered itself without naming any resource
    When it asks Ana for a token for the API
    Then the browser is sent back to the app with the error "invalid_target"

  Scenario Outline: Only the Deyslide apps may register for the API
    When an app registers for the API as a <type> client answered at "<redirect>"
    Then the registration is refused with "invalid_client_metadata"

    Examples:
      | type   | redirect                          |
      | web    | https://evil.example/callback     |
      | native | https://evil.example/callback     |
      | native | http://localhost:49152/callback   |
      | native | http://127.0.0.1:49152/other      |
      | native | com.example.notes:/oauth/callback |

  Scenario: An app that leaves out its type is taken as native
    When an app registers for the API answered at "http://127.0.0.1/callback" without naming its type
    Then the registration is accepted for the MCP endpoint and the API

  Scenario: An app cannot move its answer elsewhere after registering
    Given Ana registered the desktop app for the API while signed in
    When Ana changes the app's answer address to "https://evil.example/callback"
    Then the change is refused with "invalid_client_metadata"

  Scenario: The app stays signed in with its refresh token
    Given the desktop app signed in as Ana
    When the app trades its refresh token for new tokens
    Then the new access token lists Ana's project "Talks"
    And the new refresh token works in turn

  Scenario: Two refreshes a moment apart keep the app signed in
    Given the desktop app signed in as Ana
    When two parts of the app trade the same refresh token a moment apart
    Then both get the same new tokens
    And the new refresh token still works

  Scenario: A refresh token sent again much later is refused
    Given the desktop app signed in as Ana
    And the app traded its refresh token for new tokens
    When the old refresh token is sent again a minute later
    Then the refresh is refused with "invalid_grant"
