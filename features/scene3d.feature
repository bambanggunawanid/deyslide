Feature: 3D scene viewport
  As a presenter
  I want one component that frames the architecture for recordings and live Q&A
  So that the same slide works for a video and for an interactive class

  Scenario: Camera is locked by default for linear recordings
    Given the 3D viewport is mounted with default props
    Then orbit controls are not mounted
    And the camera rig is locked

  Scenario: Orbit controls turn on for live Q&A
    Given the 3D viewport is mounted with orbit controls on and focus "cache"
    Then orbit controls are mounted
    And orbit controls circle around the cache
    And the camera rig is unlocked
    And a hint tells the audience they can drag

  Scenario: Zoom moves the camera toward the focused service
    Given the 3D viewport is mounted with camera 10, 0, 0 focus "orders" and zoom 1
    When the zoom level changes to 2
    Then the camera rig aims at the orders service
    And the camera rig target position is halfway to the orders service

  Scenario: A hidden slide waits for space before creating a canvas
    Given the 3D viewport is mounted on a hidden slide
    Then no WebGL canvas is created
    When the slide becomes visible
    Then the WebGL canvas is created

  Scenario: A GLTF model replaces the placeholder architecture
    Given the 3D viewport is mounted with model "/models/system.glb"
    Then the GLTF model loads "/models/system.glb"
    And the placeholder architecture is not rendered

  Scenario: PDF export captures a still frame
    Given the 3D viewport is mounted in print mode
    Then the exporter is told to wait for a rendered frame
    When the canvas renders two frames
    Then a still image of the canvas replaces the live canvas
    And the page is marked ready for export

  Scenario Outline: Camera motion follows the slide state
    Given the slide is active: <active>, in print mode: <print>
    When the 3D viewport is mounted with default props
    Then the camera rig mode is "<mode>"

    Examples:
      | active | print | mode    |
      | true   | false | animate |
      | false  | false | hold    |
      | true   | true  | snap    |
