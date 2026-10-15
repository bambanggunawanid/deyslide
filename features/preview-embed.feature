Feature: Embedding the preview
  As the editor, the canvas, the presenter and the exporter
  I want one component that talks to the sandboxed preview frame for me
  So that each of them renders, drags and captures slides the same way

  Scenario: The frame gets the render once it is ready
    Given the preview component is mounted with a slide to render
    Then nothing is sent to the frame yet
    When the frame says it is ready
    Then the frame is asked to render that slide

  Scenario: A rendered answer is passed on with its id
    Given the preview component is mounted and its frame is ready
    When the frame answers "rendered" for "r1" with 2 clicks
    Then the component emits "rendered" with the id "r1" and 2 clicks

  Scenario: Messages from anywhere but the frame are ignored
    Given the preview component is mounted and its frame is ready
    When another window posts "rendered" for "r1" with 2 clicks
    Then the component emits nothing

  Scenario: An error about a render the component has replaced is not shown
    Given the preview component is mounted and its frame is ready, rendering "r2"
    When the frame reports an error for the earlier render "r1"
    Then the component emits no error
    When the frame reports an error for "r2"
    Then the component emits that error

  Scenario: Positions go to the frame, and again after each render
    Given the preview component is mounted and its frame is ready
    When the canvas gives the element "box" the position left 300 and top 120
    Then the frame is sent that position
    When the slide to render changes
    Then the frame is asked to render it and is sent the position again

  Scenario: A capture resolves with the frame's picture
    Given the preview component is mounted and its frame is ready
    When the exporter asks for a capture at pixel ratio 2
    Then the frame is asked for a capture at pixel ratio 2
    When the frame answers that capture with a PNG that does not overflow
    Then the capture resolves with that PNG and no overflow

  Scenario: A capture asked for before the frame is ready waits for it
    Given the preview component is mounted with a slide to render
    When the exporter asks for a capture
    Then nothing is sent to the frame yet
    When the frame says it is ready
    Then the frame is asked for a capture

  Scenario: A capture the frame never answers gives up
    Given the preview component is mounted and its frame is ready
    When the exporter asks for a capture
    And the frame stays silent for 20 seconds
    Then the capture resolves with the error "The slide took too long to capture."

  Scenario: Closing the preview ends a waiting capture
    Given the preview component is mounted and its frame is ready
    When the exporter asks for a capture
    And the preview component is closed
    Then the capture resolves with the error "The preview closed before the slide was captured."
