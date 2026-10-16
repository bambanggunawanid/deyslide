Feature: Slide capture
  As a person exporting a deck from their device, or an app drawing slides for Claude Code
  I want the preview to hand back a PNG of the slide it shows
  So that slides become images without a server

  Scenario: Capturing a slide returns a PNG
    Given the preview frame shows a slide titled "Hello"
    When the editor asks it for a capture at pixel ratio 2
    Then the frame answers with a PNG of the slide drawn at pixel ratio 2
    And the slide does not overflow

  Scenario: A capture without a pixel ratio draws at 1
    Given the preview frame shows a slide titled "Hello"
    When the editor asks it for a capture
    Then the frame answers with a PNG of the slide drawn at pixel ratio 1

  Scenario Outline: The picture is 1280 by 720 whatever size the frame is shown at
    Given the preview frame is shown <width> by <height> pixels with a slide titled "Hello"
    When the editor asks it for a capture at pixel ratio 2
    Then the slide alone is drawn unscaled, stretched to 1280 by 720 at pixel ratio 2

    Examples:
      | width | height |
      | 320   | 180    |
      | 1280  | 720    |
      | 480   | 480    |

  Scenario: Content past the slide's edges is reported
    Given the preview frame shows a box that reaches past the slide's right edge
    When the editor asks it for a capture
    Then the frame answers with a PNG
    And the slide overflows

  Scenario Outline: Overflow is measured in slide units whatever size the frame is shown at
    Given the preview frame is shown at <scale> times the slide's size
    And it shows a box that reaches <past> pixels of the slide past its right edge
    When the editor asks it for a capture
    Then the capture says the slide <outcome>

    Examples:
      | scale | past | outcome           |
      | 0.3   | 3    | overflows         |
      | 3     | 1    | does not overflow |

  Scenario: A capture waits for the slide asked for just before it
    Given the preview frame shows a slide titled "Hello"
    When the editor asks for a slide titled "Later" and a capture right after it
    Then the capture shows the slide titled "Later"

  Scenario: A capture waits for what a slide marks with data-waitfor
    Given the preview frame shows a slide with an element that waits for ".ready"
    When the editor asks it for a capture
    Then nothing is drawn while ".ready" is missing
    When ".ready" appears inside that element
    Then the frame answers with a PNG that shows it

  Scenario: A capture waits for a component whose code is still loading
    Given the preview frame shows a slide titled "Hello"
    And a component on the slide is still loading
    When the editor asks it for a capture
    Then nothing is drawn while the component loads
    When the component has loaded
    Then the frame answers with a PNG

  Scenario: A capture waits for the deck's font stylesheet
    Given the preview frame shows a slide of a deck whose font stylesheet is still on its way
    When the editor asks it for a capture
    Then nothing is drawn before the stylesheet arrives
    When the stylesheet arrives
    Then the frame answers with a PNG

  Scenario: A capture waits for animations on the slide to end
    Given the preview frame shows a slide titled "Hello"
    And a transition on the slide is still running
    When the editor asks it for a capture
    Then nothing is drawn before the transition ends
    When the transition ends
    Then the frame answers with a PNG

  Scenario: An animation that repeats forever does not hold up a capture
    Given the preview frame shows a slide titled "Hello"
    And an animation on the slide repeats forever
    When the editor asks it for a capture
    Then the frame answers with a PNG

  Scenario: Images that cannot load are left blank
    Given the preview frame shows a slide titled "Hello"
    When the editor asks it for a capture
    Then the drawing puts a blank picture in place of any image it cannot load, and carries on

  Scenario: A slide that does not compile gives no image
    Given the preview frame shows a slide titled "Hello"
    When the editor asks it to render a broken slide
    And the editor asks it for a capture
    Then the frame answers with the reason and no image

  Scenario: A drawing that fails is reported, not left waiting
    Given the preview frame shows a slide titled "Hello"
    And drawing fails with "The canvas is too large"
    When the editor asks it for a capture
    Then the frame answers with the error "The canvas is too large" and no image
