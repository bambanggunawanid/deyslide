Feature: Camera pose for deep zoom
  As a presenter recording a talk
  I want the 3D camera to glide between poses the same way every time
  So that live and recorded versions of a talk match

  Scenario: Zoom moves the camera toward the target
    Given a camera at 0, 0, 10 looking at the origin
    When the zoom level is 2
    Then the camera settles at 0, 0, 5
    And the camera still looks at the origin

  Scenario: Zoom below the minimum is clamped
    Given a camera at 0, 0, 10 looking at the origin
    When the zoom level is 0
    Then the camera distance equals 10 divided by the minimum zoom

  Scenario: Smoothing gives the same result at any frame rate
    Given a camera moving from 0 to 10 with smoothing 4
    When one second passes in 30 frames
    And the same second passes in 144 frames
    Then both runs end at the same position

  Scenario: Zero smoothing jumps straight to the goal
    Given a camera moving from 0 to 10 with smoothing 0
    When a single frame of 16 milliseconds passes
    Then the position is 10

  Scenario: Camera memory carries a pose across slides
    Given the scene "architecture" remembered a camera at 1, 2, 3
    When a new slide asks for the pose of "architecture"
    Then it receives a camera at 1, 2, 3
    And changing the received pose does not change the memory
