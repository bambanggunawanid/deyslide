Feature: Projects follow the account in the web app
  As a person who signs in
  I want my projects saved to my account, including the ones I made as a guest
  So that nothing I made is lost and everything opens on any device

  Scenario: A signed in person sees the projects in their account
    Given Ana's account holds the project "Algorithms 101"
    When Ana opens the web app signed in
    Then the home page lists "Algorithms 101"
    And there is no guest banner

  Scenario: Signing in moves browser projects into the account
    Given a guest made the project "Algorithms 101" with the demo deck "Sorting" in this browser
    When they sign in as Ana with a password
    Then the home page lists "Algorithms 101" with 1 deck
    And the home page says "Moved 1 project from this browser to your account."
    And Ana's account holds "Algorithms 101" with the deck "Sorting"
    And the browser no longer holds any project

  Scenario: A failed move keeps the browser projects
    Given a guest made the project "Algorithms 101" with the demo deck "Sorting" in this browser
    And the account cannot accept imports right now
    When they sign in as Ana with a password
    Then the home page says the projects could not be moved yet
    And the browser still holds "Algorithms 101"

  Scenario: New projects go to the account
    Given Ana is signed in on the web app
    When she creates the project "Graphs" and adds a deck from the demo template
    Then the editor shows slide 1 of 5
    And Ana's account holds "Graphs" with 1 deck
    And the browser no longer holds any project

  Scenario: Signing out shows the browser's projects again
    Given Ana's account holds the project "Algorithms 101"
    And Ana opens the web app signed in
    When she signs out
    Then the home page says there are no projects yet
    And the guest banner is back
