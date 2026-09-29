Feature: Sharing projects and decks
  As a person with projects in my account
  I want to share a project or a single deck as an editor or a viewer
  So that we can work on talks together

  Background:
    Given the Deyslide API with email sending
    And Ana owns the project "Algorithms 101" with the decks "Sorting" and "Graphs"
    And Budi has an account

  Scenario: Share a project with a viewer
    When Ana shares the project with "budi@example.com" as a viewer
    Then Budi gets an email "Ana shared Algorithms 101 with you"
    And Budi sees "Algorithms 101" shared by Ana as a viewer
    And Budi can download the deck "Sorting"
    But Budi cannot rename the project, add a deck or rename a deck

  Scenario: An editor adds and renames but does not delete
    When Ana shares the project with "budi@example.com" as an editor
    Then Budi can add the deck "Trees" and rename the project to "Algorithms 102"
    But Budi cannot delete the project or the deck "Sorting"

  Scenario: Share a single deck
    When Ana shares the deck "Sorting" with "budi@example.com" as a viewer
    Then Budi sees the deck "Sorting" from "Algorithms 101" shared with him
    And Budi can download the deck "Sorting"
    But Budi cannot open the project or the deck "Graphs"

  Scenario: A deck uses the higher of its own role and its project's role
    Given Ana shared the project with "budi@example.com" as a viewer
    When Ana shares the deck "Sorting" with "budi@example.com" as an editor
    Then Budi can rename the deck "Sorting"
    But Budi cannot rename the deck "Graphs"

  Scenario: Invite someone without an account
    When Ana shares the project with "citra@example.com" as an editor
    Then Citra gets an email "Ana invited you to Algorithms 101 on Deyslide"
    And the project lists "citra@example.com" as an invited editor
    When Citra signs up with "citra@example.com" and confirms her email
    Then Citra sees "Algorithms 101" shared by Ana as an editor
    And the project lists "citra@example.com" as an editor

  Scenario: Editors invite, but only the owner changes roles and removes people
    Given Ana shared the project with "budi@example.com" as an editor
    When Budi shares the project with "citra@example.com" as a viewer
    Then the project lists "citra@example.com" as an invited viewer
    But Budi cannot make "citra@example.com" an editor or remove her
    And Ana can make "citra@example.com" an editor

  Scenario: The owner removes someone
    Given Ana shared the project with "budi@example.com" as an editor
    When Ana removes "budi@example.com" from the project
    Then Budi has no shared projects
    And Budi cannot download the deck "Sorting"

  Scenario: Leave a shared project
    Given Ana shared the project with "budi@example.com" as a viewer
    When Budi leaves the project
    Then Budi has no shared projects

  Scenario Outline: Sharing is checked
    When Ana shares the project with "<email>" as <role>
    Then sharing is refused with "<message>"

    Examples:
      | email            | role      | message                                |
      | not-an-email     | a viewer  | Enter a valid email address            |
      | ana@example.com  | a viewer  | You already own this                   |
      | budi@example.com | an owner  | Choose editor or viewer                |
