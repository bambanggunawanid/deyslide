Feature: Focus on a part of the architecture
  As a teacher explaining a system
  I want to name a component and have the camera look at it
  So that I do not have to type coordinates on stage

  Scenario: Focus on a known node
    Given the placeholder architecture
    When I focus on "database"
    Then the camera target is the middle of the database block

  Scenario: Unknown focus falls back to the explicit target
    Given the placeholder architecture
    When I focus on "billing" with a fallback target of 1, 1, 1
    Then the camera target is 1, 1, 1

  Scenario: No focus and no target looks at the origin
    Given the placeholder architecture
    When I do not focus on anything
    Then the camera target is 0, 0, 0

  Scenario: Every link connects two existing nodes
    Given the placeholder architecture
    Then every link has two endpoints
