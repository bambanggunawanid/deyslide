Feature: Deck validation
  As the server and the editor
  I want every deck from storage or the network checked against one schema
  So that a broken or hostile deck never reaches the canvas

  Scenario: A complete deck is accepted
    Given a deck with every element type
    When it is validated
    Then it is accepted

  Scenario Outline: A broken deck is rejected
    Given a deck with every element type
    And <change>
    When it is validated
    Then it is rejected at "<path>"

    Examples:
      | change                                      | path                            |
      | the deck has no slides                      | slides                          |
      | the title has a negative width              | slides.0.elements.0.pos.w       |
      | the 3D scene has an unknown prop "color"    | slides.0.elements.1.props       |
      | the image has an empty src                  | slides.1.elements.0.src         |
      | the code block has no steps                 | slides.1.elements.2.steps       |
      | an element has the unknown type "video"     | slides.0.elements.0.type        |
      | a Magic Move step has a line starting with a fence | slides.1.elements.2.steps |
