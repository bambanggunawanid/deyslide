Feature: Connecting Claude Code from the web app
  As a person connecting Claude Code to Deyslide
  I want to sign in and approve it in the browser
  So that Claude Code can work on my decks without a password or key

  Scenario: Signing in carries on with the app's request
    Given an app sent me to sign in with its request
    When I sign in with my email and password
    Then the browser goes back to the authorization endpoint with the request and without its signature

  Scenario: Social sign in carries the request too
    Given an app sent me to sign in with its request
    When I choose "Continue with Google"
    Then Google sign in is asked to lead back to the authorization endpoint

  Scenario: Someone already signed in is passed on at once
    Given I am signed in
    When an app sends me to sign in with its request
    Then the browser goes back to the authorization endpoint with the request and without its signature

  Scenario: The consent page says who is asking and what it may do
    Given I am signed in
    And the app "Claude Code" asks to connect from localhost:33418
    Then the consent page names "Claude Code" and my email
    And it lists what the app may do and that the answer goes to "localhost:33418"

  Scenario: Allowing sends the browser back to the app
    Given I am signed in
    And the app "Claude Code" asks to connect from localhost:33418
    When I press "Allow"
    Then the browser goes to "http://localhost:33418/callback?code=fake-code"

  Scenario: Denying tells the app no
    Given I am signed in
    And the app "Claude Code" asks to connect from localhost:33418
    When I press "Deny"
    Then the browser goes to "http://localhost:33418/callback?error=access_denied"

  Scenario: The consent page without a request
    Given I am signed in
    When I open the consent page directly
    Then it says to start again from the app

  Scenario: An open deck picks up changes made from Claude Code
    Given I am signed in with the blank deck "Graphs" open
    When Claude Code saves a second slide to that deck
    And I come back to the tab
    Then the editor holds the second slide

  Scenario: Unsaved typing is never replaced
    Given I am signed in with the blank deck "Graphs" open
    And I typed a change that is not saved yet
    When Claude Code saves a second slide to that deck
    And I come back to the tab
    Then the editor still holds my change
