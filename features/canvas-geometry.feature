Feature: Canvas geometry
  As a person laying out a slide on the canvas
  I want selecting, resizing, turning, snapping and zooming to follow clear rules
  So that elements land exactly where I put them

  Scenario: A point hits a turned box only inside it
    Given a box at 100, 100 of 200 by 100, turned 45 degrees
    Then the point 200, 150 hits the box
    And the point 290, 105 misses it, though it is inside the box before turning
    And where two boxes overlap, the point hits the one drawn last

  Scenario: Resizing from a corner keeps the opposite corner in place
    Given a box at 100, 100 of 200 by 100
    When the bottom right handle moves 50 right and 20 down
    Then the box is at 100, 100 and 250 by 120
    When the top left handle moves 50 right and 20 down instead
    Then the box is at 150, 120 and 150 by 80

  Scenario: Shift keeps the ratio
    Given a box at 100, 100 of 200 by 100
    When the bottom right handle moves 100 right with the ratio kept
    Then the box is at 100, 100 and 300 by 150
    When the right handle moves 100 right with the ratio kept instead
    Then the box is at 100, 75 and 300 by 150

  Scenario: Resizing a turned box keeps the opposite corner where it was on the slide
    Given a box at 100, 100 of 200 by 100, turned 90 degrees
    When the bottom right handle moves 30 left and 40 down on the slide
    Then the box is 240 by 130 and still turned 90 degrees
    And its top left corner is where it was on the slide

  Scenario: A resize never makes a box smaller than the smallest size
    Given a box at 100, 100 of 200 by 100
    When the bottom right handle moves 500 left and 500 up
    Then the box is at 100, 100 and 8 by 8

  Scenario: Turning follows the pointer, and Shift snaps to 15 degrees
    Given a box at 0, 0 of 100 by 100
    When the rotate handle turns from straight up to 40 degrees
    Then the box turns 40 degrees
    And with Shift held it turns 45 degrees
    And an angle of 200 degrees reads as -160 degrees

  Scenario: Moving snaps to the slide's center line and shows a guide
    Given an element from 100 to 300 across and 100 to 200 down
    When it moves so its center is 3 units right of the slide's center
    Then the move ends with its middle on the slide's center line
    And an upright guide shows at 490 from the top of the slide to the bottom

  Scenario: Moving snaps to another element's edge
    Given an element from 100 to 300 across and 100 to 200 down
    And another element from 500 to 600 across and 300 to 400 down
    When it moves so its left edge is 4 units right of the other element's right edge
    Then the move ends with its left edge on the other element's right edge
    And an upright guide shows at 600 spanning both elements

  Scenario: Nothing snaps further than 5 units away
    Given an element from 100 to 300 across and 100 to 200 down
    When it moves so its center is 6 units right of the slide's center, 3 below the top of the slide
    Then the move keeps its 6 units across and snaps its top to the top of the slide
    And the only guide lies flat at 0

  Scenario: An element always keeps part of itself on the slide
    Given an element from 100 to 300 across and 100 to 200 down
    When it moves 1000 units left and 1000 units down
    Then the move ends with 20 units of it still on the slide each way

  Scenario: Elements moved together each keep part of themselves on the slide
    Given an element from 100 to 300 across and 100 to 200 down
    And another element from 500 to 700 across and 300 to 400 down, moving with it
    When they move 600 units left
    Then the move stops at 280 left, leaving 20 units of the first on the slide
    And a copy offset 20 right and down from elements near the bottom right corner goes only as far as leaves 20 units of each on the slide

  Scenario: The rotate handle stays where the stage shows it
    Given a stage of 980 by 551.25 pixels showing the whole slide
    Then the rotate handle of a box at 100, 100 of 200 by 100 sits above it
    And for a box at the top of the slide it sits below it
    And for a box as tall as the slide it sits inside it, near its top
    And for a box at the top turned upside down it stays off the box's own top edge, which now faces down

  Scenario: The whole slide fits the stage, centered
    Given a stage of 1000 by 1000 pixels
    Then the fitted slide is 1000 pixels wide and centered from top to bottom

  Scenario: Two fingers zoom around the point between them, and pan
    Given a stage of 980 by 551.25 pixels showing the whole slide
    When two fingers 100 pixels apart around 490, 275 spread to 200 pixels apart
    Then the zoom is 200 percent
    And the canvas point 490, 275 is still between the fingers
    When both fingers then move 100 pixels to the right
    Then the slide moved 100 pixels to the right

  Scenario: Zoom stays within its limits and the slide stays in sight
    Given a stage of 980 by 551.25 pixels showing the whole slide
    Then zooming to 1000 percent stops at 400 percent
    And zooming to 1 percent stops at 10 percent
    And at 50 percent the slide cannot be pushed out of the stage
    And at 200 percent it cannot be pulled away from the stage's edges
