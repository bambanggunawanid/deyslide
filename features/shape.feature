Feature: Shape component
  As a deck author
  I want rectangles and ellipses that fill their box
  So that shape elements from the canvas render the same in every deck

  Scenario Outline: Draw a shape
    Given a <shape> shape filled with "<fill>" and a <width> pixel "<stroke>" border
    When it is rendered
    Then its background is "<fill>"
    And its corner radius is "<radius>"
    And its border is "<border>"

    Examples:
      | shape   | fill    | width | stroke  | radius | border            |
      | rect    | #38bdf8 | 0     | #000000 | 0px    | none              |
      | ellipse | #f472b6 | 2     | #ffffff | 50%    | 2px solid #ffffff |
