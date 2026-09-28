Feature: Camera motion depends on where the slide is rendered
  As a presenter
  I want the camera to fly only on the slide the audience sees
  So that preloaded slides, previews and PDF pages show the right pose

  Scenario Outline: Choose the motion mode
    Given the slide renders in the "<context>" context
    And print mode is <print>
    And the slide active state is <active>
    When the motion mode is resolved
    Then the mode is "<mode>"

    Examples:
      | context     | print | active | mode    |
      | slide       | false | true   | animate |
      | slide       | false | false  | hold    |
      | presenter   | false | true   | animate |
      | slide       | true  | true   | snap    |
      | overview    | false | false  | snap    |
      | previewNext | false | false  | snap    |
      | none        | false | true   | snap    |
