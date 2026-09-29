Feature: Sharing in the web app
  As a signed in person
  I want to share projects and decks, and open what others share with me
  So that we can work on talks together

  Scenario: Shared projects appear on the home page
    Given Ana is signed in and Budi shared the project "Algorithms 101" with Ana as a viewer
    When Ana opens the home page
    Then "Shared with you" lists "Algorithms 101" by Budi as view only

  Scenario: A viewer only opens decks
    Given Ana is signed in and Budi shared the project "Algorithms 101" with Ana as a viewer
    When Ana opens the project "Algorithms 101"
    Then the page says it is shared by Budi and Ana is a viewer
    And there is no Rename, Delete or New deck button
    And the deck "Sorting" is marked "View only"

  Scenario: An editor adds and renames but does not delete
    Given Ana is signed in and Budi shared the project "Algorithms 101" with Ana as an editor
    When Ana opens the project "Algorithms 101"
    Then there are Rename and New deck buttons but no Delete button

  Scenario: A viewer reads a deck without changing it
    Given Ana is signed in and Budi shared the project "Algorithms 101" with Ana as a viewer
    When Ana opens the deck "Sorting"
    Then the deck page says "View only"
    And the editor is read only
    And there is no assistant and no Share button

  Scenario: Share a project from its page
    Given Ana is signed in with the project "Talks"
    And Budi has an account
    When Ana shares the project with "budi@example.com" as an editor and with "citra@example.com" as a viewer
    Then the share list shows Budi as an editor and "citra@example.com" as an invited viewer

  Scenario: The owner changes a role and removes someone
    Given Ana is signed in with the project "Talks" shared with Budi as a viewer
    When Ana makes Budi an editor
    Then the share list shows Budi as an editor
    When Ana removes Budi
    Then the share list shows only Ana

  Scenario: Leave a shared project
    Given Ana is signed in and Budi shared the project "Algorithms 101" with Ana as a viewer
    When Ana leaves the project from its share list
    Then Ana is back on the home page and nothing is shared with Ana

  Scenario: A refused share says why
    Given Ana is signed in with the project "Talks" shared with Budi as a viewer
    When Ana shares the project with "budi@example.com" as an editor
    Then the share dialog says "budi@example.com already has access. Change the role in the list instead."

  Scenario: Guests have nothing to share
    Given a guest with the project "Talks" in the browser
    When the guest opens the project "Talks"
    Then there is no Share button
