Feature: The slide renderer's host page
  As the slide renderer drawing slides for Claude Code and for exports
  I want its host page to pair each reply from the preview frame with the render it belongs to
  So that a late reply never stands in for the slide being drawn

  Scenario: A reply meant for an earlier render is not taken for the current one
    Given the renderer's host page is open and its preview frame is ready
    When the page renders a slide
    And the frame replies with an error for an earlier render
    Then the render is still waiting
    When the frame replies "rendered" for that slide
    Then the render resolves with that reply

  Scenario: Slides are drawn as for an export unless a mode is named
    Given the renderer's host page is open and its preview frame is ready
    When the page renders a slide without a mode
    Then the frame is asked to draw it in print mode
    When the page renders a slide in present mode
    Then the frame is asked to draw it in present mode
