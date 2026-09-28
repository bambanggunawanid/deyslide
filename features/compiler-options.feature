Feature: Vue template compiler options
  As a deck author
  I want TresJS and Motion Canvas tags to compile as native elements
  So that Vite shows no "failed to resolve component" warnings

  Scenario Outline: Classify a template tag
    Given the Deyslide Vue compiler options
    When Vue meets the tag "<tag>"
    Then it is treated as a custom element: <custom>

    Examples:
      | tag                   | custom |
      | TresMesh              | true   |
      | TresPerspectiveCamera | true   |
      | primitive             | true   |
      | motion-canvas-player  | true   |
      | TresCanvas            | false  |
      | DeyslideScene3D       | false  |
      | div                   | false  |
